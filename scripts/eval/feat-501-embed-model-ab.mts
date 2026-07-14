/**
 * FEAT-501 stage 1: bge-m3 vs mxbai-embed-large retrieval A/B (EXPERIMENT ONLY
 * — never flips a shipped default, never touches production config/data).
 *
 * Runs the existing ADR-005 retrieval-eval harness (src/eval/harness.ts,
 * the same one tests/eval/retrieval-eval.test.ts gates CI on) in-process,
 * once per embedding model, swapping in a REAL `OllamaEmbedProvider` for the
 * deterministic fake embedder that test uses. In-process = no daemon spawn,
 * no HTTP — a plain library call against a fresh `:memory:` DB, so this is
 * safe to run from an agent shell (CLAUDE.md's "don't spawn a daemon from a
 * coding-agent shell" warning is about the LoCoMo run.mts harness's
 * multi-minute-plus daemon lifecycle, which this script never touches).
 *
 * Scope note (why the ADR-005 fixture, not the full LoCoMo corpus): the two
 * cached local LoCoMo runs under .eval-data/locomo/runs/ are both broken —
 * `2026-07-12T23-49-26-531Z/run-manifest.json` shows `ingest_ok: 0,
 * ingest_failed: 272, distill_timed_out: 10` (all 10 conversations timed
 * out; the 46 memory rows present are partial/interrupted residue, not a
 * complete extraction) and `20260713-postfix-10pct/` has 0 memory rows.
 * Neither is a usable "extraction held constant" snapshot to re-embed
 * against. Running a FRESH full LoCoMo ingest+distill pass to get one would
 * be the multi-hour, real-daemon-spawn operation
 * scripts/eval/locomo/README.md explicitly warns against running from an
 * agent shell tool (verified 2026-07-08 incident: a coding-agent sandbox
 * silently reaped a spawned daemon mid-run). This script instead measures
 * the same recall@10/NDCG@10 metrics, on the same ADR-005 seed corpus/query
 * set every CI run already scores, with real embeddings substituted for the
 * fake ones — the fixture is small (20 atoms / 11 queries) but every
 * measurement is a genuine embedding-geometry comparison, not a simulated
 * one. A full LoCoMo-scale rerun (reusing this same swap-in-a-real-provider
 * technique against a freshly, successfully ingested corpus) is the natural
 * next step before any default-flip decision — flagged as follow-up, not
 * attempted here.
 *
 * Usage: bun scripts/eval/feat-501-embed-model-ab.mts [--out <path>]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { defaultConfig } from '../../src/config/config.js';
import { runRetrievalEval, type EvalCorpus, type EvalQuerySet, type EvalReport } from '../../src/eval/harness.js';
import { OllamaEmbedProvider } from '../../src/providers/embed/ollama.js';
import { resolveEmbedQueryPrefix, QUERY_PREFIX_BY_MODEL } from '../../src/contracts/embed.js';

const fixturesDir = join(process.cwd(), 'contracts', 'fixtures', 'eval');
const corpus = JSON.parse(readFileSync(join(fixturesDir, 'corpus.json'), 'utf8')) as EvalCorpus;
const querySet = JSON.parse(readFileSync(join(fixturesDir, 'queries.json'), 'utf8')) as EvalQuerySet;

interface ModelResult {
  model: string;
  queryPrefix: string;
  health: { ok: boolean; dim: number; error?: string };
  report: EvalReport;
}

type Weights = { alpha: number; beta: number; gamma: number; delta: number; epsilon: number; zeta?: number };

async function runOneModel(model: string, weights: Weights): Promise<ModelResult> {
  const queryPrefix = resolveEmbedQueryPrefix(model);
  const embed = new OllamaEmbedProvider({ model, dim: 1024, queryPrefix });

  const health = await embed.health();
  if (!health.ok) {
    throw new Error(`model ${model} not available via Ollama: ${health.error ?? 'unknown'}`);
  }

  const db = openDb(':memory:');
  migrate(db);
  const report = await runRetrievalEval(db, embed, weights, corpus, querySet);

  return {
    model,
    queryPrefix,
    health: { ok: health.ok, dim: health.dim, ...(health.error ? { error: health.error } : {}) },
    report,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const outPath = get('--out') ?? join('scripts', 'eval', 'results', 'feat-501-embed-model-ab.json');

  const models = ['mxbai-embed-large', 'bge-m3'];
  // Two weight profiles: production defaults (alpha=beta=0.4 — FTS BM25
  // carries half the fused score, which saturates this small keyword-
  // friendly fixture and can mask a real embedding-quality difference), and
  // vector-only (beta=1, everything else 0) to isolate pure embedding-space
  // quality — does bge-m3's dense geometry actually rank better than
  // mxbai's when nothing else is allowed to compensate.
  const weightProfiles: Array<{ label: string; weights: Weights }> = [
    { label: 'production-default', weights: defaultConfig().search },
    { label: 'vector-only', weights: { alpha: 0, beta: 1, gamma: 0, delta: 0, epsilon: 0, zeta: 0 } },
  ];
  console.log(`FEAT-501 embed-model A/B — models: ${models.join(', ')}`);
  console.log(`Query-prefix registry: ${JSON.stringify(QUERY_PREFIX_BY_MODEL)}`);

  // Sequential, never parallel (CLAUDE.md: never run two evals in
  // parallel — applies here even though this is Ollama embed calls, not
  // chat, to avoid any doubt).
  const results: Array<ModelResult & { weightsLabel: string }> = [];
  for (const profile of weightProfiles) {
    for (const model of models) {
      console.log(`\n--- ${model} [${profile.label}] (queryPrefix=${JSON.stringify(resolveEmbedQueryPrefix(model))}) ---`);
      const result = await runOneModel(model, profile.weights);
      results.push({ ...result, weightsLabel: profile.label });
      console.log(`  health: ok=${result.health.ok} dim=${result.health.dim}`);
      for (const r of result.report.perQuery) {
        console.log(`  ${r.id} [${r.mode}] recall@10=${r.recall?.toFixed(3)} ndcg@10=${r.ndcg?.toFixed(3)}`);
      }
      console.log(`  mean recall@10=${result.report.meanRecall.toFixed(4)} mean ndcg@10=${result.report.meanNdcg.toFixed(4)}`);
    }
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    console.log(`[${r.weightsLabel.padEnd(19)}] ${r.model.padEnd(20)} recall@10=${r.report.meanRecall.toFixed(4)}  ndcg@10=${r.report.meanNdcg.toFixed(4)}`);
  }

  const out = {
    schema: 'astramem-feat-501-embed-model-ab@2',
    ranAt: new Date().toISOString(),
    corpusFixture: 'contracts/fixtures/eval/corpus.json+queries.json (ADR-005 seed set, NOT the full LoCoMo corpus — see script header)',
    corpusSize: corpus.atoms.length,
    querySetSize: querySet.queries.length,
    weightProfiles: weightProfiles.map(p => ({ label: p.label, weights: p.weights })),
    results: results.map(r => ({
      weightsLabel: r.weightsLabel,
      model: r.model,
      queryPrefix: r.queryPrefix,
      health: r.health,
      meanRecallAt10: r.report.meanRecall,
      meanNdcgAt10: r.report.meanNdcg,
      perQuery: r.report.perQuery.map(q => ({ id: q.id, mode: q.mode, recall: q.recall, ndcg: q.ndcg })),
    })),
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nResults written -> ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
