/**
 * task-repetition-dormancy.ts — doctor canary for issue #370.
 *
 * Root cause (see task-xml.ts's header for the fix): a Windows scheduled
 * task's `<LogonTrigger>` repetition only ARMS once the trigger itself
 * fires — i.e. at the next interactive logon. Every (re)registration
 * (`service install`, `init`, or a plain `reinstall` — install-flow.ts's
 * header explains why a plain reinstall re-registers every time) therefore
 * left BOTH `AstraMemoryD` (PT5M keepalive) and `AstraMemoryDWatchdog`
 * (hang-probe) dormant until the next logon/reboot, with `LastTaskResult`
 * still reading a healthy `0` throughout — the task simply never ticks
 * again, so a raw exit-code check can't see the gap at all. Only elapsed
 * time since the last actual tick reveals it (ADR-015 "measure the rate,
 * not existence" rule). task-xml.ts now arms a `<TimeTrigger>` alongside the
 * `<LogonTrigger>` so this should no longer happen on a fixed build — this
 * canary is the operator-facing signal if it ever does again (a config
 * regression, a manual `schtasks /create` outside this codebase, etc.).
 */
import { platform } from 'node:os';
import type { Check, CheckResult } from '../types.js';
import { runCmd, isInconclusiveFailure, TASK_NAME, WATCHDOG_TASK_NAME } from '../../service/schtasks.js';
import { WATCHDOG_PROBE_INTERVAL_SEC } from '../../service/watchdog-probe.js';
import { DEFAULT_REPETITION_SEC } from '../../service/task-xml.js';

/**
 * A registered Astra scheduled task counts as dormant once its Last Run Time
 * is more than this many multiples of its OWN repetition interval in the
 * past. 3x (not 1x) tolerates a single missed/slow tick — a machine under
 * heavy load or briefly asleep — without a false RED; a task that has missed
 * three consecutive ticks is not a fluke.
 */
export const STALE_MULTIPLIER = 3;

export interface TaskDormancyTarget {
  /** Scheduled task name, e.g. 'AstraMemoryD'. Tests target a THROWAWAY task
   *  name here instead of the live AstraMemoryD/AstraMemoryDWatchdog tasks —
   *  this canary must never be exercised against production task state. */
  taskName: string;
  /** The task's own configured repetition interval, in seconds. */
  repetitionSec: number;
}

/** The two real Astra scheduled tasks this canary watches in production —
 *  same task names schtasks.ts actually registers (TASK_NAME/
 *  WATCHDOG_TASK_NAME), same intervals task-xml.ts actually configures
 *  (DEFAULT_REPETITION_SEC/WATCHDOG_PROBE_INTERVAL_SEC) — no duplicated
 *  literals to drift out of sync. */
export function defaultDormancyTargets(): TaskDormancyTarget[] {
  return [
    { taskName: TASK_NAME, repetitionSec: DEFAULT_REPETITION_SEC },
    { taskName: WATCHDOG_TASK_NAME, repetitionSec: WATCHDOG_PROBE_INTERVAL_SEC },
  ];
}

/** Raw `schtasks /query /tn <name> /fo LIST /v` stdout for one task. `/v`
 *  (verbose) is REQUIRED, not cosmetic: live-validated against a real
 *  Windows 11 box (issue #370) — plain `/fo LIST` (the form schtasks.ts's
 *  own `status()` uses, which only ever needs the `Status:` field) omits
 *  `Last Run Time:` entirely on this Task Scheduler version; only `/v`
 *  includes it. Without `/v` this check would silently see `Last Run Time`
 *  as permanently `missing` and never report anything but `inconclusive` in
 *  production — the exact "looks green, verifies nothing" failure ADR-015
 *  exists to catch, caught here by manually registering and querying a real
 *  throwaway task rather than trusting an assumption about `schtasks`'s
 *  output shape. Rejects with the same RunCmdError shape as schtasks.ts's
 *  own queries — callers use isInconclusiveFailure() to tell "task
 *  genuinely not registered" (a fresh box that never ran `service install`,
 *  not this canary's concern) apart from "the query itself could not
 *  complete" (must be inconclusive, never a silent skip). */
async function defaultQueryTask(taskName: string): Promise<string> {
  return runCmd(`schtasks /query /tn "${taskName}" /fo LIST /v`);
}

export type LastRunTimeResult =
  | { kind: 'ok'; date: Date }
  /** Field reads "N/A" — task has never ticked even once. Indistinguishable
   *  from "just registered, TimeTrigger hasn't reached its StartBoundary
   *  yet" (a window of a few seconds), so this must NEVER be treated as
   *  stale — there is no elapsed time to measure. */
  | { kind: 'never-run' }
  /** "Last Run Time:" field absent from the output entirely — unexpected
   *  shape (locale variance, a Task Scheduler version this wasn't tested
   *  against). Must surface as inconclusive, not a silent pass. */
  | { kind: 'missing' }
  /** Field present but `Date.parse` couldn't make sense of it (locale-
   *  dependent date format). Inconclusive, not a silent pass. */
  | { kind: 'unparsable'; raw: string };

/** Parses the "Last Run Time:" field out of `schtasks /query /fo LIST`
 *  output. Pure — no I/O — so it's independently testable against captured
 *  sample output without shelling out. */
export function parseLastRunTime(schtasksOutput: string): LastRunTimeResult {
  const m = schtasksOutput.match(/Last Run Time:\s*(.+)/i);
  if (!m) return { kind: 'missing' };
  const raw = m[1]!.trim();
  if (!raw || /^n\/a$/i.test(raw)) return { kind: 'never-run' };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { kind: 'unparsable', raw };
  return { kind: 'ok', date: new Date(ms) };
}

export function checkTaskRepetitionDormancy(
  targets: TaskDormancyTarget[] = defaultDormancyTargets(),
  staleMultiplier: number = STALE_MULTIPLIER,
  queryTaskImpl: (taskName: string) => Promise<string> = defaultQueryTask,
  nowMsImpl: () => number = Date.now,
  /** Injectable platform seam — tests substitute a fixed value instead of
   *  depending on the CI/dev box's real OS to exercise the win32 branch.
   *  Defaults to node:os's real platform(). */
  platformImpl: () => NodeJS.Platform = platform,
): Check {
  return {
    name: 'Task repetition dormancy',
    // 'full', not 'cheap': each target is a real `schtasks.exe` child-process
    // spawn (node:child_process exec), not a bounded SQLite read or a
    // loopback HTTP probe — the same cost class as gpu-checks.ts's process-
    // listing/nvidia-smi checks (tagged 'full' for the identical reason), not
    // checkDaemonReachable's in-process fetch. Measured directly: running
    // this on the 'cheap' frequent-tier schedule (real 15-min interval in
    // prod, a fast real-timer interval in tests/doctor/schedule.test.ts)
    // made that schedule's own timing assertions reliably flaky — process
    // spawn overhead is not free the way the tier's other members are.
    tier: 'full',
    async run(): Promise<CheckResult> {
      if (platformImpl() !== 'win32') {
        return { ok: true, message: 'task repetition dormancy: not applicable outside win32' };
      }

      const dormant: string[] = [];
      const inconclusive: string[] = [];

      for (const target of targets) {
        let out: string;
        try {
          out = await queryTaskImpl(target.taskName);
        } catch (err) {
          if (isInconclusiveFailure(err)) {
            inconclusive.push(`${target.taskName}: could not query task state (${(err as Error).message})`);
          }
          // Genuinely not registered (schtasks ran to completion and
          // reported "task not found") — not this canary's concern; other
          // checks (service pointer, service unit) cover install state.
          continue;
        }

        const parsed = parseLastRunTime(out);
        if (parsed.kind === 'never-run') {
          continue; // fresh registration — nothing to measure yet, not a bug
        }
        if (parsed.kind === 'missing' || parsed.kind === 'unparsable') {
          inconclusive.push(
            parsed.kind === 'unparsable'
              ? `${target.taskName}: Last Run Time present but unparsable ("${parsed.raw}")`
              : `${target.taskName}: Last Run Time field missing from schtasks output`,
          );
          continue;
        }

        const staleMs = target.repetitionSec * staleMultiplier * 1000;
        const ageMs = nowMsImpl() - parsed.date.getTime();
        if (ageMs > staleMs) {
          dormant.push(
            `${target.taskName}: last ran ${Math.round(ageMs / 60_000)}m ago, repetition is every ` +
            `${Math.round(target.repetitionSec / 60)}m (dormancy threshold ${staleMultiplier}x = ` +
            `${Math.round(staleMs / 60_000)}m) — repetition likely never armed after (re)registration`,
          );
        }
      }

      if (dormant.length > 0) {
        return {
          ok: false,
          message: `task repetition dormancy: ${dormant.join('; ')}` +
            (inconclusive.length > 0 ? ` [also inconclusive: ${inconclusive.join('; ')}]` : ''),
          fix:
            'astramem-local reinstall — re-registers the task with the TimeTrigger fix (issue #370); ' +
            'if already on the fixed build and this still fires, log off/on or reboot once to re-arm, ' +
            'then check for a schtasks failure in daemon-stdout.log.',
        };
      }

      if (inconclusive.length > 0) {
        return { ok: true, inconclusive: true, message: `task repetition dormancy: ${inconclusive.join('; ')}` };
      }

      return { ok: true, message: 'task repetition dormancy: all registered tasks ticking on schedule' };
    },
  };
}
