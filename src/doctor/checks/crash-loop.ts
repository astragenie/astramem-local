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
 * Streak length of consecutive non-zero exits at the tail of
 * exit-history.jsonl — the same walk `checkCrashLoop` performs for its own
 * finding below, factored out so schedule.ts's crash-loop guard can reuse it
 * without depending on `CheckResult`'s shape or duplicating the parse logic.
 * Never throws: an unreadable/missing/malformed history degrades to 0 (no
 * crash loop) — a doctor-history read glitch must never itself become the
 * reason a genuine restart's LLM/embed probe silently never fires again.
 */
export function crashLoopStreakLength(dataDir: string): number {
  const { historyPath } = exitHistoryPaths(dataDir);
  if (!existsSync(historyPath)) return 0;

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
  } catch {
    return 0;
  }

  let streak = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.exitCode === 0) break;
    streak++;
  }
  return streak;
}

export function checkCrashLoop(dataDir: string, threshold = CRASH_LOOP_THRESHOLD): Check {
  return {
    name: 'Crash loop',
    tier: 'cheap', // bounded fs read + parse of exit-history.jsonl
    async run(): Promise<CheckResult> {
      const { historyPath, crashLogPath } = exitHistoryPaths(dataDir);
      if (!existsSync(historyPath)) {
        return { ok: true, message: 'crash loop: no exit history yet' };
      }

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
        // Could not read/parse the crash history file — this did NOT verify
        // there's no crash loop, so it must not render/count as if it had.
        return { ok: true, inconclusive: true, message: `crash loop check error (non-fatal): ${err}` };
      }

      if (entries.length === 0) {
        return { ok: true, message: 'crash loop: no exit history yet' };
      }

      const streak: ExitHistoryEntry[] = [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.exitCode === 0) break;
        streak.unshift(entry);
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
