/**
 * Noise-sampling wrapper (Track E measurement-overhaul directive, 2026-07-23):
 * repeats a LoCoMo run N times (default 3) and reports median+spread
 * alongside the existing mean±stdev, so a genuine small lever (+0.01-0.02)
 * is separable from the PROVEN ±4.3-point single-extraction swing
 * (docs/eval-runs/README.md's "codex day-variance" finding; see also
 * memory: extraction-noise-conv26). One repeated invocation carries either
 * mode below, but never both -- the two noise sources are deliberately kept
 * apart, since conflating them is exactly how a same-day rerank/decompose
 * A/B got mis-attributed to day-variance earlier this session (LEDGER
 * 2026-07-20 multihop-v2 row: "+0.040 uniform across ALL cats = day-variance
 * signature not decompose").
 *
 *   --mode reingest   N full run.mts invocations (fresh sample -> ingest ->
 *                     distill -> answer, each into its own --run-dir).
 *                     Carries BOTH extraction noise (codex service-day
 *                     variance, proven ~6pt/day) AND answerer noise -- "how
 *                     noisy is a from-scratch score." Expensive: each repeat
 *                     pays a full ingest+distill pass. Use for a small
 *                     conv-1 sample routinely; reserve a full-suite (n=1986)
 *                     reingest repeat for a rare, deliberate confirm (see
 *                     ../full-suite.mts for the single-repeat entry point
 *                     this composes with -- pass that file's documented
 *                     flags through as this wrapper's passthrough args).
 *
 *   --mode reanswer   ONE existing, already-ingested+distilled run dir
 *                     (--base-run-dir), re-answered N times via
 *                     `run.mts --resume`. The underlying atoms never change
 *                     -- this isolates answerer-only noise (LLM sampling,
 *                     reranker if enabled) at ZERO extraction cost. Pair
 *                     with an answer-affecting flag (--cross-encoder,
 *                     --cross-encoder-provider, --multihop, --answerer, ...)
 *                     to see whether a retrieval-side lever's effect clears
 *                     the (much narrower) reanswer noise floor before paying
 *                     for a fresh extraction pass to also clear the reingest
 *                     noise floor. `--k` (retrieval depth -- score-affecting,
 *                     unlike --answer-concurrency, see deriveResumeAnswererArgs)
 *                     is auto-derived from the base run's own
 *                     run-manifest.json unless passed explicitly, so a
 *                     forgotten --k can never silently re-score the store at
 *                     run.mts's own default (10) instead of the k it was
 *                     actually answered against.
 *
 * Both modes score every repeat with judge/metrics.mts's scoreRun, then
 * report BOTH combineMetricsReports (mean±stdev, existing) AND
 * combineRobustStats (median+range, ./judge/robust-stats.ts -- see that
 * file's header for why median matters at N=3-5) side by side, and refuse
 * to aggregate non-comparable run dirs the same way judge.mts's own
 * --run-dir multi-run path already does (../shared/run-params.ts's
 * evaluateMultiRunParamsGuard) -- reingest repeats must share the same
 * dataset/seed/n/qaPerSample/shards (guaranteed by construction here, since
 * every repeat forwards the identical passthrough args); reanswer snapshots
 * always pass trivially (same base dir's run-params.json, copied verbatim,
 * never re-derived).
 *
 * This script only ORCHESTRATES -- it shells out to run.mts exactly the way
 * an operator would by hand (one `bun run.mts ...` child process per
 * repeat, stdio inherited so a real run's live progress stays visible), and
 * never runs a LoCoMo pass itself. Every function below except the
 * `runChild`/`runReingest`/`runReanswer` trio is pure/file-only and
 * unit-tested with no child process, no daemon, no network -- matching
 * run.mts's own precedent (see its README section: "run.mts itself...has
 * no unit test...its component functions are independently testable but the
 * orchestration logic itself is only exercised by an actual run"). Pass
 * `--print-only` to see the exact resolved child command(s) and snapshot
 * plan for either mode without executing anything -- the safe way to sanity
 * -check flags before committing to an hours-long full-suite reingest.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *
 * bun scripts/eval/locomo/repeat-run.mts --mode reingest --runs 3
 *   --run-dir-base .eval-data/locomo/runs/noise-sample-<date>
 *   [...any run.mts flag, forwarded verbatim to EVERY repeat, e.g.
 *    --n 1 --k 15 --extract-profile conversational
 *    --extraction-provider codex-subscription --extraction-model gpt-5.4-mini
 *    --compaction-mode never]
 *   (may not also pass --run-dir or --resume -- this wrapper owns those)
 *
 * bun scripts/eval/locomo/repeat-run.mts --mode reanswer --runs 3
 *   --base-run-dir .eval-data/locomo/runs/<already-ingested-run>
 *   [...any run.mts flag composable with --resume, e.g. --cross-encoder
 *    --cross-encoder-provider onnx --answerer <ollama-tag>]
 *   (may not also pass --resume/--dataset/--seed/--n/--qa-per-sample/--shards
 *    -- derived automatically from --base-run-dir's own run-params.json, the
 *    same file evaluateResumeGuard already requires --resume to match)
 *
 * Add --print-only to either invocation to preview without executing.
 *
 * Output: `<last-run-dir>.noise-report.json` (run dirs + both aggregations)
 * plus a console report. To publish any of these numbers, archive each
 * individual repeat dir with the existing archive-run.mts (one archived
 * folder per repeat, e.g. `<slug>-rep1`/`<slug>-rep2`/`<slug>-rep3`) and
 * record the noise-report's median/range in the LEDGER.md row by hand --
 * this wrapper does not write LEDGER rows itself, since a noise SAMPLE
 * (several repeats) is not the same publishable unit archive-run.mts models
 * (one repeats-of-one run dir).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LoCoMoSample, LoCoMoCategory } from './lib/types.js';
import { scoreRun, combineMetricsReports, printMultiRunReport, type MetricsReport, type MultiRunMetricsReport } from './judge/metrics.mts';
import { combineRobustStats, printRobustReport, type MultiRunRobustReport } from './judge/robust-stats.js';
import { evaluateMultiRunParamsGuard, type RunParams } from '../shared/run-params.js';

// ── pure helpers (unit-tested; no child process, no daemon, no network) ────

export function reingestRunDirs(runDirBase: string, runs: number): string[] {
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`runs must be a positive integer, got ${runs}`);
  return Array.from({ length: runs }, (_, i) => `${runDirBase}-rep${i + 1}`);
}

export function reanswerSnapshotDirs(baseRunDir: string, runs: number): string[] {
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`runs must be a positive integer, got ${runs}`);
  return Array.from({ length: runs }, (_, i) => `${baseRunDir}-reanswer${i + 1}`);
}

/** Re-derives the --resume sampling flags evaluateResumeGuard requires to
 *  match run-params.json, so an operator running --mode reanswer never has
 *  to hand-retype --dataset/--seed/--n/--qa-per-sample/--shards (and risk
 *  a --resume refusal, or worse, a silently-narrowed scope if the guard
 *  ever grows an override). datasetHash is intentionally excluded -- it's
 *  not a run.mts flag, it's re-derived from the dataset file at run time. */
export function deriveResumeSamplingArgs(params: RunParams): string[] {
  const args: string[] = [];
  if (params.datasetPath !== undefined && params.datasetPath !== null) args.push('--dataset', String(params.datasetPath));
  if (params.seed !== undefined && params.seed !== null) args.push('--seed', String(params.seed));
  if (params.n !== undefined && params.n !== null) args.push('--n', String(params.n));
  if (params.qaPerSample !== undefined && params.qaPerSample !== null) args.push('--qa-per-sample', String(params.qaPerSample));
  if (params.shards !== undefined && params.shards !== null) args.push('--shards', String(params.shards));
  return args;
}

export interface DerivedAnswererArgs {
  args: string[];
  warning: string | null;
}

/**
 * Review fix (rev-e MEDIUM, 2026-07-23): `--k` is a retrieval-depth knob
 * that genuinely changes what the answerer sees (and therefore the score),
 * run.mts parses it fresh every invocation with NO persistence
 * (`Number(get('--k') ?? '10')`), and neither evaluateResumeGuard nor
 * evaluateMultiRunParamsGuard covers it -- unlike dataset/seed/n/
 * qaPerSample/shards above, a --mode reanswer repeat that forgets --k
 * silently re-scores the base store at run.mts's OWN default (10) instead
 * of whatever k it was actually ingested/tuned for (e.g.
 * ../full-suite.mts's tuned k=15), and that reads indistinguishably from
 * "answerer noise" in the aggregated report. Auto-derive it from the base
 * run's own run-manifest.json (`config.k`, always written by run.mts) the
 * same silent-safe way deriveResumeSamplingArgs handles the guarded fields
 * above.
 *
 * An explicit `--k` already present in the caller's passthrough is left
 * alone, not overridden -- unlike the RESERVED_REANSWER_FLAGS above, `--k`
 * is NOT resume-guarded (varying it can never trigger evaluateResumeGuard's
 * refusal), so a deliberate k-depth A/B on the same store is a legitimate,
 * intentional use of this wrapper, not a mistake to block.
 *
 * `--answer-concurrency` is NOT derived here: run.mts's own header
 * documents it as "purely a scheduling knob -- the prompt, deployment,
 * token budget and k are untouched, so the hypotheses (and therefore the
 * score) are identical to the old strictly-serial loop," and (unlike k) it
 * is never written into run-manifest.json's config at all -- there is
 * nothing to derive it FROM, and no score-corruption risk in leaving it at
 * run.mts's own default.
 */
export function deriveResumeAnswererArgs(runManifestJson: unknown, passthroughHasK: boolean): DerivedAnswererArgs {
  if (passthroughHasK) return { args: [], warning: null };
  const k = (runManifestJson as { config?: { k?: unknown } } | null | undefined)?.config?.k;
  if (typeof k === 'number' && Number.isFinite(k)) {
    return { args: ['--k', String(k)], warning: null };
  }
  return {
    args: [],
    warning: 'WARNING: could not derive --k from the base run\'s run-manifest.json (missing, unreadable, or config.k is not a finite number) '
      + '-- this reanswer repeat will fall through to run.mts\'s own --k default (10), which may silently differ from the k the base store '
      + 'was actually answered/tuned against. Pass --k <value> explicitly to pin it.',
  };
}

/** Copies the 3 files a repeat's aggregation needs (hypotheses.jsonl,
 *  sample.json, run-params.json) plus run-manifest.json (best-effort, purely
 *  informational) out of a --resume run dir BEFORE the next --resume
 *  invocation overwrites hypotheses.jsonl in place. Throws if any of the
 *  three required files is missing -- an honest "this isn't a completed
 *  run.mts output dir" rather than a silent partial snapshot. */
export function snapshotAnswerOutputs(sourceDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const name of ['hypotheses.jsonl', 'sample.json', 'run-params.json']) {
    const src = join(sourceDir, name);
    if (!existsSync(src)) throw new Error(`snapshotAnswerOutputs: ${src} missing -- is ${sourceDir} a completed run.mts output dir (ingest+distill+answer all finished)?`);
    copyFileSync(src, join(destDir, name));
  }
  const manifestSrc = join(sourceDir, 'run-manifest.json');
  if (existsSync(manifestSrc)) copyFileSync(manifestSrc, join(destDir, 'run-manifest.json'));
}

interface HypothesisRow {
  qa_id: string;
  sample_id: string;
  category: LoCoMoCategory;
  hypothesis: string;
}

function parseJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}

export type AggregateResult =
  | { ok: true; f1: MultiRunMetricsReport; robust: MultiRunRobustReport }
  | { ok: false; refuseMessage: string };

/** Scores every run dir's hypotheses.jsonl against its own sample.json, then
 *  combines them both ways (mean±stdev via ./judge/metrics.mts's existing
 *  combineMetricsReports, median+range via ./judge/robust-stats.ts's
 *  combineRobustStats) -- refuses first (mirrors judge.mts's --run-dir
 *  multi-run path) if the dirs weren't sampled comparably. */
export function aggregateRunDirs(runDirs: string[]): AggregateResult {
  const guard = evaluateMultiRunParamsGuard(runDirs);
  if (guard.action === 'refuse') return { ok: false, refuseMessage: guard.refuseMessage };

  const reports: MetricsReport[] = runDirs.map(dir => {
    const hypotheses = parseJsonl<HypothesisRow>(join(dir, 'hypotheses.jsonl'));
    const references = JSON.parse(readFileSync(join(dir, 'sample.json'), 'utf8')) as LoCoMoSample[];
    return scoreRun(hypotheses, references);
  });
  return { ok: true, f1: combineMetricsReports(reports), robust: combineRobustStats(reports) };
}

// ── CLI arg parsing (pure; no I/O) ──────────────────────────────────────────

export interface ParsedArgs {
  mode: 'reingest' | 'reanswer';
  runs: number;
  runDirBase?: string;
  baseRunDir?: string;
  printOnly: boolean;
  passthrough: string[];
}

const OWN_FLAGS_WITH_VALUE = ['--mode', '--runs', '--run-dir-base', '--base-run-dir'];
export const RESERVED_REINGEST_FLAGS = ['--run-dir', '--resume'];
export const RESERVED_REANSWER_FLAGS = ['--resume', '--dataset', '--seed', '--n', '--qa-per-sample', '--shards'];

export function parseArgs(args: string[]): ParsedArgs {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const modeRaw = get('--mode');
  if (modeRaw !== 'reingest' && modeRaw !== 'reanswer') {
    throw new Error(`--mode must be 'reingest' or 'reanswer', got: ${modeRaw ?? '(missing)'}`);
  }
  const runsRaw = get('--runs') ?? '3';
  const runs = Number(runsRaw);
  if (!Number.isInteger(runs) || runs < 2) {
    throw new Error(`--runs must be an integer >= 2 (need at least 2 repeats to report a spread), got: ${runsRaw}`);
  }
  const runDirBase = get('--run-dir-base');
  const baseRunDir = get('--base-run-dir');
  if (modeRaw === 'reingest' && !runDirBase) throw new Error('--mode reingest requires --run-dir-base <path>');
  if (modeRaw === 'reanswer' && !baseRunDir) throw new Error('--mode reanswer requires --base-run-dir <existing completed run dir>');

  const passthrough: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (OWN_FLAGS_WITH_VALUE.includes(a)) { i++; continue; }
    if (a === '--print-only') continue;
    passthrough.push(a);
  }

  const reserved = modeRaw === 'reingest' ? RESERVED_REINGEST_FLAGS : RESERVED_REANSWER_FLAGS;
  const conflicts = reserved.filter(f => passthrough.includes(f));
  if (conflicts.length > 0) {
    const owner = modeRaw === 'reingest' ? 'manages --run-dir/--resume itself' : "derives these from --base-run-dir's own run-params.json";
    throw new Error(`--mode ${modeRaw} ${owner} -- remove ${conflicts.join(', ')} from the forwarded flags.`);
  }

  return { mode: modeRaw, runs, runDirBase, baseRunDir, printOnly: has('--print-only'), passthrough };
}

// ── orchestration (NOT unit-tested -- see file header; mirrors run.mts's
//    own untested-top-layer precedent) ───────────────────────────────────

function runChild(childArgs: string[], printOnly: boolean): void {
  const runMtsPath = fileURLToPath(new URL('./run.mts', import.meta.url));
  console.log(`  $ bun ${runMtsPath} ${childArgs.join(' ')}`);
  if (printOnly) return;
  const result = spawnSync('bun', [runMtsPath, ...childArgs], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`run.mts exited with code ${result.status ?? '(signal ' + result.signal + ')'} (args: ${childArgs.join(' ')}) -- aborting remaining repeats.`);
  }
}

function report(dirs: string[]): void {
  const result = aggregateRunDirs(dirs);
  if (!result.ok) {
    console.error(`\nRefusing to aggregate: ${result.refuseMessage}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n=== Noise-sample report (${dirs.length} repeats) ===`);
  printMultiRunReport(result.f1);
  printRobustReport(result.robust);

  const outPath = `${dirs[dirs.length - 1]}.noise-report.json`;
  writeFileSync(outPath, JSON.stringify({ run_dirs: dirs, f1: result.f1, robust: result.robust }, null, 2));
  console.log(`\nNoise report -> ${outPath}`);
  console.log('To publish, archive each repeat individually and record the median/range above by hand in docs/eval-runs/LEDGER.md, e.g.:');
  dirs.forEach((dir, i) => console.log(`  bun scripts/eval/locomo/archive-run.mts --run-dir ${dir} --name <slug>-rep${i + 1}`));
}

async function runReingest(runDirBase: string, runs: number, passthrough: string[], printOnly: boolean): Promise<void> {
  const dirs = reingestRunDirs(runDirBase, runs);
  console.log(`reingest mode: ${runs} full run.mts invocations (fresh sample -> ingest -> distill -> answer, each) -> ${dirs.join(', ')}`);
  console.log('Carries BOTH extraction noise (codex service-day variance) AND answerer noise.');
  for (const dir of dirs) {
    console.log(`\n=== repeat -> ${dir} ===`);
    runChild(['--run-dir', dir, ...passthrough], printOnly);
  }
  if (printOnly) { console.log('\n--print-only: nothing executed, no report generated.'); return; }
  report(dirs);
}

async function runReanswer(baseRunDir: string, runs: number, passthrough: string[], printOnly: boolean): Promise<void> {
  const runParamsPath = join(baseRunDir, 'run-params.json');
  if (!existsSync(runParamsPath)) {
    throw new Error(`${runParamsPath} not found -- --base-run-dir must be a run.mts output dir with a completed ingest+distill (run-params.json is written by every run.mts invocation since FEAT-462).`);
  }
  const params = JSON.parse(readFileSync(runParamsPath, 'utf8')) as RunParams;
  const resumeArgs = deriveResumeSamplingArgs(params);

  // rev-e MEDIUM fix: --k is score-affecting and NOT covered by
  // evaluateResumeGuard -- derive it from the base run's own
  // run-manifest.json rather than let it silently fall through to
  // run.mts's own --k default. See deriveResumeAnswererArgs's header for
  // why --answer-concurrency is deliberately NOT derived alongside it.
  const runManifestPath = join(baseRunDir, 'run-manifest.json');
  const runManifestJson = existsSync(runManifestPath) ? JSON.parse(readFileSync(runManifestPath, 'utf8')) : null;
  const { args: answererArgs, warning } = deriveResumeAnswererArgs(runManifestJson, passthrough.includes('--k'));
  if (warning) console.error(`\n${warning}`);

  const snapshotDirs = reanswerSnapshotDirs(baseRunDir, runs);
  console.log(`reanswer mode: ${runs} re-answer-only passes against the SAME store at ${baseRunDir} -> ${snapshotDirs.join(', ')}`);
  console.log('Isolates answerer-only noise (LLM sampling, reranker) at zero extraction cost.');
  for (let i = 0; i < runs; i++) {
    console.log(`\n=== repeat ${i + 1}/${runs}: run.mts --resume ${baseRunDir} ===`);
    runChild(['--resume', baseRunDir, ...resumeArgs, ...answererArgs, ...passthrough], printOnly);
    if (!printOnly) snapshotAnswerOutputs(baseRunDir, snapshotDirs[i]!);
    else console.log(`  (print-only: would snapshot -> ${snapshotDirs[i]})`);
  }
  if (printOnly) { console.log('\n--print-only: nothing executed, no report generated.'); return; }
  report(snapshotDirs);
}

// ── CLI entry ────────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.mode === 'reingest') await runReingest(parsed.runDirBase!, parsed.runs, parsed.passthrough, parsed.printOnly);
    else await runReanswer(parsed.baseRunDir!, parsed.runs, parsed.passthrough, parsed.printOnly);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('\nUsage:');
    console.error('  bun scripts/eval/locomo/repeat-run.mts --mode reingest --runs 3 --run-dir-base <path> [...run.mts flags] [--print-only]');
    console.error('  bun scripts/eval/locomo/repeat-run.mts --mode reanswer --runs 3 --base-run-dir <existing run dir> [...run.mts flags] [--print-only]');
    process.exitCode = 1;
  }
}
