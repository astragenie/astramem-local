/**
 * Oracle-factorial harness (Phase 1, `docs/research/20260720-locomo-improvement-v2-post-crossreview.md`
 * §"Phase 1 — the oracle factorial"). This is the TRUNK (T0): the two
 * contracts every parallel builder codes against, the glob-discovery
 * mechanism, the (source × answerer) driver, judge wiring, the aggregate
 * table, and the LEDGER-row emitter. Nothing else should own these — see
 * this file's own header history in the PR that introduced it for why the
 * contracts are frozen once 3 parallel builders start depending on them.
 *
 * WHAT THIS MEASURES: the honest ceiling of each pipeline stage. Answer
 * every question from a DIFFERENT evidence source (gold-source-turns,
 * gold-atoms, retrieved-atoms, retrieved-source-spans, ...) crossed with
 * different answerers (the current fixed-cheap-Azure answerer, a canonical
 * renderer, ...) — the resulting factorial table is the only thing that can
 * honestly attribute single-hop's measured gap to extraction vs retrieval
 * vs evidence-sufficiency vs answering vs scoring (v2 plan §Phase 1).
 *
 * ── The two contracts (STABLE — do not change the shape once builders
 *    depend on them; see the dispatch note this file's PR carries) ────────
 *
 * `EvidenceSource.hitsFor` produces the `SearchHit[]` an `Answerer.answer`
 * consumes, mirroring answer.mts's actual seam
 * (`hits = await recall(...)` -> `buildAnswerPrompt(question, hits)`): each
 * cell in the factorial varies ONLY what produces `hits` and which answerer
 * turns them into a hypothesis, nothing else about the driver loop.
 *
 * ── Discovery (CRITICAL — this is what makes the parallel wave
 *    conflict-free) ─────────────────────────────────────────────────────
 *
 * There is NO central registry file to edit. `discoverSources`/
 * `discoverAnswerers` glob `oracle/sources/*.mts` / `oracle/answerers/*.mts`
 * relative to THIS file's own directory, dynamic-`import()` each one, and
 * read its `export default`. The module's `.id` MUST equal its filename
 * stem (enforced, throws otherwise) — that's the only convention a new
 * source/answerer file has to follow. Parallel builders only ADD files
 * under `sources/`/`answerers/`; nobody edits this file to "register"
 * anything. A filename starting with `_` (e.g. `_reference-noop.mts`) is
 * still discoverable and loadable — it is simply excluded from
 * `defaultSelection` so an ordinary `oracle-factorial.mts` invocation
 * with no `--sources`/`--answerers` flags does not silently run the
 * reference/template modules.
 *
 * ── Driver scope: categories 1-4 only ──────────────────────────────────
 *
 * Category 5 (adversarial) questions have no `evidence[]`-grounded "gold
 * source turns" in the sense this harness cares about — the correct
 * response is always abstention, and `runLlmJudge` already excludes
 * category 5 (it's scored deterministically, see judge.mts's header). This
 * driver excludes category 5 from EVERY cell (both the token-F1 and
 * llm-judge passes), so "cat1-4" is the harness's scope everywhere, not
 * just the llm-judge pass's own internal filter.
 */
import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LoCoMoSample } from '../lib/types.js';
import { qaId } from '../lib/types.js';
import type { SearchHit, DaemonClientOpts } from '../../shared/daemon-client.js';
import type { AzureConfig } from '../../shared/config.js';
import { writeHypothesesJsonl, type AnswerOutcome } from '../answer.mts';
import { scoreRun, type MetricsReport } from '../judge/metrics.mts';
import { runLlmJudge } from '../judge.mts';

// ── Contract 1: what a question is answered FROM ───────────────────────────

/** One QA pair from the real dataset shape (`LoCoMoSample['qa'][number]`) —
 *  not a bespoke type, so every source/answerer sees exactly the fields the
 *  rest of the harness (answer.mts, judge/metrics.mts) already relies on. */
export type QA = LoCoMoSample['qa'][number];

/** Everything a source/answerer needs beyond the one QA pair it was called
 *  with: the full sampled dataset (so a source can look up gold turns by
 *  `evidence[]` dia_id across the WHOLE conversation, not just its own qa
 *  entry), an optional store daemon client (present iff the harness mounted
 *  one because a SELECTED source declared `needsStore: true`), the Azure
 *  config every answerer needs to reach the shared cheap deployment, and the
 *  `k` the run was invoked with (retrieval-backed sources should respect it
 *  the same way answer.mts's `recall(..., limit: k)` does, for comparability
 *  with the real benchmark path). */
export interface EvidenceContext {
  dataset: LoCoMoSample[];
  daemonClient?: DaemonClientOpts;
  azureCfg: AzureConfig;
  k: number;
}

/**
 * Produces the evidence (`SearchHit[]`) for one question. A cell legitimately
 * MAY return zero hits (e.g. the reference noop source, or a genuine
 * retrieval miss) — that is a valid oracle result, not an error; this
 * harness never applies answer.mts's `assertStoreNotEmpty` guard (that guard
 * exists to catch a BROKEN real-benchmark run, and an oracle cell testing
 * "what if retrieval finds nothing" is not broken, it's the point).
 */
export interface EvidenceSource {
  /** Stable slug. MUST equal this module's filename stem (enforced by
   *  `discoverSources`) — becomes the factorial table's row id and the
   *  `cell-<id>-<answererId>.hypotheses.jsonl` filename component. */
  id: string;
  /** The harness mounts exactly ONE store daemon (on `--datadir`, via the
   *  spawn-daemon resume path) iff ANY SELECTED source declares this true —
   *  gold-turn-style sources that read straight from `ctx.dataset` need no
   *  store and should set this false. */
  needsStore: boolean;
  hitsFor(qa: QA, sampleId: string, ctx: EvidenceContext): Promise<SearchHit[]>;
}

// ── Contract 2: what turns evidence into a hypothesis ──────────────────────

/**
 * Turns a question + its evidence into a hypothesis string. Mirrors
 * answer.mts's own seam (`buildAnswerPrompt(question, hits)` ->
 * `azureChatComplete(...)`) — see `oracle/answerers/current.mts` for the
 * reference implementation that wraps that exact pipeline.
 */
export interface Answerer {
  /** Stable slug. MUST equal this module's filename stem (enforced by
   *  `discoverAnswerers`) — becomes the factorial table's column id and the
   *  `cell-<sourceId>-<id>.hypotheses.jsonl` filename component. */
  id: string;
  answer(question: string, hits: SearchHit[], ctx: EvidenceContext): Promise<string>;
}

// ── Discovery ────────────────────────────────────────────────────────────

interface Identified { id: string }

/** Glob `oracle/<dirName>/*.mts` relative to THIS file's directory,
 *  dynamic-import each one, and collect its `export default` keyed by
 *  filename stem. No central registry — see this file's header. */
async function discoverModules<T extends Identified>(dirName: 'sources' | 'answerers'): Promise<Map<string, T>> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), dirName);
  const map = new Map<string, T>();
  if (!existsSync(dir)) return map;

  const files = readdirSync(dir).filter(f => f.endsWith('.mts'));
  for (const file of files) {
    const stem = file.slice(0, -'.mts'.length);
    const modUrl = pathToFileURL(join(dir, file)).href;
    const mod = (await import(modUrl)) as { default?: T };
    if (!mod.default || typeof mod.default.id !== 'string') {
      throw new Error(`oracle/${dirName}/${file}: must \`export default\` an object with a string 'id' field.`);
    }
    if (mod.default.id !== stem) {
      throw new Error(
        `oracle/${dirName}/${file}: default export id "${mod.default.id}" must equal the filename stem "${stem}" ` +
        `— rename the file or the id so they match (this is the only convention discovery relies on).`,
      );
    }
    map.set(stem, mod.default);
  }
  return map;
}

export function discoverSources(): Promise<Map<string, EvidenceSource>> {
  return discoverModules<EvidenceSource>('sources');
}

export function discoverAnswerers(): Promise<Map<string, Answerer>> {
  return discoverModules<Answerer>('answerers');
}

/** Every discovered id EXCEPT ones starting with `_` — the "internal but
 *  still loadable" convention (`_reference-noop`) this file's header
 *  describes. Sorted for deterministic CLI output/table ordering. */
export function defaultSelection(discovered: Map<string, Identified>): string[] {
  return [...discovered.keys()].filter(id => !id.startsWith('_')).sort();
}

// ── Driver ───────────────────────────────────────────────────────────────

export interface CellResult {
  sourceId: string;
  answererId: string;
  hypPath: string;
  f1: MetricsReport;
  llmJudge?: MetricsReport;
}

export interface OracleFactorialOpts {
  /** The sampled conversation(s) this run scores — full samples, qa arrays
   *  UNFILTERED (category-1-4 filtering happens inside the driver, per
   *  question, so `qa_id`s stay aligned with `qaId(sampleId, originalIndex)`
   *  the same way judge.mts's `references` lookup expects). */
  dataset: LoCoMoSample[];
  sources: EvidenceSource[];
  answerers: Answerer[];
  azureCfg: AzureConfig;
  daemonClient?: DaemonClientOpts;
  k: number;
  /** Every cell's `cell-<source>-<answerer>.hypotheses.jsonl` (+ nothing
   *  else) is written here — `factorial.json`/`factorial.md` are the
   *  caller's (CLI's) job to write, this function only returns the data. */
  outDir: string;
  /** Runs `runLlmJudge` (Azure semantic pass, cat1-4) alongside `scoreRun`
   *  (token-F1) for every cell — the v2 plan mandates reporting both always
   *  (see this file's header). Set false only for a token-F1-only smoke
   *  when Azure creds are unavailable. */
  llmJudge: boolean;
  /** Smoke cap: keep only the first N (source-order, sample-order,
   *  qa-index-order) cat1-4 questions across the WHOLE dataset. Omit for a
   *  full run. */
  limitQuestions?: number;
  /** How many questions are answered concurrently PER CELL. Mirrors
   *  answer.mts's DEFAULT_ANSWER_CONCURRENCY rationale — a scheduling knob
   *  only, never changes which hypothesis is produced for which question. */
  concurrency?: number;
}

const DEFAULT_CELL_CONCURRENCY = 8;

/** Run `worker` over `items` with at most `limit` in flight, preserving
 *  INPUT ORDER in the returned array (mirrors answer.mts's
 *  `mapWithConcurrency` — duplicated here rather than imported since that
 *  one is module-private to answer.mts and this harness must not touch that
 *  file, see `oracle/answerers/current.mts`'s header for why). */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

interface Task {
  qa: QA;
  sampleId: string;
  /** Index into the sample's ORIGINAL (unfiltered) qa[] array — this is
   *  what qaId()/scoreRun/runLlmJudge key on, not the filtered position. */
  qaIndex: number;
}

function buildTaskList(dataset: LoCoMoSample[], limitQuestions?: number): Task[] {
  const all: Task[] = [];
  for (const sample of dataset) {
    sample.qa.forEach((qa, i) => {
      if (qa.category === 5) return; // adversarial excluded — see file header
      all.push({ qa, sampleId: sample.sample_id, qaIndex: i });
    });
  }
  return limitQuestions !== undefined ? all.slice(0, limitQuestions) : all;
}

/**
 * Runs every (source × answerer) cell over the same task list, writes each
 * cell's hypotheses.jsonl into `outDir`, and judges it (token-F1 always,
 * llm-judge iff `opts.llmJudge`). Returns per-cell results in
 * sources-outer/answerers-inner order (matches the factorial table's
 * row-major reading order).
 */
export async function runOracleFactorial(opts: OracleFactorialOpts): Promise<CellResult[]> {
  const { dataset, sources, answerers, azureCfg, daemonClient, k, outDir, llmJudge, limitQuestions, concurrency } = opts;
  mkdirSync(outDir, { recursive: true });

  const ctx: EvidenceContext = { dataset, daemonClient, azureCfg, k };
  const tasks = buildTaskList(dataset, limitQuestions);
  console.log(
    `Oracle factorial: ${sources.length} source(s) x ${answerers.length} answerer(s), ` +
    `${tasks.length} question(s) (cat1-4) per cell.`,
  );

  const cells: CellResult[] = [];
  for (const source of sources) {
    for (const answerer of answerers) {
      console.log(`\n=== cell: ${source.id} x ${answerer.id} ===`);
      let failedQuestions = 0;
      const outcomes = await mapWithConcurrency(tasks, concurrency ?? DEFAULT_CELL_CONCURRENCY, async (t): Promise<AnswerOutcome> => {
        try {
          const hits = await source.hitsFor(t.qa, t.sampleId, ctx);
          const hypothesis = await answerer.answer(t.qa.question, hits, ctx);
          return {
            qa_id: qaId(t.sampleId, t.qaIndex),
            sample_id: t.sampleId,
            category: t.qa.category,
            hypothesis: hypothesis.trim(),
            hit_count: hits.length,
          };
        } catch (err) {
          // A single question that still fails AFTER the client's own retry
          // budget (network throw, exhausted 429 backoff, provider 4xx) must
          // NOT reject Promise.all and discard a 152-question cell — that is
          // how one dropped socket killed the Tier-A gate run on 2026-07-20.
          // Degrade to a scored abstention (empty hypothesis, hit_count 0) so
          // the cell still produces a table; count + surface them so a cell
          // that silently lost half its questions can't masquerade as a real
          // score.
          failedQuestions++;
          console.error(`  [warn] ${source.id} x ${answerer.id} q=${qaId(t.sampleId, t.qaIndex)} failed after retries: ${err instanceof Error ? err.message : String(err)}`);
          return {
            qa_id: qaId(t.sampleId, t.qaIndex),
            sample_id: t.sampleId,
            category: t.qa.category,
            hypothesis: '(answer failed after retries)',
            hit_count: 0,
          };
        }
      });
      if (failedQuestions > 0) {
        console.error(`  [warn] cell ${source.id} x ${answerer.id}: ${failedQuestions}/${tasks.length} question(s) degraded to abstention — the score below is UNDERSTATED by that many.`);
      }

      const hypPath = join(outDir, `cell-${source.id}-${answerer.id}.hypotheses.jsonl`);
      writeHypothesesJsonl(outcomes, hypPath);

      const f1 = scoreRun(outcomes, dataset);
      let llm: MetricsReport | undefined;
      if (llmJudge) {
        console.log(`  running Azure llm-judge pass (cat1-4) for ${outcomes.length} hypotheses...`);
        llm = await runLlmJudge(outcomes, dataset);
      }
      console.log(
        `  f1 cat-avg=${f1.category_averaged_accuracy.toFixed(4)}` +
        (llm ? `, llm-judge cat-avg=${llm.category_averaged_accuracy.toFixed(4)}` : ''),
      );
      cells.push({ sourceId: source.id, answererId: answerer.id, hypPath, f1, llmJudge: llm });
    }
  }
  return cells;
}

// ── Aggregation ──────────────────────────────────────────────────────────

/** Row-major (source × answerer) markdown table — primary number is
 *  llm-judge cat-avg (parens hold token-F1 cat-avg), per this file's header
 *  ("primary is llm-judge, F1 is always also reported"). Followed by a
 *  per-cell per-category expansion so a reader can see WHICH category moved,
 *  not just the aggregate. */
export function buildFactorialMarkdown(cells: CellResult[]): string {
  const sourceIds = [...new Set(cells.map(c => c.sourceId))];
  const answererIds = [...new Set(cells.map(c => c.answererId))];
  const byKey = new Map(cells.map(c => [`${c.sourceId}::${c.answererId}`, c]));

  const lines: string[] = [];
  lines.push('# LoCoMo oracle factorial');
  lines.push('');
  lines.push('Cell = llm-judge cat-avg (token-F1 cat-avg). `n/a` = cell not run this invocation.');
  lines.push('');
  lines.push(`| source \\ answerer | ${answererIds.join(' | ')} |`);
  lines.push(`|---|${answererIds.map(() => '---').join('|')}|`);
  for (const s of sourceIds) {
    const row = answererIds.map(a => {
      const c = byKey.get(`${s}::${a}`);
      if (!c) return 'n/a';
      const f1 = c.f1.category_averaged_accuracy;
      const llm = c.llmJudge?.category_averaged_accuracy;
      const f1Str = Number.isNaN(f1) ? 'n/a' : f1.toFixed(4);
      const llmStr = llm === undefined ? '' : Number.isNaN(llm) ? 'n/a' : llm.toFixed(4);
      return llmStr ? `${llmStr} (${f1Str})` : f1Str;
    });
    lines.push(`| ${s} | ${row.join(' | ')} |`);
  }

  lines.push('', '## Per-category detail', '');
  for (const cell of cells) {
    lines.push(`### ${cell.sourceId} x ${cell.answererId}`, '');
    lines.push('| category | f1 | llm-judge | n |');
    lines.push('|---|---|---|---|');
    for (const catKey of Object.keys(cell.f1.per_category)) {
      const cat = Number(catKey) as keyof MetricsReport['per_category'];
      const f1c = cell.f1.per_category[cat];
      const llmc = cell.llmJudge?.per_category[cat];
      const f1Str = Number.isNaN(f1c.accuracy) ? 'n/a' : f1c.accuracy.toFixed(4);
      const llmStr = llmc === undefined ? '-' : Number.isNaN(llmc.accuracy) ? 'n/a' : llmc.accuracy.toFixed(4);
      lines.push(`| ${cat} (${f1c.name}) | ${f1Str} | ${llmStr} | ${f1c.n} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * One `docs/eval-runs/LEDGER.md`-shaped row (`| date | name | score | n |
 * params |`), printed to stdout only — this harness never appends to
 * LEDGER.md itself (Phase 3 orchestration owns that, per the dispatch
 * spec). `score` is the best cell's llm-judge cat-avg (falling back to its
 * token-F1 cat-avg when llm-judge wasn't run).
 */
export function buildLedgerRow(opts: { name: string; cells: CellResult[]; n: number; extraParams?: string }): string {
  const { name, cells, n, extraParams } = opts;
  const today = new Date().toISOString().slice(0, 10);
  if (cells.length === 0) return `| ${today} | ${name} | unjudged | ${n} | oracle-factorial: no cells run |`;

  const scoreOf = (c: CellResult): number => c.llmJudge?.category_averaged_accuracy ?? c.f1.category_averaged_accuracy;
  const best = cells.reduce((a, b) => (scoreOf(b) > scoreOf(a) ? b : a));
  const score = scoreOf(best);
  const scoreStr = Number.isNaN(score) ? 'n/a' : score.toFixed(4);
  const params =
    `oracle-factorial best-cell=${best.sourceId}x${best.answererId} ` +
    `f1=${best.f1.category_averaged_accuracy.toFixed(4)}` +
    (best.llmJudge ? ` llm=${best.llmJudge.category_averaged_accuracy.toFixed(4)}` : '') +
    (extraParams ? ` ${extraParams}` : '');
  return `| ${today} | ${name} | ${scoreStr} | ${n} | ${params} |`;
}
