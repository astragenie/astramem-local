/**
 * ADR-018 — ONNX embedder decision-maker benchmark.
 *
 * Builds on SLICE-5's `ONNX_MODEL_REGISTRY` (mxbai-embed-large-v1 + bge-m3,
 * both CLS pooling by default, `src/providers/embed/onnx.ts`) and the SLICE-3
 * parity methodology (`scripts/eval/onnx-parity.mts`, `feat/onnx-embed-provider-s3-parity`
 * branch — cosine parity vs the live Ollama baseline over real distilled
 * text). This script is the single artifact that answers "which
 * model/pooling/dtype should astramemory-local actually ship for the
 * ONNX/CPU-offload embed provider" — it measures, it does not guess.
 *
 * Model matrix (fixed, do not add/remove rows without updating
 * docs/research/20260715-onnx-embedder-benchmark-results.md):
 *
 *   id                    | provider | model              | pooling | dtype
 *   ollama-mxbai (BASELINE)| ollama  | mxbai-embed-large  | native  | —
 *   onnx-mxbai-cls-q8      | onnx    | mxbai-embed-large-v1| cls    | q8
 *   onnx-mxbai-mean-q8     | onnx    | mxbai-embed-large-v1| mean   | q8
 *   onnx-mxbai-cls-fp32    | onnx    | mxbai-embed-large-v1| cls    | fp32
 *   onnx-bge-m3-cls-q8     | onnx    | bge-m3             | cls    | q8
 *
 * Metrics per eligible row (see ROWS below for exact eligibility):
 *   1. Parity cosine vs ollama-mxbai (only the 3 onnx-mxbai rows — bge-m3 is
 *      a different embedding space, parity has no meaning there). N>=200
 *      real distilled texts, same corpus-resolution priority as
 *      onnx-parity.mts (LoCoMo k-sweep store -> prod db -> bundled fixture).
 *   2. Latency: single-embed (5 reps, first discarded as warmup) + one
 *      batch-of-32 call, CPU. NOTE (measured, not assumed): neither
 *      OnnxEmbedProvider.embed() nor OllamaEmbedProvider.embed() batches
 *      internally — both loop one-text-at-a-time regardless of how many
 *      texts the caller passes — so "batch-of-32" here measures 32
 *      sequential single-text calls under one wall-clock timer, not a true
 *      batched forward pass. Reported as observed, not exaggerated.
 *   3. English retrieval: ADR-005 fixture (contracts/fixtures/eval/{corpus,queries}.json),
 *      atoms-as-docs / queries-as-queries, scored with pure cosine top-k
 *      ranking (recallAtK/ndcgAtK from src/eval/metrics.ts — the same metric
 *      functions tests/eval/retrieval-eval.test.ts gates CI on), for
 *      ollama-mxbai, onnx-mxbai-cls-q8, onnx-bge-m3-cls-q8. DEVIATION FROM
 *      PLAN, measured not assumed: the original design called for
 *      `runRetrievalEval` (the real FTS+vector hybrid engine, via
 *      `openDb(':memory:')`) — that path throws under `bun` on this Windows
 *      box (`'better-sqlite3' is not yet supported in Bun`, confirmed live;
 *      `src/storage/db.ts` unconditionally imports
 *      `better-sqlite3-multiple-ciphers`, matching CLAUDE.md's documented
 *      footgun even though a sibling script's header comment claims
 *      `bun scripts/eval/feat-501-embed-model-ab.mts` works — untested on
 *      this exact OS/bun combination, evidently). Pure-cosine ranking
 *      isolates embedding-space quality specifically (this benchmark's only
 *      question), at the cost of not exercising the engine's `as_of`/entity
 *      filters — q6/q9/q10/q11 in the fixture, which depend on those
 *      filters, are scored on raw semantic similarity only here, not the
 *      full bitemporal/entity-aware pipeline. Flagged in the results doc.
 *   4. Chinese retrieval: hand-authored fixture (contracts/fixtures/eval/chinese-retrieval-handauthored.json,
 *      NOT C-MTEB — no path to fetch/subsample a real HF dataset was
 *      available in this build session, and the fixture's own `note` field
 *      says so explicitly). Same pure-cosine top-k ranking as English (3),
 *      for onnx-mxbai-cls-q8 vs onnx-bge-m3-cls-q8.
 *   5. Footprint: ONNX weight file size on disk (bytes, from the
 *      `@huggingface/transformers` cache) + approximate post-load RSS,
 *      measured in an isolated subprocess per ONNX row (`--footprint-worker`
 *      mode below) so one row's loaded session never inflates another row's
 *      RSS reading.
 *
 * Refuses to fabricate: any row whose health() check fails, or any
 * unreachable corpus source, is reported with an explicit `error` field and
 * excluded from that metric's numbers — never backfilled with a guess.
 *
 * Usage: bun scripts/eval/onnx-embedder-benchmark.mts [--parity-n 200] [--out <path>]
 * Footprint subprocess (internal): bun scripts/eval/onnx-embedder-benchmark.mts --footprint-worker <rowId>
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { OnnxEmbedProvider, ONNX_MODEL_REGISTRY } from '../../src/providers/embed/onnx.js';
import { OllamaEmbedProvider } from '../../src/providers/embed/ollama.js';
import { resolveEmbedQueryPrefix } from '../../src/contracts/embed.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { EvalCorpus, EvalQuerySet } from '../../src/eval/harness.js';
import { recallAtK, ndcgAtK, type GradedRelevance } from '../../src/eval/metrics.js';

// ---------------------------------------------------------------------------
// Model matrix
// ---------------------------------------------------------------------------

type RowId =
  | 'ollama-mxbai'
  | 'onnx-mxbai-cls-q8'
  | 'onnx-mxbai-mean-q8'
  | 'onnx-mxbai-cls-fp32'
  | 'onnx-bge-m3-cls-q8';

interface MatrixRow {
  id: RowId;
  providerKind: 'ollama' | 'onnx';
  model: string;
  pooling: 'native' | 'cls' | 'mean';
  dtype: string;
  parityEligible: boolean;
  englishEligible: boolean;
  chineseEligible: boolean;
  footprintEligible: boolean;
  build: () => EmbedProvider;
}

function buildRow(id: RowId): EmbedProvider {
  switch (id) {
    case 'ollama-mxbai':
      return new OllamaEmbedProvider({
        model: 'mxbai-embed-large',
        dim: 1024,
        queryPrefix: resolveEmbedQueryPrefix('mxbai-embed-large'),
      });
    case 'onnx-mxbai-cls-q8':
      return new OnnxEmbedProvider({
        model: 'mxbai-embed-large-v1',
        dtype: 'q8',
        pooling: 'cls',
        queryPrefix: resolveEmbedQueryPrefix('mxbai-embed-large-v1'),
      });
    case 'onnx-mxbai-mean-q8':
      return new OnnxEmbedProvider({
        model: 'mxbai-embed-large-v1',
        dtype: 'q8',
        pooling: 'mean',
        queryPrefix: resolveEmbedQueryPrefix('mxbai-embed-large-v1'),
      });
    case 'onnx-mxbai-cls-fp32':
      return new OnnxEmbedProvider({
        model: 'mxbai-embed-large-v1',
        dtype: 'fp32',
        pooling: 'cls',
        queryPrefix: resolveEmbedQueryPrefix('mxbai-embed-large-v1'),
      });
    case 'onnx-bge-m3-cls-q8':
      return new OnnxEmbedProvider({
        model: 'bge-m3',
        dtype: 'q8',
        pooling: 'cls',
        queryPrefix: resolveEmbedQueryPrefix('bge-m3'),
      });
  }
}

const ROWS: MatrixRow[] = [
  { id: 'ollama-mxbai', providerKind: 'ollama', model: 'mxbai-embed-large', pooling: 'native', dtype: '—', parityEligible: false, englishEligible: true, chineseEligible: false, footprintEligible: false, build: () => buildRow('ollama-mxbai') },
  { id: 'onnx-mxbai-cls-q8', providerKind: 'onnx', model: 'mxbai-embed-large-v1', pooling: 'cls', dtype: 'q8', parityEligible: true, englishEligible: true, chineseEligible: true, footprintEligible: true, build: () => buildRow('onnx-mxbai-cls-q8') },
  { id: 'onnx-mxbai-mean-q8', providerKind: 'onnx', model: 'mxbai-embed-large-v1', pooling: 'mean', dtype: 'q8', parityEligible: true, englishEligible: false, chineseEligible: false, footprintEligible: true, build: () => buildRow('onnx-mxbai-mean-q8') },
  { id: 'onnx-mxbai-cls-fp32', providerKind: 'onnx', model: 'mxbai-embed-large-v1', pooling: 'cls', dtype: 'fp32', parityEligible: true, englishEligible: false, chineseEligible: false, footprintEligible: true, build: () => buildRow('onnx-mxbai-cls-fp32') },
  { id: 'onnx-bge-m3-cls-q8', providerKind: 'onnx', model: 'bge-m3', pooling: 'cls', dtype: 'q8', parityEligible: false, englishEligible: true, chineseEligible: true, footprintEligible: true, build: () => buildRow('onnx-bge-m3-cls-q8') },
];

// ---------------------------------------------------------------------------
// Footprint subprocess worker — isolated process per ONNX row so one row's
// loaded ORT session never inflates another row's RSS reading.
// ---------------------------------------------------------------------------

async function runFootprintWorker(rowId: string): Promise<void> {
  const row = ROWS.find((r) => r.id === rowId);
  if (!row || row.providerKind !== 'onnx') {
    console.log(JSON.stringify({ rowId, error: `unknown or non-onnx row id: ${rowId}` }));
    return;
  }
  const rssBefore = process.memoryUsage().rss;
  const provider = row.build() as OnnxEmbedProvider;
  try {
    await provider.preload();
    await provider.embed(['footprint warmup sentence, roughly typical memory-atom length in characters.']);
    const rssAfter = process.memoryUsage().rss;
    console.log(JSON.stringify({ rowId, rssBeforeBytes: rssBefore, rssAfterBytes: rssAfter, rssDeltaBytes: rssAfter - rssBefore }));
  } catch (err) {
    console.log(JSON.stringify({ rowId, error: err instanceof Error ? err.message : String(err) }));
  }
}

function findOnnxWeightFile(hfRepo: string, dtype: string): { path: string; bytes: number } | null {
  const suffixMap: Record<string, string> = { q8: '_quantized', fp16: '_fp16', fp32: '' };
  const suffix = suffixMap[dtype] ?? '';
  const wantedFile = `model${suffix}.onnx`;
  const cacheRoot = join(process.cwd(), 'node_modules', '@huggingface', 'transformers', '.cache');
  if (!existsSync(cacheRoot)) return null;

  // The cache nests as .cache/<hfRepo org>/<hfRepo name>/onnx/<file> — walk
  // it rather than hardcode the exact join, since transformers.js's own
  // cache-key sanitization is an internal implementation detail this script
  // should not assume without verifying against the real downloaded layout.
  const stack: string[] = [cacheRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (entry === wantedFile && full.includes(hfRepo.split('/')[1] ?? hfRepo)) {
        return { path: full, bytes: st.size };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx]!;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Corpus resolution mirrors scripts/eval/onnx-parity.mts's own
// findLocomoDb/findProdDb/resolveCorpus priority exactly (that script lives
// on feat/onnx-embed-provider-s3-parity, not this branch — reimplemented
// here rather than imported, same logic, same priority order).
function findLocomoDb(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, '.eval-data', 'locomo', 'runs', 'fullsuite-ksweep', 'datadir', 'memory.sqlite');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findProdDb(): string | null {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const p = join(process.env.LOCALAPPDATA, 'AstraMemory', 'memory.sqlite');
    if (existsSync(p)) return p;
  } else if (process.env.HOME) {
    const p = join(process.env.HOME, '.local', 'share', 'astra-memory', 'memory.sqlite');
    if (existsSync(p)) return p;
  }
  return null;
}

function loadTextsFromSqlite(dbPath: string, n: number): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(`SELECT DISTINCT text FROM memories WHERE archived = 0 AND LENGTH(text) >= 20 ORDER BY RANDOM() LIMIT ?`)
      .all(n) as Array<{ text: string }>;
    return rows.map((r) => r.text);
  } finally {
    db.close();
  }
}

function resolveParityCorpus(n: number): { label: string; texts: string[] } {
  const locomoDb = findLocomoDb();
  if (locomoDb) {
    const texts = loadTextsFromSqlite(locomoDb, n);
    if (texts.length >= Math.min(n, 50)) return { label: `LoCoMo distilled store: ${locomoDb}`, texts };
  }
  const prodDb = findProdDb();
  if (prodDb) {
    const texts = loadTextsFromSqlite(prodDb, n);
    if (texts.length >= Math.min(n, 50)) return { label: `prod memory.sqlite: ${prodDb}`, texts };
  }
  const fixturePath = join(process.cwd(), 'contracts', 'fixtures', 'eval', 'onnx-parity-fallback-corpus.json');
  if (existsSync(fixturePath)) {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { texts: string[] };
    return { label: `bundled fallback fixture: ${fixturePath}`, texts: fixture.texts.slice(0, n) };
  }
  throw new Error('No parity corpus source reachable (no LoCoMo db, no prod db, no fallback fixture).');
}

async function embedAllSequential(embed: EmbedProvider, texts: string[], label: string): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i++) {
    const [vec] = await embed.embed([texts[i]!]);
    if (!vec) throw new Error(`${label}: embed returned no vector for text index ${i}`);
    out.push(vec);
    if ((i + 1) % 50 === 0 || i === texts.length - 1) {
      console.log(`    [${label}] ${i + 1}/${texts.length} embedded`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Metric implementations
// ---------------------------------------------------------------------------

interface ParityResult { mean: number; min: number; p5: number; belowGateCount: number; n: number }

async function measureParity(
  onnxRow: MatrixRow,
  ollamaVecs: Float32Array[],
  texts: string[],
): Promise<ParityResult> {
  const onnx = onnxRow.build();
  console.log(`  Embedding ${texts.length} texts through ${onnxRow.id}...`);
  const onnxVecs = await embedAllSequential(onnx, texts, onnxRow.id);
  const sims = texts.map((_, i) => cosine(ollamaVecs[i]!, onnxVecs[i]!));
  const sorted = [...sims].sort((a, b) => a - b);
  return {
    mean: mean(sims),
    min: sorted[0]!,
    p5: percentile(sorted, 0.05),
    belowGateCount: sims.filter((s) => s < 0.98).length,
    n: sims.length,
  };
}

interface LatencyResult { singleMsMean: number; singleMsSamples: number[]; batch32TotalMs: number; batch32MsPerEmbed: number }

async function measureLatency(row: MatrixRow, singleText: string, batchTexts: string[]): Promise<LatencyResult> {
  const provider = row.build();
  // Warmup (pays cold session-load / first-run download latency, discarded).
  await provider.embed([singleText]);

  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await provider.embed([singleText]);
    samples.push(Date.now() - t0);
  }

  const t0 = Date.now();
  await provider.embed(batchTexts);
  const batch32TotalMs = Date.now() - t0;

  return {
    singleMsMean: mean(samples),
    singleMsSamples: samples,
    batch32TotalMs,
    batch32MsPerEmbed: batch32TotalMs / batchTexts.length,
  };
}

interface RetrievalResult { meanRecallAt10: number; meanNdcgAt10: number; n: number }

interface RetrievalFixture {
  docs: Array<{ id: string; text: string }>;
  queries: Array<{ id: string; text: string; graded_relevant: GradedRelevance[] }>;
}

/**
 * Pure cosine top-k ranking (embed every doc, embed every query with the
 * provider's own query-side prefix applied — mirroring src/search/search.ts's
 * `embed.queryPrefix ? prefix+query : query` logic, since EmbedProvider.embed()
 * never applies its own queryPrefix — sort docs by cosine similarity, score
 * with the same recallAtK/ndcgAtK metric functions the ADR-005 CI gate uses).
 * Used for BOTH English and Chinese retrieval (see this file's header
 * comment, metric 3, for why English does not go through the real hybrid
 * search engine here).
 */
async function measureCosineRetrieval(row: MatrixRow, fixture: RetrievalFixture, label: string, k = 10): Promise<RetrievalResult> {
  const provider = row.build();
  const docVecs = await embedAllSequential(provider, fixture.docs.map((d) => d.text), `${row.id}-${label}-docs`);
  const docIds = fixture.docs.map((d) => d.id);

  const recalls: number[] = [];
  const ndcgs: number[] = [];
  for (const q of fixture.queries) {
    const queryText = provider.queryPrefix ? `${provider.queryPrefix}${q.text}` : q.text;
    const [qVec] = await provider.embed([queryText]);
    if (!qVec) throw new Error(`${row.id}: no query vector for ${q.id}`);
    const scored = docIds.map((id, i) => ({ id, sim: cosine(qVec, docVecs[i]!) }));
    scored.sort((a, b) => b.sim - a.sim);
    const ranked = scored.map((s) => s.id);
    recalls.push(recallAtK(ranked, q.graded_relevant, k));
    ndcgs.push(ndcgAtK(ranked, q.graded_relevant, k));
  }

  return { meanRecallAt10: mean(recalls), meanNdcgAt10: mean(ndcgs), n: fixture.queries.length };
}

/** Adapts the ADR-005 EvalCorpus/EvalQuerySet fixture shape (atoms + queries
 * with `filters`) into the flat RetrievalFixture shape measureCosineRetrieval
 * expects — atoms become docs, `q.filters` is dropped (see header comment,
 * metric 3, for the as_of/entity-filter caveat this drop implies). */
function adaptEnglishFixture(corpus: EvalCorpus, querySet: EvalQuerySet): RetrievalFixture {
  return {
    docs: corpus.atoms.map((a) => ({ id: a.id, text: a.text })),
    queries: querySet.queries.map((q) => ({ id: q.id, text: q.text, graded_relevant: q.graded_relevant })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface RowReport {
  id: RowId;
  model: string;
  pooling: string;
  dtype: string;
  health: { ok: boolean; error?: string } | { skipped: string };
  parity?: ParityResult | { error: string };
  latency?: LatencyResult | { error: string };
  englishRetrieval?: RetrievalResult | { error: string };
  chineseRetrieval?: RetrievalResult | { error: string };
  footprint?: { fileBytes: number | null; filePath: string | null; rssDeltaBytes: number | null; error?: string };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--footprint-worker') {
    await runFootprintWorker(args[1] ?? '');
    return;
  }
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const parityN = Number(get('--parity-n') ?? 200);
  const outPath = get('--out') ?? join('scripts', 'eval', 'results', 'onnx-embedder-benchmark.json');

  console.log('ADR-018 — ONNX embedder decision-maker benchmark');
  console.log(`Rows: ${ROWS.map((r) => r.id).join(', ')}`);

  const reports: RowReport[] = ROWS.map((r) => ({
    id: r.id,
    model: r.model,
    pooling: r.pooling,
    dtype: r.dtype,
    health: { skipped: 'not yet checked' },
  }));
  const byId = new Map(reports.map((r) => [r.id, r]));

  // --- Health check every row first; never fabricate a metric for a row
  // whose provider doesn't come up healthy. ---
  console.log('\n=== Health checks ===');
  for (const row of ROWS) {
    try {
      const provider = row.build();
      const t0 = Date.now();
      const health = await provider.health();
      console.log(`  ${row.id}: ${JSON.stringify(health)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      byId.get(row.id)!.health = health.ok ? { ok: true } : { ok: false, error: health.error };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${row.id}: EXCEPTION ${msg}`);
      byId.get(row.id)!.health = { ok: false, error: msg };
    }
  }

  const healthyIds = new Set(
    ROWS.filter((r) => (byId.get(r.id)!.health as { ok?: boolean }).ok === true).map((r) => r.id),
  );

  // --- 1. Parity (onnx-mxbai-* rows only) ---
  console.log('\n=== Parity vs ollama-mxbai (document-side, no query prefix) ===');
  const parityRows = ROWS.filter((r) => r.parityEligible && healthyIds.has(r.id));
  if (!healthyIds.has('ollama-mxbai')) {
    for (const row of parityRows) {
      byId.get(row.id)!.parity = { error: 'ollama-mxbai baseline unhealthy — cannot compute parity' };
    }
  } else if (parityRows.length > 0) {
    const corpus = resolveParityCorpus(parityN);
    console.log(`  corpus: ${corpus.label} (n=${corpus.texts.length})`);
    const ollama = buildRow('ollama-mxbai');
    console.log('  Embedding baseline through ollama-mxbai...');
    const ollamaVecs = await embedAllSequential(ollama, corpus.texts, 'ollama-mxbai');
    for (const row of parityRows) {
      try {
        const result = await measureParity(row, ollamaVecs, corpus.texts);
        byId.get(row.id)!.parity = result;
        console.log(`  ${row.id}: mean=${result.mean.toFixed(5)} min=${result.min.toFixed(5)} p5=${result.p5.toFixed(5)} below0.98=${result.belowGateCount}/${result.n}`);
      } catch (err) {
        byId.get(row.id)!.parity = { error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  // --- 2. Latency ---
  console.log('\n=== Latency (single + batch-of-32, CPU) ===');
  const latencyText = 'The daemon runs the hybrid FTS-plus-vector search path against a locally stored SQLite database with sqlite-vec for the vector index.';
  const batchTexts = Array.from({ length: 32 }, (_, i) => `${latencyText} (variant ${i})`);
  for (const row of ROWS) {
    if (!healthyIds.has(row.id)) continue;
    try {
      console.log(`  measuring ${row.id}...`);
      const result = await measureLatency(row, latencyText, batchTexts);
      byId.get(row.id)!.latency = result;
      console.log(`  ${row.id}: single mean=${result.singleMsMean.toFixed(0)}ms batch32 total=${result.batch32TotalMs}ms (${result.batch32MsPerEmbed.toFixed(0)}ms/embed)`);
    } catch (err) {
      byId.get(row.id)!.latency = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- 3. English retrieval ---
  console.log('\n=== English retrieval (ADR-005 fixture, pure cosine ranking) ===');
  const fixturesDir = join('contracts', 'fixtures', 'eval');
  const enCorpus = JSON.parse(readFileSync(join(fixturesDir, 'corpus.json'), 'utf8')) as EvalCorpus;
  const enQueries = JSON.parse(readFileSync(join(fixturesDir, 'queries.json'), 'utf8')) as EvalQuerySet;
  const enFixture = adaptEnglishFixture(enCorpus, enQueries);
  for (const row of ROWS) {
    if (!row.englishEligible || !healthyIds.has(row.id)) continue;
    try {
      console.log(`  running ${row.id}...`);
      const result = await measureCosineRetrieval(row, enFixture, 'en');
      byId.get(row.id)!.englishRetrieval = result;
      console.log(`  ${row.id}: recall@10=${result.meanRecallAt10.toFixed(3)} ndcg@10=${result.meanNdcgAt10.toFixed(3)}`);
    } catch (err) {
      byId.get(row.id)!.englishRetrieval = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- 4. Chinese retrieval ---
  console.log('\n=== Chinese retrieval (hand-authored fixture, pure cosine ranking) ===');
  const zhFixture = JSON.parse(readFileSync(join(fixturesDir, 'chinese-retrieval-handauthored.json'), 'utf8')) as RetrievalFixture;
  for (const row of ROWS) {
    if (!row.chineseEligible || !healthyIds.has(row.id)) continue;
    try {
      console.log(`  running ${row.id}...`);
      const result = await measureCosineRetrieval(row, zhFixture, 'zh');
      byId.get(row.id)!.chineseRetrieval = result;
      console.log(`  ${row.id}: recall@10=${result.meanRecallAt10.toFixed(3)} ndcg@10=${result.meanNdcgAt10.toFixed(3)}`);
    } catch (err) {
      byId.get(row.id)!.chineseRetrieval = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- 5. Footprint (isolated subprocess per onnx row) ---
  console.log('\n=== Footprint (file size + isolated-subprocess RSS) ===');
  for (const row of ROWS) {
    if (!row.footprintEligible || !healthyIds.has(row.id)) continue;
    const registryEntry = ONNX_MODEL_REGISTRY[row.model];
    const hfRepo = registryEntry?.hfRepo ?? '(unknown)';
    console.log(`  spawning isolated subprocess for ${row.id} (${hfRepo}, dtype=${row.dtype})...`);
    try {
      // process.argv[1] (this script's own path) rather than import.meta.path
      // — no bun-types devDependency is installed in this repo (see
      // scripts/eval/extraction-bench/lib/bun-sqlite.d.ts's doc comment for
      // the same "minimal ambient decl, not a new dependency" discipline);
      // process.argv[1] is plain Node-typed and works identically under bun.
      const proc = spawnSync('bun', [process.argv[1]!, '--footprint-worker', row.id], {
        encoding: 'utf8',
      });
      const stdout = (proc.stdout ?? '').trim();
      const lastLine = stdout.split('\n').filter(Boolean).pop() ?? '{}';
      const parsed = JSON.parse(lastLine) as { rssDeltaBytes?: number; error?: string };
      const weightFile = findOnnxWeightFile(hfRepo, row.dtype);
      byId.get(row.id)!.footprint = {
        fileBytes: weightFile?.bytes ?? null,
        filePath: weightFile?.path ?? null,
        rssDeltaBytes: parsed.rssDeltaBytes ?? null,
        ...(parsed.error ? { error: parsed.error } : {}),
      };
      console.log(`  ${row.id}: fileBytes=${weightFile?.bytes ?? 'unknown'} rssDeltaBytes=${parsed.rssDeltaBytes ?? 'unknown'}`);
    } catch (err) {
      byId.get(row.id)!.footprint = { fileBytes: null, filePath: null, rssDeltaBytes: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // --- Write results ---
  mkdirSync(dirname(outPath), { recursive: true });
  const finalReport = { schema: 'astramem-onnx-embedder-benchmark@1', ranAt: new Date().toISOString(), rows: reports };
  writeFileSync(outPath, JSON.stringify(finalReport, null, 2));
  console.log(`\nResults written -> ${outPath}`);

  console.log('\n=== Summary ===');
  for (const r of reports) {
    console.log(JSON.stringify(r));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
