/**
 * Unattended doctor scheduling (Wave A slice A2-lite, ADR-015).
 *
 * `src/cli/serve.ts` never called `runChecks()` — every doctor canary this
 * repo has ever built (including checkMemoryHealth's poison-rate branch
 * added alongside this module) only fired when a human ran
 * `astramem-local doctor` by hand. This module is the fix, split into two
 * deliberately different cadences:
 *
 *  - `runFrequentDoctorChecks` / `startFrequentDoctorSchedule` — selects
 *    exactly the checks declared `tier: 'cheap'` on the `Check` object
 *    itself (see types.ts). Every 'cheap' check is either a local
 *    index-backed SQLite read, a filesystem stat, or a loopback HTTP probe
 *    to the daemon's own /health — no network call leaves the box, no LLM
 *    or embed call ever fires, and no query scans a corpus-scale table
 *    without a covering index. Safe on a tight interval, forever.
 *
 *    #226 (2026-07-13) got this wrong: the frequent tier was defined
 *    NEGATIVELY as "getChecks() minus whatever coreChecks() gates behind
 *    llmProviders/embedProvider" — a definition satisfied by construction,
 *    with no per-check cost judgment behind it. Two checks doing genuine
 *    O(N) full-table scans (checkMemoryHealth, checkEntityNameQuality — and,
 *    per the #226 follow-up audit, checkUsefulnessFeedbackLoop,
 *    checkAtomValidityExtraction, and checkEntityRelations too) rode that
 *    definition straight onto a 15-minute unattended loop. The `tier` field
 *    is now a REQUIRED property on every `Check` (a compile error if a check
 *    author omits it — see types.ts's doc comment) and this module selects
 *    by that field, not by opts shape.
 *
 *  - `runFullDoctorChecks` — runs every check regardless of tier, including
 *    the LLM chat probe + embed probe when `checkOpts.llmProviders`/
 *    `embedProvider` are supplied (getChecks() in checks.ts only registers
 *    those checks when those opts are present — see coreChecks()). This
 *    function is deliberately NOT wired to its own timer here. Callers must
 *    piggyback an EXISTING infrequent (>=24h) tick (serve.ts's cleanup
 *    timer) rather than invent a second interval — a tight interval on a
 *    real LLM call is a self-DoS on a shared GPU and, on a metered endpoint,
 *    the FEAT-482 incident class (contradiction detection shipping `enabled`
 *    with no call-count/wall-clock guard fired ~245 sequential LLM calls and
 *    wedged the sole worker lane for 10+ minutes — see CLAUDE.md).
 *
 *    Crash-loop guard (#226 follow-up finding 2, 2026-07-13): a genuinely
 *    crash-looping daemon restarts on every keepalive cycle (Windows PT5M
 *    schtasks / systemd Restart=on-failure / launchd KeepAlive), and each
 *    restart's boot pass called this function unconditionally — an uncapped,
 *    indefinite, metered LLM+embed call on every cycle with no operator in
 *    the loop, the same incident shape as FEAT-482 just triggered by a crash
 *    loop instead of a config flip. `runFullDoctorChecks` now checks
 *    `crashLoopStreakLength(dataDir)` (checks.ts — the same streak walk
 *    `checkCrashLoop`'s own finding uses) against `CRASH_LOOP_THRESHOLD`
 *    before deciding whether to include `llmProviders`/`embedProvider` in
 *    the opts it runs with. Only the metered LLM/embed portion is skipped —
 *    the rest of the full tier (including `checkCrashLoop` itself, so the
 *    RED finding stays visible) still runs, because those checks are cheap
 *    regardless of crash state and an operator debugging a crash loop still
 *    wants them.
 *
 * `runFrequentDoctorChecks` ALSO strips `llmProviders`/`embedProvider` from
 * whatever `checkOpts` it's given, rather than trusting the tier filter
 * alone — belt-and-braces against a future 'cheap'-tagged check that
 * mistakenly accepts a provider argument it never uses.
 */
import { getChecks, crashLoopStreakLength, CRASH_LOOP_THRESHOLD, type DoctorCheckOpts, type Check } from './checks.js';
import { runChecks, type CheckResultWithName } from './runner.js';

export type DoctorScheduleTier = 'frequent' | 'full';

export interface DoctorScheduleResult {
  tier: DoctorScheduleTier;
  ranAt: number;
  results: CheckResultWithName[];
  failCount: number;
  inconclusiveCount: number;
  /**
   * True when this 'full' run skipped the LLM chat probe + embed probe
   * because the crash-loop streak was already at/above CRASH_LOOP_THRESHOLD
   * (see this module's header comment, finding 2). Always false/absent for
   * a 'frequent' run, which never includes those checks regardless of crash
   * state. Surfaced so a caller (serve.ts's console.warn line) can tell "the
   * LLM/embed probe genuinely passed" apart from "the LLM/embed probe never
   * ran this cycle" — the same ADR-015 "don't let two different states
   * render identically" rule the `inconclusive` field exists for.
   */
  llmTierSkippedForCrashLoop?: boolean;
}

export type DoctorResultSink = (result: DoctorScheduleResult) => void;

/** Cheap-tier cadence: 15 minutes. Every check this tier runs is either a
 *  local index-backed SQLite read or a loopback HTTP probe to the daemon's
 *  own /health — no network call leaves the box, so a 15-minute interval
 *  costs nothing worth tuning against. */
export const FREQUENT_DOCTOR_INTERVAL_MS = 15 * 60 * 1000;

async function runTier(
  tier: DoctorScheduleTier,
  checks: Check[],
  onResult: DoctorResultSink,
  llmTierSkippedForCrashLoop?: boolean,
): Promise<DoctorScheduleResult> {
  const results = await runChecks(checks);
  const result: DoctorScheduleResult = {
    tier,
    ranAt: Date.now(),
    results,
    failCount: results.filter(r => !r.ok).length,
    inconclusiveCount: results.filter(r => r.inconclusive).length,
    ...(llmTierSkippedForCrashLoop ? { llmTierSkippedForCrashLoop: true } : {}),
  };
  onResult(result);
  return result;
}

/**
 * Cheap DB-only pass. Selects exactly the checks declared `tier: 'cheap'`
 * (see this module's header comment) and, belt-and-braces, also clears
 * `llmProviders`/`embedProvider` from the opts before building the check
 * list at all.
 */
export async function runFrequentDoctorChecks(
  checkOpts: DoctorCheckOpts,
  onResult: DoctorResultSink,
): Promise<DoctorScheduleResult> {
  const frequentOpts: DoctorCheckOpts = { ...checkOpts, llmProviders: undefined, embedProvider: undefined };
  const checks = getChecks(frequentOpts).filter(c => c.tier === 'cheap');
  return runTier('frequent', checks, onResult);
}

/**
 * Full pass — every check regardless of tier, including the LLM chat probe +
 * embed probe when `checkOpts.llmProviders`/`embedProvider` are supplied.
 * Call this ONLY from an existing infrequent (>=24h) tick; see module doc
 * comment. Skips the LLM/embed portion (not the rest of the full tier) when
 * the crash-loop streak is already at/above CRASH_LOOP_THRESHOLD — see the
 * module header comment, finding 2.
 */
export async function runFullDoctorChecks(
  checkOpts: DoctorCheckOpts,
  onResult: DoctorResultSink,
): Promise<DoctorScheduleResult> {
  const crashLooping =
    checkOpts.dataDir !== undefined && crashLoopStreakLength(checkOpts.dataDir) >= CRASH_LOOP_THRESHOLD;
  const opts: DoctorCheckOpts = crashLooping
    ? { ...checkOpts, llmProviders: undefined, embedProvider: undefined }
    : checkOpts;
  const checks = getChecks(opts);
  return runTier('full', checks, onResult, crashLooping);
}

/**
 * Starts the frequent (cheap, DB-only) recurring pass: one immediate boot
 * pass (mirrors the consolidate/cleanup/spool-drain boot-pass convention in
 * serve.ts — catches anything a downtime window skipped) plus a recurring
 * timer. Returns a stop() handle; the interval is unref'd so it never holds
 * the process open, matching every other serve.ts timer.
 */
export function startFrequentDoctorSchedule(
  checkOpts: DoctorCheckOpts,
  onResult: DoctorResultSink,
  intervalMs: number = FREQUENT_DOCTOR_INTERVAL_MS,
): () => void {
  const tick = () => {
    void runFrequentDoctorChecks(checkOpts, onResult).catch(() => {
      /* runChecks() already catches per-check errors; this is belt-and-braces
       * against a getChecks() construction error itself — must never throw
       * out of an unref'd timer callback and crash the process. */
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
