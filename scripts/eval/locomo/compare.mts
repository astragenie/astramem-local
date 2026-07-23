/**
 * compare.mts -- the eval significance harness (Wave-4 measurement-trust
 * track directive, 2026-07-23): turns "is this lever real?" from an argued
 * point-estimate into a mechanical yes/no ABOVE the proven ±4-6pt
 * day-variance noise floor (see docs/eval-runs/README.md's "codex
 * day-variance" finding and memory: eval-cheap-stack-only /
 * retrieval-fusion-refuted / extraction-noise-conv26 -- every one of those
 * prior conclusions was reached by eyeballing a single point-estimate delta,
 * which is exactly the failure mode this file exists to close).
 *
 * COMPOSES existing tools, reinvents nothing:
 *   - ./repeat-run.mts       -- shelled out to once per config (its own
 *                               --mode reingest|reanswer N-repeat sampler).
 *                               Ingesting once per config and re-answering N
 *                               times (--mode reanswer against an existing
 *                               --base-run-dir) is the intended, cheap path:
 *                               it fixes extraction noise as a variable and
 *                               isolates answerer/retrieval-lever noise at
 *                               zero re-ingest cost. --mode reingest remains
 *                               available for a lever that changes ingest
 *                               itself (extraction profile/model/passes).
 *   - ./archive-run.mts      -- unchanged publish path; this file prints the
 *                               exact per-repeat archive command, same as
 *                               repeat-run.mts's own footer, rather than
 *                               archiving anything itself (a compare sample
 *                               is not the one-run-dir unit archive-run.mts
 *                               models).
 *   - ./judge.mts            -- reuses its exported `runLlmJudge` (gpt-5-mini,
 *                               the existing CHEAP Azure judge) as an
 *                               additive, non-paired secondary signal per
 *                               config when --llm-judge is passed. Never
 *                               invoked by default.
 *   - ./judge/metrics.mts    -- `scoreHypothesis`/token-F1 is what every
 *                               paired delta below is actually computed
 *                               from (imported transitively via
 *                               ./judge/paired-significance.ts).
 *   - ./judge/robust-stats.ts -- median+range per config, via repeat-run's
 *                               own `aggregateRunDirs` (unmodified).
 *   - ../shared/run-params.ts's `evaluateMultiRunParamsGuard` -- reused
 *     verbatim (not re-implemented) to refuse a comparison across
 *     non-comparable stores (different dataset/seed/n/qaPerSample/shards).
 *
 * The ONLY new statistical logic in this whole feature is
 * ./judge/paired-significance.ts's paired bootstrap test -- see that file's
 * header for the method and why it's paired (same-question pairing removes
 * per-question difficulty variance that an unpaired comparison, e.g.
 * ../../shared/stats.ts's `compareMeans`, cannot).
 *
 * ── What "judge stays cheap" means here ─────────────────────────────────
 * The paired SIGNIFICANCE VERDICT (the thing this file exists to produce)
 * is ALWAYS computed from token-F1 (deterministic, free, matches upstream
 * LoCoMo scoring) -- never from an LLM judge. `--llm-judge` only adds a
 * secondary, NON-PAIRED aggregate signal per config (the existing cheap
 * Azure gpt-5-mini judge, judge.mts's `runLlmJudge`) for extra context; it
 * never feeds the verdict. The gpt-5.4 chain-of-thought judge
 * (oracle/rejudge.mts) is deliberately NOT wired in here -- composing a
 * PAIRED verdict from it would need per-question CoT judge calls on every
 * repeat of every config, i.e. a new metered-call surface, and per this
 * repo's own "Eval cheap-stack only" convention (memory) that needs an
 * explicit separate operator opt-in beyond what this slice was scoped for.
 * Noted as residual risk in the handoff, not silently worked around.
 *
 * ── Stronger answerer (operator-permitted 2026-07-23 for milestones) ────
 * The real (non-oracle) answer path resolves its Azure deployment via
 * ../shared/config.ts's `resolveAzureConfig` -> `AZURE_OPENAI_ANSWERER_DEPLOYMENT`
 * env var (default gpt-5-mini) and its reasoning effort via
 * `ASTRA_LOCOMO_ANSWER_EFFORT` (see ./answer.mts). `ANSWERER_PRESETS` below
 * packages the two Zep-parity points oracle/answerers/{strong,zep-match}.mts
 * already document for the SEPARATE oracle-factorial harness, as env
 * overrides for THIS (real run.mts pipeline) harness instead -- so a
 * compare.mts config can point the real answerer at a stronger deployment
 * without a second parallel harness. Every non-"cheap" preset prints a loud
 * warning (this calls a metered deployment on every repeat) -- there is no
 * default that silently escalates.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 * bun scripts/eval/locomo/compare.mts \
 *   --config-a '{"label":"baseline","mode":"reanswer","baseRunDir":".eval-data/locomo/runs/baseline","passthrough":["--k","15"]}' \
 *   --config-b '{"label":"cross-encoder","mode":"reanswer","baseRunDir":".eval-data/locomo/runs/baseline","passthrough":["--k","15","--cross-encoder"]}' \
 *   --repeats 5 [--llm-judge] [--alpha 0.05] [--bootstrap-iterations 10000] \
 *   [--seed 42] [--out <path>] [--print-only]
 *
 * Config JSON shape: { label: string; mode: "reingest"|"reanswer";
 *   runDirBase?: string (reingest); baseRunDir?: string (reanswer);
 *   passthrough?: string[] (forwarded run.mts flags); env?: Record<string,string> }.
 * --config-a-file/--config-b-file <path.json> load the same shape from disk
 * instead of inline JSON (useful once a config JSON is bigger than a
 * comfortable shell one-liner, especially in PowerShell quoting).
 * --config-a-answerer-preset/--config-b-answerer-preset cheap|gpt-5.4|zep-match
 * merges an ANSWERER_PRESETS env block on top of the JSON config's own env
 * (explicit config.env keys win over the preset on conflict).
 *
 * Pointing both configs' `baseRunDir` at the SAME already-ingested store
 * (`--mode reanswer` both sides) is the intended, cheapest way to A/B a
 * pure answerer/retrieval lever -- extraction never re-runs, and the guard
 * below still applies (both sides trivially agree on run-params.json since
 * they derive it from the identical base dir).
 *
 * --print-only is a full side-effect-free dry run: prints both resolved
 * repeat-run.mts child commands and their expected run dirs, spawns
 * nothing, reads no hypotheses files, writes no report. This is the ONLY
 * mode this slice was built/tested against -- a real invocation launches
 * two potentially-expensive repeat-run.mts children and is intentionally
 * left for an operator to run deliberately, never from inside this build.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reingestRunDirs, reanswerSnapshotDirs, aggregateRunDirs } from './repeat-run.mts';
import { runLlmJudge } from './judge.mts';
import {
  printMultiRunReport, combineMetricsReports, type MetricsReport, type MultiRunMetricsReport,
} from './judge/metrics.mts';
import { printRobustReport, type MultiRunRobustReport } from './judge/robust-stats.js';
import {
  scorePerQuestionAcrossRuns, pairDeltas, decidePairedSignificance, decidePairedSignificanceByCategory,
  formatVerdict, type SignificanceResult, type SignificanceOptions,
} from './judge/paired-significance.js';
import { evaluateMultiRunParamsGuard } from '../shared/run-params.js';
import { LOCOMO_CATEGORIES, CATEGORY_NAMES, type LoCoMoCategory, type HypothesisRecord, type LoCoMoSample } from './lib/types.js';

/** A significance verdict computed from fewer repeats per side is always
 *  INCONCLUSIVE by construction (see ./judge/paired-significance.ts's
 *  `minRepeats`) -- refuse to even launch the runs below this, rather than
 *  spend a real repeat-run.mts invocation on a comparison that can only
 *  ever report INCONCLUSIVE. Deliberately higher than repeat-run.mts's own
 *  `--runs >= 2` floor (a bare spread is not the same bar as a trustworthy
 *  per-question mean going into a paired test). */
export const MIN_REPEATS = 3;

/**
 * Env overrides for the real (non-oracle) answer path's Azure deployment,
 * packaging the same two Zep-parity points oracle/answerers/strong.mts and
 * zep-match.mts document for the oracle-factorial harness -- see this
 * file's header. `cheap` is the empty override (the shipped default,
 * gpt-5-mini/minimal effort) and is always safe/free to select explicitly.
 */
export const ANSWERER_PRESETS: Record<string, Record<string, string>> = {
  cheap: {},
  'gpt-5.4': { AZURE_OPENAI_ANSWERER_DEPLOYMENT: 'gpt-5.4' },
  'zep-match': { AZURE_OPENAI_ANSWERER_DEPLOYMENT: 'gpt-5.4', ASTRA_LOCOMO_ANSWER_EFFORT: 'medium' },
};

export interface CompareConfig {
  label: string;
  mode: 'reingest' | 'reanswer';
  runDirBase?: string;
  baseRunDir?: string;
  passthrough?: string[];
  env?: Record<string, string>;
}

export interface CompareOptions {
  /** Repeats per config, forwarded to repeat-run.mts's own --runs. Must be
   *  >= MIN_REPEATS -- see that constant's doc comment. */
  repeats: number;
  /** Opt-in secondary, non-paired cheap Azure LLM-judge pass per config
   *  (judge.mts's runLlmJudge, gpt-5-mini) -- never feeds the verdict. */
  llmJudge?: boolean;
  alpha?: number;
  bootstrapIterations?: number;
  seed?: number;
  printOnly?: boolean;
  /** Output report path. Defaults to a name derived from configA's last
   *  run dir + configB's label (mirrors repeat-run.mts's own
   *  `<last-run-dir>.noise-report.json` sibling-file convention). */
  out?: string;
}

// ── pure helpers (unit-tested; no child process, no daemon, no network) ────

/** The run dirs repeat-run.mts's OWN invocation will actually write to --
 *  reuses its exported naming helpers rather than re-deriving the
 *  `-rep<N>`/`-reanswer<N>` suffix convention. NOT what compare() returns/
 *  reads back (see expectedRunDirs below) -- this is repeat-run.mts's
 *  naming, keyed ONLY off runDirBase/baseRunDir with no notion of "which
 *  config produced it." */
export function rawRepeatRunDirs(config: CompareConfig, repeats: number): string[] {
  if (config.mode === 'reingest') {
    if (!config.runDirBase) throw new Error(`config "${config.label}": mode "reingest" requires "runDirBase".`);
    return reingestRunDirs(config.runDirBase, repeats);
  }
  if (!config.baseRunDir) throw new Error(`config "${config.label}": mode "reanswer" requires "baseRunDir".`);
  return reanswerSnapshotDirs(config.baseRunDir, repeats);
}

/**
 * The FINAL run dirs compare() guarantees for this config -- rawRepeatRunDirs
 * with a config-label-scoped `-cmp-<slug>` suffix appended.
 *
 * Why this can't just be rawRepeatRunDirs: compare.mts's own intended
 * cheapest use case is pointing BOTH configs' `--mode reanswer` at the SAME
 * already-ingested `baseRunDir` (see this file's header -- "the intended,
 * cheapest way to A/B a pure answerer/retrieval lever"), but
 * reanswerSnapshotDirs's naming is `${baseRunDir}-reanswer<N>`, keyed only
 * off baseRunDir -- config B's repeat-run.mts invocation would silently
 * overwrite config A's snapshots the moment both share a base dir, the
 * EXACT "looks fully successful, silently wrong" failure class
 * evaluateResumeGuard/evaluateMultiRunParamsGuard exist to prevent
 * elsewhere in this harness (../shared/run-params.ts). runConfig() below
 * renames repeat-run.mts's raw output into this scoped location
 * immediately after each config's invocation finishes, so the two configs'
 * results can never collide on disk even when they share every other
 * setting.
 */
export function expectedRunDirs(config: CompareConfig, repeats: number): string[] {
  return rawRepeatRunDirs(config, repeats).map(dir => `${dir}-cmp-${slugify(config.label)}`);
}

/** The exact argv repeat-run.mts should be invoked with for this config --
 *  pure so the child-invocation shape is independently checkable in a test
 *  without actually spawning anything. */
export function repeatRunArgsFor(config: CompareConfig, repeats: number): string[] {
  const args: string[] = ['--mode', config.mode];
  if (config.mode === 'reingest') {
    if (!config.runDirBase) throw new Error(`config "${config.label}": mode "reingest" requires "runDirBase".`);
    args.push('--run-dir-base', config.runDirBase);
  } else {
    if (!config.baseRunDir) throw new Error(`config "${config.label}": mode "reanswer" requires "baseRunDir".`);
    args.push('--base-run-dir', config.baseRunDir);
  }
  args.push('--runs', String(repeats), ...(config.passthrough ?? []));
  return args;
}

/** kebab-cases a config label for use in a filename/archive slug (mirrors
 *  archive-run.mts's own `--name` slug shape, `/^[a-z0-9][a-z0-9-]*$/`). */
export function slugify(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'config';
}

export interface ComparisonReport {
  generated_at: string;
  configA: { label: string; mode: string; env: Record<string, string> };
  configB: { label: string; mode: string; env: Record<string, string> };
  repeats: number;
  dirsA: string[];
  dirsB: string[];
  f1A: MultiRunMetricsReport;
  robustA: MultiRunRobustReport;
  f1B: MultiRunMetricsReport;
  robustB: MultiRunRobustReport;
  pairedQuestions: number;
  onlyInA: number;
  onlyInB: number;
  overall: SignificanceResult;
  byCategory: Record<LoCoMoCategory, SignificanceResult>;
  llmJudgeA?: MultiRunMetricsReport;
  llmJudgeB?: MultiRunMetricsReport;
}

/** Pure assembly of the final report object -- no I/O, so the shape is
 *  independently checkable in a test from fabricated fixtures. */
export function buildComparisonReport(input: {
  configA: CompareConfig; configB: CompareConfig; repeats: number;
  dirsA: string[]; dirsB: string[];
  f1A: MultiRunMetricsReport; robustA: MultiRunRobustReport;
  f1B: MultiRunMetricsReport; robustB: MultiRunRobustReport;
  pairedQuestions: number; onlyInA: number; onlyInB: number;
  overall: SignificanceResult; byCategory: Record<LoCoMoCategory, SignificanceResult>;
  llmJudgeA?: MultiRunMetricsReport; llmJudgeB?: MultiRunMetricsReport;
}): ComparisonReport {
  return {
    generated_at: new Date().toISOString(),
    configA: { label: input.configA.label, mode: input.configA.mode, env: input.configA.env ?? {} },
    configB: { label: input.configB.label, mode: input.configB.mode, env: input.configB.env ?? {} },
    repeats: input.repeats,
    dirsA: input.dirsA, dirsB: input.dirsB,
    f1A: input.f1A, robustA: input.robustA, f1B: input.f1B, robustB: input.robustB,
    pairedQuestions: input.pairedQuestions, onlyInA: input.onlyInA, onlyInB: input.onlyInB,
    overall: input.overall, byCategory: input.byCategory,
    ...(input.llmJudgeA ? { llmJudgeA: input.llmJudgeA } : {}),
    ...(input.llmJudgeB ? { llmJudgeB: input.llmJudgeB } : {}),
  };
}

function parseJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}

async function scoreLlmJudgeDir(dir: string): Promise<MetricsReport> {
  const hypotheses = parseJsonl<HypothesisRecord>(join(dir, 'hypotheses.jsonl'));
  const references = JSON.parse(readFileSync(join(dir, 'sample.json'), 'utf8')) as LoCoMoSample[];
  return runLlmJudge(hypotheses, references);
}

// ── CLI arg parsing (pure; no I/O beyond an explicit --config-*-file read) ─

function loadConfig(args: string[], side: 'a' | 'b'): CompareConfig {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const inline = get(`--config-${side}`);
  const filePath = get(`--config-${side}-file`);
  if (inline !== undefined && filePath !== undefined) {
    throw new Error(`--config-${side} and --config-${side}-file are mutually exclusive -- pass exactly one.`);
  }
  if (inline === undefined && filePath === undefined) {
    throw new Error(`--config-${side} <json> or --config-${side}-file <path.json> is required.`);
  }
  const raw = inline ?? readFileSync(filePath!, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--config-${side}${filePath ? '-file' : ''}: invalid JSON -- ${(err as Error).message}`);
  }
  const cfg = parsed as Partial<CompareConfig>;
  if (typeof cfg.label !== 'string' || cfg.label.length === 0) {
    throw new Error(`--config-${side}: "label" (non-empty string) is required.`);
  }
  if (cfg.mode !== 'reingest' && cfg.mode !== 'reanswer') {
    throw new Error(`--config-${side}: "mode" must be "reingest" or "reanswer", got ${JSON.stringify(cfg.mode)}.`);
  }
  if (cfg.mode === 'reingest' && !cfg.runDirBase) {
    throw new Error(`--config-${side}: mode "reingest" requires "runDirBase".`);
  }
  if (cfg.mode === 'reanswer' && !cfg.baseRunDir) {
    throw new Error(`--config-${side}: mode "reanswer" requires "baseRunDir".`);
  }

  let env = { ...(cfg.env ?? {}) };
  const presetFlag = get(`--config-${side}-answerer-preset`);
  if (presetFlag !== undefined) {
    const preset = ANSWERER_PRESETS[presetFlag];
    if (!preset) {
      throw new Error(`--config-${side}-answerer-preset: unknown preset "${presetFlag}" -- known presets: ${Object.keys(ANSWERER_PRESETS).join(', ')}.`);
    }
    if (presetFlag !== 'cheap') {
      console.error(
        `WARNING: config "${cfg.label}" uses answerer preset "${presetFlag}" -- every repeat calls a METERED stronger Azure deployment. `
        + `Confirm this comparison was explicitly operator-approved (memory: eval-cheap-stack-only) before running for real.`,
      );
    }
    env = { ...preset, ...env }; // explicit config.env keys win over the preset on conflict
  }

  return {
    label: cfg.label,
    mode: cfg.mode,
    runDirBase: cfg.runDirBase,
    baseRunDir: cfg.baseRunDir,
    passthrough: cfg.passthrough ?? [],
    env,
  };
}

export interface ParsedCompareArgs {
  configA: CompareConfig;
  configB: CompareConfig;
  options: CompareOptions;
}

export function parseCompareArgs(args: string[]): ParsedCompareArgs {
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const configA = loadConfig(args, 'a');
  const configB = loadConfig(args, 'b');

  const repeatsRaw = get('--repeats') ?? String(MIN_REPEATS);
  const repeats = Number(repeatsRaw);
  if (!Number.isInteger(repeats) || repeats < MIN_REPEATS) {
    throw new Error(`--repeats must be an integer >= ${MIN_REPEATS} (fewer repeats per side can only ever resolve to INCONCLUSIVE -- see MIN_REPEATS), got: ${repeatsRaw}`);
  }

  const alphaRaw = get('--alpha');
  const alpha = alphaRaw !== undefined ? Number(alphaRaw) : undefined;
  if (alpha !== undefined && (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1)) {
    throw new Error(`--alpha must be a number in (0, 1), got: ${alphaRaw}`);
  }
  const iterRaw = get('--bootstrap-iterations');
  const bootstrapIterations = iterRaw !== undefined ? Number(iterRaw) : undefined;
  if (bootstrapIterations !== undefined && (!Number.isInteger(bootstrapIterations) || bootstrapIterations < 1)) {
    throw new Error(`--bootstrap-iterations must be a positive integer, got: ${iterRaw}`);
  }
  const seedRaw = get('--seed');
  const seed = seedRaw !== undefined ? Number(seedRaw) : undefined;
  if (seed !== undefined && !Number.isFinite(seed)) {
    throw new Error(`--seed must be a number, got: ${seedRaw}`);
  }

  return {
    configA,
    configB,
    options: { repeats, llmJudge: has('--llm-judge'), alpha, bootstrapIterations, seed, printOnly: has('--print-only'), out: get('--out') },
  };
}

// ── orchestration (NOT unit-tested when it actually spawns a child -- see
//    file header and repeat-run.mts's own untested-top-layer precedent;
//    the --print-only branch never spawns anything and IS covered by a
//    test) ───────────────────────────────────────────────────────────────

function runConfig(config: CompareConfig, repeats: number, printOnly: boolean): string[] {
  const repeatRunPath = fileURLToPath(new URL('./repeat-run.mts', import.meta.url));
  const args = repeatRunArgsFor(config, repeats);
  const rawDirs = rawRepeatRunDirs(config, repeats);
  const finalDirs = expectedRunDirs(config, repeats);

  console.log(`\n=== config "${config.label}" (${config.mode}) ===`);
  console.log(`  $ bun ${repeatRunPath} ${args.join(' ')}`);
  if (Object.keys(config.env ?? {}).length > 0) console.log(`  env overrides: ${JSON.stringify(config.env)}`);

  if (printOnly) {
    console.log(`  (print-only: would produce -> ${rawDirs.join(', ')}, then rename each -> ${finalDirs.join(', ')})`);
    return finalDirs;
  }

  const result = spawnSync('bun', [repeatRunPath, ...args], { stdio: 'inherit', env: { ...process.env, ...(config.env ?? {}) } });
  if (result.status !== 0) {
    throw new Error(`repeat-run.mts (config "${config.label}") exited with code ${result.status ?? '(signal ' + result.signal + ')'} -- aborting the comparison.`);
  }

  // Collision guard (see expectedRunDirs's header): repeat-run.mts just
  // wrote rawDirs using its OWN naming, which two configs sharing a
  // baseRunDir/mode would otherwise collide on. Claim this config's result
  // immediately by renaming into its scoped final location -- re-running
  // the SAME config overwrites only its own prior result (rmSync first),
  // mirroring archive-run.mts's own idempotent-per-name semantics.
  for (let i = 0; i < rawDirs.length; i++) {
    if (existsSync(finalDirs[i]!)) rmSync(finalDirs[i]!, { recursive: true, force: true });
    renameSync(rawDirs[i]!, finalDirs[i]!);
  }
  return finalDirs;
}

/**
 * compare(configA, configB, options) -- the entrypoint. Runs (or, under
 * --print-only, only prints the plan for) N>=MIN_REPEATS repeats of each
 * config via repeat-run.mts, then:
 *   1. refuses via evaluateMultiRunParamsGuard if the two sides aren't
 *      comparable (different dataset/seed/n/qaPerSample/shards);
 *   2. reports each side's own mean±stdev / median±range via repeat-run's
 *      aggregateRunDirs (unmodified);
 *   3. computes the paired per-question bootstrap significance verdict,
 *      overall and per category;
 *   4. optionally adds a non-paired cheap-Azure llm-judge signal per side;
 *   5. writes a JSON report and prints the archive-run.mts commands to
 *      publish either side.
 */
export async function compare(
  configA: CompareConfig,
  configB: CompareConfig,
  options: CompareOptions,
): Promise<ComparisonReport | { printOnly: true; dirsA: string[]; dirsB: string[] }> {
  if (!Number.isInteger(options.repeats) || options.repeats < MIN_REPEATS) {
    throw new Error(
      `compare(): options.repeats must be an integer >= ${MIN_REPEATS} -- a paired verdict computed from fewer repeats per `
      + `side can only ever report INCONCLUSIVE, so this refuses before launching anything. Got: ${options.repeats}`,
    );
  }

  const printOnly = options.printOnly ?? false;
  console.log(`compare: "${configA.label}" vs "${configB.label}" (${options.repeats} repeats each, ${printOnly ? 'PRINT-ONLY' : 'LIVE'})`);

  const dirsA = runConfig(configA, options.repeats, printOnly);
  const dirsB = runConfig(configB, options.repeats, printOnly);

  if (printOnly) {
    console.log('\n--print-only: nothing executed, no report generated.');
    return { printOnly: true, dirsA, dirsB };
  }

  const guard = evaluateMultiRunParamsGuard([...dirsA, ...dirsB]);
  if (guard.action === 'refuse') {
    throw new Error(`compare(): refusing to compare non-comparable stores -- ${guard.refuseMessage}`);
  }

  const aggA = aggregateRunDirs(dirsA);
  if (!aggA.ok) throw new Error(`compare(): config "${configA.label}": ${aggA.refuseMessage}`);
  const aggB = aggregateRunDirs(dirsB);
  if (!aggB.ok) throw new Error(`compare(): config "${configB.label}": ${aggB.refuseMessage}`);

  const scoresA = scorePerQuestionAcrossRuns(dirsA);
  const scoresB = scorePerQuestionAcrossRuns(dirsB);
  const { paired, onlyInA, onlyInB } = pairDeltas(scoresA, scoresB);
  if (onlyInA > 0 || onlyInB > 0) {
    console.warn(`compare: ${onlyInA} question(s) answered only by "${configA.label}", ${onlyInB} only by "${configB.label}" -- excluded from the paired comparison.`);
  }

  const sigOpts: SignificanceOptions = {
    repeatsA: dirsA.length, repeatsB: dirsB.length, minRepeats: MIN_REPEATS,
    iterations: options.bootstrapIterations, alpha: options.alpha, seed: options.seed,
  };
  const overall = decidePairedSignificance(paired, sigOpts);
  const byCategory = decidePairedSignificanceByCategory(paired, sigOpts);

  console.log(`\n=== "${configA.label}" ===`);
  printMultiRunReport(aggA.f1);
  printRobustReport(aggA.robust);
  console.log(`\n=== "${configB.label}" ===`);
  printMultiRunReport(aggB.f1);
  printRobustReport(aggB.robust);

  console.log(`\n=== Paired significance: "${configA.label}" vs "${configB.label}" (n=${paired.length} shared questions) ===`);
  console.log(`Overall: ${formatVerdict(overall)}`);
  for (const c of LOCOMO_CATEGORIES) {
    console.log(`  ${c} (${CATEGORY_NAMES[c]}): ${formatVerdict(byCategory[c])}`);
  }

  let llmJudgeA: MultiRunMetricsReport | undefined;
  let llmJudgeB: MultiRunMetricsReport | undefined;
  if (options.llmJudge) {
    console.log(`\nRunning cheap Azure LLM-judge secondary pass (gpt-5-mini, non-paired, additive only -- does not feed the verdict above)...`);
    llmJudgeA = combineMetricsReports(await Promise.all(dirsA.map(scoreLlmJudgeDir)));
    llmJudgeB = combineMetricsReports(await Promise.all(dirsB.map(scoreLlmJudgeDir)));
    console.log(`\n"${configA.label}" llm-judge:`);
    printMultiRunReport(llmJudgeA);
    console.log(`\n"${configB.label}" llm-judge:`);
    printMultiRunReport(llmJudgeB);
  }

  const report = buildComparisonReport({
    configA, configB, repeats: options.repeats, dirsA, dirsB,
    f1A: aggA.f1, robustA: aggA.robust, f1B: aggB.f1, robustB: aggB.robust,
    pairedQuestions: paired.length, onlyInA, onlyInB, overall, byCategory, llmJudgeA, llmJudgeB,
  });

  const outPath = options.out ?? `${dirsA[dirsA.length - 1]}.compare-vs-${slugify(configB.label)}.json`;
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nCompare report -> ${outPath}`);
  console.log('To publish either side, archive each repeat individually, e.g.:');
  dirsA.forEach((dir, i) => console.log(`  bun scripts/eval/locomo/archive-run.mts --run-dir ${dir} --name ${slugify(configA.label)}-rep${i + 1}`));
  dirsB.forEach((dir, i) => console.log(`  bun scripts/eval/locomo/archive-run.mts --run-dir ${dir} --name ${slugify(configB.label)}-rep${i + 1}`));

  return report;
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
    const { configA, configB, options } = parseCompareArgs(process.argv.slice(2));
    await compare(configA, configB, options);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('\nUsage:');
    console.error('  bun scripts/eval/locomo/compare.mts --config-a <json> --config-b <json> --repeats 3');
    console.error('    [--llm-judge] [--alpha 0.05] [--bootstrap-iterations 10000] [--seed 42] [--out <path>] [--print-only]');
    console.error('  Config JSON: {"label":"...", "mode":"reanswer"|"reingest", "baseRunDir"|"runDirBase":"...", "passthrough":["--k","15"], "env":{}}');
    console.error('  --config-a-file/--config-b-file <path.json> load the same shape from disk instead of inline JSON.');
    console.error('  --config-a-answerer-preset/--config-b-answerer-preset cheap|gpt-5.4|zep-match merge a preset env on top of the JSON config\'s own env.');
    process.exitCode = 1;
  }
}
