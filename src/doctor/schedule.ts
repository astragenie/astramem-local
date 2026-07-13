/**
 * Unattended doctor scheduling (Wave A slice A2-lite, ADR-015).
 *
 * `src/cli/serve.ts` never called `runChecks()` — every doctor canary this
 * repo has ever built (including checkMemoryHealth's poison-rate branch
 * added alongside this module) only fired when a human ran
 * `astramem-local doctor` by hand. This module is the fix, split into two
 * deliberately different cadences:
 *
 *  - `runFrequentDoctorChecks` / `startFrequentDoctorSchedule` — cheap,
 *    index-backed DB-only checks. No network, no model call. Safe on a
 *    tight interval.
 *  - `runFullDoctorChecks` — adds the LLM chat probe + embed probe when
 *    `checkOpts.llmProviders`/`embedProvider` are supplied (getChecks() in
 *    checks.ts only registers those checks when those opts are present —
 *    see coreChecks()). This function is deliberately NOT wired to its own
 *    timer here. Callers must piggyback an EXISTING infrequent (>=24h) tick
 *    (serve.ts's cleanup timer) rather than invent a second interval — a
 *    tight interval on a real LLM call is a self-DoS on a shared GPU and,
 *    on a metered endpoint, the FEAT-482 incident class (contradiction
 *    detection shipping `enabled` with no call-count/wall-clock guard fired
 *    ~245 sequential LLM calls and wedged the sole worker lane for 10+
 *    minutes — see CLAUDE.md).
 *
 * `runFrequentDoctorChecks` strips `llmProviders`/`embedProvider` from
 * whatever `checkOpts` it's given, rather than trusting the caller to omit
 * them — a caller that reuses one `checkOpts` object for both tiers (as
 * serve.ts does) must not accidentally fire a real LLM call on the frequent
 * tick because it forgot to build a second, narrower opts object.
 */
import { getChecks, type DoctorCheckOpts } from './checks.js';
import { runChecks, type CheckResultWithName } from './runner.js';

export type DoctorScheduleTier = 'frequent' | 'full';

export interface DoctorScheduleResult {
  tier: DoctorScheduleTier;
  ranAt: number;
  results: CheckResultWithName[];
  failCount: number;
  inconclusiveCount: number;
}

export type DoctorResultSink = (result: DoctorScheduleResult) => void;

/** Cheap-tier cadence: 15 minutes. Every check this tier runs is either a
 *  local index-backed SQLite read or a loopback HTTP probe to the daemon's
 *  own /health — no network call leaves the box, so a 15-minute interval
 *  costs nothing worth tuning against. */
export const FREQUENT_DOCTOR_INTERVAL_MS = 15 * 60 * 1000;

async function runTier(
  tier: DoctorScheduleTier,
  checkOpts: DoctorCheckOpts,
  onResult: DoctorResultSink,
): Promise<DoctorScheduleResult> {
  const results = await runChecks(getChecks(checkOpts));
  const result: DoctorScheduleResult = {
    tier,
    ranAt: Date.now(),
    results,
    failCount: results.filter(r => !r.ok).length,
    inconclusiveCount: results.filter(r => r.inconclusive).length,
  };
  onResult(result);
  return result;
}

/**
 * Cheap DB-only pass. Explicitly clears `llmProviders`/`embedProvider` even
 * if present on the supplied opts — see the module doc comment.
 */
export async function runFrequentDoctorChecks(
  checkOpts: DoctorCheckOpts,
  onResult: DoctorResultSink,
): Promise<DoctorScheduleResult> {
  const frequentOpts: DoctorCheckOpts = { ...checkOpts, llmProviders: undefined, embedProvider: undefined };
  return runTier('frequent', frequentOpts, onResult);
}

/**
 * Full pass — includes the LLM chat probe + embed probe when
 * `checkOpts.llmProviders`/`embedProvider` are supplied. Call this ONLY from
 * an existing infrequent (>=24h) tick; see module doc comment.
 */
export async function runFullDoctorChecks(
  checkOpts: DoctorCheckOpts,
  onResult: DoctorResultSink,
): Promise<DoctorScheduleResult> {
  return runTier('full', checkOpts, onResult);
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
