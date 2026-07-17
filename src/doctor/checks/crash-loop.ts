import { existsSync, readFileSync } from 'node:fs';
import type { Check, CheckResult } from '../types.js';
import { exitHistoryPaths, type ExitHistoryEntry } from '../../service/shim.js';

// ─── Check: Crash loop (FEAT-440 AC-3/AC-5) ──────────────────────────────────

/**
 * Reads the shim's exit-history.jsonl (see service/shim.ts's
 * exitHistoryPaths()/appendExitHistory in LAUNCHER_SOURCE) and RED-flags a
 * crash loop: >= `threshold` consecutive non-zero exits in the tail of the
 * history. Counting walks backward from the newest entry and stops at the
 * first exitCode === 0 — a clean run (including the instance lock's healthy
 * <100ms fast-exit, AC-5) always resets the streak, distinguished from a
 * real crash purely by exitCode, not durationMs (both exit 0; durationMs is
 * carried in the record for a human/dashboard to eyeball, not used here as
 * a gate).
 */
/**
 * Consecutive-non-zero-exit threshold shared by two independent consumers so
 * they can never drift apart: `checkCrashLoop`'s own RED/GREEN finding below,
 * and the full-tier LLM/embed boot-pass guard in schedule.ts's
 * `runFullDoctorChecks` (2026-07-13 #226 follow-up finding 2 — a
 * crash-looping daemon must not keep firing a metered LLM/embed call on
 * every restart, indefinitely, with no operator in the loop).
 */
export const CRASH_LOOP_THRESHOLD = 3;

/**
 * FEAT-541: self-clear window. A crash-looping daemon restarts every
 * keepalive cycle and never accumulates uptime — but once the CURRENT process
 * has stayed up this long without exiting, it is by definition no longer
 * looping, regardless of how bad the historical tail in exit-history.jsonl
 * looks. Before this fix the streak walk below was purely historical: a
 * daemon that crash-looped once, days ago, and has been rock-solid ever
 * since stayed permanently RED (and kept suppressing `runFullDoctorChecks`'s
 * LLM/embed probes via `crashLoopStreakLength`'s threshold gate in
 * schedule.ts — see this constant's other consumer there) because nothing
 * ever reset the streak short of a clean exit. 15 minutes matches the
 * frequent 'cheap'-tier doctor cadence (`FREQUENT_DOCTOR_INTERVAL_MS` in
 * schedule.ts) — long enough that a flapping restart loop can't accidentally
 * self-clear mid-flap, short enough that a genuinely-recovered daemon isn't
 * stuck RED for a full day waiting on the 'full' tier.
 */
export const CRASH_LOOP_STABLE_UPTIME_MS = 15 * 60 * 1000;

function isStableUptime(uptimeMs: number): boolean {
  return uptimeMs >= CRASH_LOOP_STABLE_UPTIME_MS;
}

/** Real current-process uptime in ms — the default signal for both
 *  `crashLoopStreakLength` and `checkCrashLoop`. Both accept an override so
 *  tests can simulate "been up N minutes" without sleeping or monkeypatching
 *  the global `process` object (which other suites also read). */
function defaultUptimeMs(): number {
  return process.uptime() * 1000;
}

/**
 * Reads + parses exit-history.jsonl and walks back from the newest entry,
 * stopping at the first exitCode === 0. Shared by `crashLoopStreakLength`
 * and `checkCrashLoop` so the parse/walk logic can't drift between the two
 * consumers. Never throws: an unreadable/missing/malformed history degrades
 * to an empty streak.
 */
function readCrashStreak(dataDir: string): { streak: ExitHistoryEntry[]; readError?: unknown } {
  const { historyPath } = exitHistoryPaths(dataDir);
  if (!existsSync(historyPath)) return { streak: [] };

  let entries: ExitHistoryEntry[];
  try {
    entries = readFileSync(historyPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line): ExitHistoryEntry | null => {
        try {
          return JSON.parse(line) as ExitHistoryEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is ExitHistoryEntry => e !== null);
  } catch (err) {
    return { streak: [], readError: err };
  }

  const streak: ExitHistoryEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.exitCode === 0) break;
    streak.unshift(entry);
  }
  return { streak };
}

/**
 * Streak length of consecutive non-zero exits at the tail of
 * exit-history.jsonl — the same walk `checkCrashLoop` performs for its own
 * finding below, factored out so schedule.ts's crash-loop guard can reuse it
 * without depending on `CheckResult`'s shape or duplicating the parse logic.
 * Never throws: an unreadable/missing/malformed history degrades to 0 (no
 * crash loop) — a doctor-history read glitch must never itself become the
 * reason a genuine restart's LLM/embed probe silently never fires again.
 *
 * FEAT-541: decays to 0 once the current process has been up for
 * `CRASH_LOOP_STABLE_UPTIME_MS` — see that constant's doc comment. This is
 * the fix schedule.ts's `runFullDoctorChecks` gate relies on: it calls this
 * function directly, so a stable-uptime daemon naturally un-suppresses the
 * LLM/embed probes without schedule.ts itself changing.
 */
export function crashLoopStreakLength(dataDir: string, uptimeMsOverride?: number): number {
  const uptimeMs = uptimeMsOverride ?? defaultUptimeMs();
  if (isStableUptime(uptimeMs)) return 0;
  const { streak } = readCrashStreak(dataDir);
  return streak.length;
}

export function checkCrashLoop(dataDir: string, threshold = CRASH_LOOP_THRESHOLD, uptimeMsOverride?: number): Check {
  return {
    name: 'Crash loop',
    tier: 'cheap', // bounded fs read + parse of exit-history.jsonl
    async run(): Promise<CheckResult> {
      const uptimeMs = uptimeMsOverride ?? defaultUptimeMs();
      const { historyPath, crashLogPath } = exitHistoryPaths(dataDir);
      if (!existsSync(historyPath)) {
        return { ok: true, message: 'crash loop: no exit history yet' };
      }

      const { streak, readError } = readCrashStreak(dataDir);
      if (readError !== undefined) {
        // Could not read/parse the crash history file — this did NOT verify
        // there's no crash loop, so it must not render/count as if it had.
        return { ok: true, inconclusive: true, message: `crash loop check error (non-fatal): ${readError}` };
      }

      if (streak.length < threshold) {
        return {
          ok: true,
          message: `crash loop: ${streak.length} consecutive non-zero exit(s) (below threshold of ${threshold})`,
        };
      }

      const codes = streak.map(e => e.exitCode).join(', ');
      const first = streak[0]!.ts;
      const last = streak[streak.length - 1]!.ts;

      if (isStableUptime(uptimeMs)) {
        // FEAT-541 self-clear: the historical tail still looks bad, but the
        // CURRENT process has outrun the detection window without exiting —
        // it is not looping right now. Report OK (and un-suppress the
        // LLM/embed probe gate in schedule.ts, which reads
        // crashLoopStreakLength directly) while keeping the history visible
        // for an operator who wants to know it happened.
        const stableMin = Math.round(CRASH_LOOP_STABLE_UPTIME_MS / 60_000);
        const upMin = Math.round(uptimeMs / 60_000);
        return {
          ok: true,
          message:
            `crash loop self-cleared: ${streak.length} consecutive non-zero exits [${codes}] ` +
            `between ${first} and ${last}, but the daemon has been running stably for ${upMin}m ` +
            `(>= ${stableMin}m self-clear window) — treating as recovered`,
        };
      }

      let crashTail = '(crash.log not found)';
      try {
        if (existsSync(crashLogPath)) {
          const raw = readFileSync(crashLogPath, 'utf8');
          crashTail = raw.length > 2000 ? raw.slice(raw.length - 2000) : raw;
        }
      } catch { /* non-fatal — still report the crash-loop finding without the tail */ }

      return {
        ok: false,
        message:
          `crash loop detected: ${streak.length} consecutive non-zero exits [${codes}] ` +
          `between ${first} and ${last}\n--- crash.log tail ---\n${crashTail}`,
        fix: 'Fix the underlying error (see crash.log tail above) and restart the service — ' +
          'a single zero-exit run resets the streak; the next doctor run goes GREEN.',
      };
    },
  };
}
