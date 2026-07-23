/**
 * Full-suite (n=1986, "the REAL number") dev-loop entry point (Track E
 * measurement-overhaul directive, 2026-07-23). Every published conv-1
 * number in docs/eval-runs/LEDGER.md is a 199-QA, single-conversation 10%
 * SAMPLE (n=199, see docs/eval-runs/README.md's "two scales" caveat) --
 * fast to iterate on, but explicitly NOT the number that gets published
 * without a full-sample reconfirm (measurement rule #2 in that same
 * README). Composing the full-suite command by hand means remembering
 * ~7 tuned-baseline flags (docs/eval-runs/BASELINE-CONSTANTS.md) every
 * time -- this thin wrapper bakes them in as defaults, override-able per
 * flag, and always PRINTS the exact resolved command before running it
 * (never silently assumes).
 *
 * The tuned defaults below mirror BASELINE-CONSTANTS.md as of 2026-07-19 +
 * the 2026-07-13 full-suite precedent's own "Reproduce" section
 * (docs/research/20260713-locomo-full-suite-result.md) -- re-verify
 * against both before trusting this file's defaults are still current;
 * the baseline recipe keeps tuning (CLAUDE.md's citation-drift caution
 * applies here same as anywhere else in this harness).
 *
 * bun scripts/eval/locomo/full-suite.mts [--run-dir <path>] [--print-only]
 *   [...any run.mts flag -- overrides a default below by flag NAME, e.g.
 *    --k 10 replaces the tuned k=15; --shards 2 is forwarded verbatim
 *    since this recipe deliberately doesn't default one, see below]
 *
 * Omitting --n/--qa-per-sample (this wrapper never sets either) is what
 * makes this the full suite -- sample.mts's own default is "load the whole
 * dataset" (10 conversations, 1986 QA pairs total), not a subset; passing
 * --n yourself defeats the point of using this entry point at all.
 *
 * --shards is deliberately NOT defaulted: the 2026-07-13 precedent ran
 * single-shard (2h02m wall clock, serial). BASELINE-CONSTANTS.md's
 * chunkConcurrency=3 tuning ("~15-18 calls/min... under the 20/min client
 * limit") was measured for ONE codex daemon; sharding multiplies that call
 * rate by the shard count against the SAME codex-subscription quota, and
 * that combination has not been validated. Pass --shards yourself only
 * with that risk in mind, and watch for 429s.
 *
 * Composes with ./repeat-run.mts's `--mode reingest` for a full-suite NOISE
 * sample (multi-day median+spread, see that file's header) -- pass this
 * file's resolved args (shown by --print-only, below) as repeat-run.mts's
 * passthrough. Expect hours per repeat; this file does not gate that
 * decision, it only removes the "did I remember every tuned flag" risk
 * once an operator commits to paying for it. NOT executed as part of the
 * change that added this file -- see the build directive: "Do NOT execute
 * a full-suite run now (hours + shared GPU) -- build + unit-test the
 * harness only."
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Tuned full-suite recipe, [flag, value] pairs -- see file header for
 *  provenance and the deliberate --n/--qa-per-sample/--shards omissions. */
export const FULL_SUITE_DEFAULT_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ['--extract-profile', 'conversational'],
  ['--extraction-provider', 'codex-subscription'],
  ['--extraction-model', 'gpt-5.4-mini'],
  ['--compaction-mode', 'never'],
  ['--k', '15'],
  ['--seed', '42'],
  // 2h headroom: the 2026-07-13 precedent measured ~80min distill serially
  // on an earlier (untuned) recipe. Raise further if a --shards override
  // doesn't shrink wall clock the way it should.
  ['--distill-timeout-ms', String(2 * 60 * 60_000)],
];

/**
 * Merges FULL_SUITE_DEFAULT_FLAGS with caller-supplied args: any `--flag`
 * in `extraArgs` that also names one of the defaults REPLACES it (by flag
 * name, not by array order -- removed from the emitted defaults, kept only
 * from extraArgs, never duplicated); every other extraArg not naming a
 * default (e.g. --shards, --run-dir, --cross-encoder, --diagnose) is
 * appended verbatim. Pure -- no I/O, no process spawn, unit-tested without
 * either.
 */
export function buildFullSuiteArgs(extraArgs: string[]): string[] {
  const overridden = new Set(extraArgs.filter(a => FULL_SUITE_DEFAULT_FLAGS.some(([flag]) => flag === a)));
  const resolvedDefaults = FULL_SUITE_DEFAULT_FLAGS.filter(([flag]) => !overridden.has(flag)).flat();
  return [...resolvedDefaults, ...extraArgs];
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const printOnly = args.includes('--print-only');
  const forwarded = args.filter(a => a !== '--print-only');
  const resolved = buildFullSuiteArgs(forwarded);
  const runMtsPath = fileURLToPath(new URL('./run.mts', import.meta.url));

  console.log('Full-suite (n=1986, no --n/--qa-per-sample cap) resolved command:');
  console.log(`  bun ${runMtsPath} ${resolved.join(' ')}`);
  if (printOnly) {
    console.log('\n--print-only: nothing executed.');
  } else {
    const result = spawnSync('bun', [runMtsPath, ...resolved], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  }
}
