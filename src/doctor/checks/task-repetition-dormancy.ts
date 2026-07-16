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
 *
 * Query mechanism — PowerShell, not `schtasks /fo LIST /v` text parsing
 * (PR #379 review): the first cut of this canary parsed schtasks' free-text
 * `Last Run Time:` field with `Date.parse`. That field's format is
 * LOCALE-DEPENDENT (`M/D/YYYY h:mm:ss AM/PM` on en-US) — on a DD/MM-locale
 * box, a date where both day and month are <=12 parses SUCCESSFULLY but to
 * the WRONG instant, producing a wrong-but-plausible `ageMs` that can land
 * either side of the staleness threshold. A false GREEN from a wrong-but-
 * successful parse is strictly worse than a loud failure — it silently
 * masks the exact dormancy this canary exists to catch (ADR-015, one level
 * deeper than the usual "existence vs rate" case: here the RATE math itself
 * is corrupted by an ambiguous input, not just unmeasured). This box is
 * en-US, so live-validating the original schtasks-based version could never
 * have surfaced this. Fixed by switching to `Get-ScheduledTaskInfo`, whose
 * `.LastRunTime` is a real `[DateTime]`, formatted here via `.ToString('o')`
 * (.NET's round-trip format — ALWAYS `yyyy-MM-ddTHH:mm:ss.fffffffZ` in UTC,
 * regardless of the box's locale) — the same approach used to diagnose the
 * live incident this issue describes. `Get-ScheduledTask`'s trigger
 * `Repetition.Interval` is read in the same call so the canary compares a
 * task against its OWN live-configured interval rather than a value this
 * file assumes (see `liveRepetitionSec` below).
 */
import { platform } from 'node:os';
import type { Check, CheckResult } from '../types.js';
import { runCmd, isInconclusiveFailure, TASK_NAME, WATCHDOG_TASK_NAME } from '../../service/schtasks.js';
import { WATCHDOG_PROBE_INTERVAL_SEC } from '../../service/watchdog-probe.js';
import { DEFAULT_REPETITION_SEC, parseSimpleIso8601DurationSeconds } from '../../service/task-xml.js';

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
  /** FALLBACK repetition interval, in seconds, used only when the live task
   *  query can't produce one (task has no repeating trigger configured, or
   *  `RepetitionIso` came back unparsable) — see `liveRepetitionSec` on
   *  {@link TaskQueryResult}. The live-queried value is always preferred
   *  when available (PR #379 review: don't trust a mirrored constant when
   *  the live task's own config is one PowerShell call away). */
  repetitionSec: number;
}

/** The two real Astra scheduled tasks this canary watches in production —
 *  same task names schtasks.ts actually registers (TASK_NAME/
 *  WATCHDOG_TASK_NAME), same FALLBACK intervals task-xml.ts actually
 *  configures by default (DEFAULT_REPETITION_SEC/WATCHDOG_PROBE_INTERVAL_SEC)
 *  — no duplicated literals to drift out of sync. The live task's own
 *  configured interval is preferred at query time; these are only the
 *  fallback. */
export function defaultDormancyTargets(): TaskDormancyTarget[] {
  return [
    { taskName: TASK_NAME, repetitionSec: DEFAULT_REPETITION_SEC },
    { taskName: WATCHDOG_TASK_NAME, repetitionSec: WATCHDOG_PROBE_INTERVAL_SEC },
  ];
}

/** PowerShell single-quoted string escape: double an embedded `'`. Task
 *  names are ours ('AstraMemoryD' etc. or a test's throwaway literal), never
 *  untrusted input, but escaping costs nothing and avoids a broken query on
 *  any future task name containing an apostrophe. */
function psQuote(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Combined `Get-ScheduledTaskInfo` + `Get-ScheduledTask` query for one task,
 * emitted as compact JSON: `{"LastRunTime": "<'o'-format UTC string>" |
 * null, "RepetitionIso": "<ISO-8601 duration>" | null}`. `LastRunTime` is
 * `null` when the task has never run.
 *
 * "Never run" sentinel — live-validated against a real Windows 11 box,
 * corrected before merge: the FIRST cut of this checked `-eq
 * [datetime]::MinValue` (`0001-01-01`), which is wrong. Task Scheduler's
 * `GetLastRunTime` is a legacy COM API wrapped by `Get-ScheduledTaskInfo`,
 * and its actual "never run" sentinel is `1999-11-30` (a well-known Task
 * Scheduler artifact, unrelated to .NET's own `DateTime.MinValue`).
 * Registering a real throwaway task and querying it immediately (before its
 * first tick) reproduced `LastRunTime = 1999-11-30T06:00:00.0000000Z` —
 * the `MinValue` check let it through as a real "ok" timestamp, which
 * `checkTaskRepetitionDormancy` then reported as "last ran 14 million
 * minutes ago" (a confident, wrong, maximally-alarming false RED — the
 * opposite failure direction from the locale bug this file's header
 * describes, equally dangerous). Fixed by checking `.Year -le 1999` instead
 * of an exact sentinel match — robust to any Task-Scheduler-version
 * variant of "never run" landing anywhere at or before that year, rather
 * than pinning to one exact legacy timestamp. `RepetitionIso` is read from
 * the first trigger
 * that has a `Repetition.Interval` set — our own `buildTaskXml` (task-
 * xml.ts) always gives the LogonTrigger and TimeTrigger the SAME interval,
 * so "first configured" is unambiguous for any task this codebase
 * registers; `null` when no trigger has one configured. Rejects with the
 * same RunCmdError shape as schtasks.ts's own queries — callers use
 * isInconclusiveFailure() to tell "task genuinely not registered" (a fresh
 * box that never ran `service install`, not this canary's concern) apart
 * from "the query itself could not complete" (must be inconclusive, never a
 * silent skip); `-ErrorAction Stop` makes a missing task a real non-zero
 * exit with no signal, landing in the same "genuinely not registered"
 * bucket schtasks.exe's own "cannot find the file specified" always did.
 */
async function defaultQueryTask(taskName: string): Promise<string> {
  const name = psQuote(taskName);
  const script =
    `$ErrorActionPreference = 'Stop'; ` +
    `$info = Get-ScheduledTaskInfo -TaskName '${name}'; ` +
    `$task = Get-ScheduledTask -TaskName '${name}'; ` +
    `$rep = ($task.Triggers | Where-Object { $_.Repetition -and $_.Repetition.Interval } | Select-Object -First 1).Repetition.Interval; ` +
    `$lastRun = if ($info.LastRunTime.Year -le 1999) { $null } else { $info.LastRunTime.ToUniversalTime().ToString('o') }; ` +
    `[PSCustomObject]@{ LastRunTime = $lastRun; RepetitionIso = $rep } | ConvertTo-Json -Compress`;
  return runCmd(`powershell -NoProfile -NonInteractive -Command "${script}"`);
}

export type LastRunTimeResult =
  | { kind: 'ok'; date: Date }
  /** Task has never ticked even once (`LastRunTime` was Task Scheduler's
   *  legacy "never run" sentinel, `<=1999`). Indistinguishable from "just
   *  registered, TimeTrigger hasn't reached its StartBoundary yet" (a
   *  window of a few seconds), so this must NEVER be treated as stale —
   *  there is no elapsed time to measure. */
  | { kind: 'never-run' }
  /** Query output was empty or not valid JSON — unexpected shape (a
   *  PowerShell edition difference, an unhandled error message on stdout).
   *  Must surface as inconclusive, not a silent pass. */
  | { kind: 'missing' }
  /** `LastRunTime` was present but didn't match the strict `'o'`-format UTC
   *  shape PowerShell always emits for a real timestamp — surfaced as
   *  inconclusive rather than guessed at with a lenient parser. This is the
   *  fix for the locale hazard described in this file's header: an
   *  ambiguous-looking value is REJECTED, never silently misinterpreted. */
  | { kind: 'unparsable'; raw: string };

export interface TaskQueryResult {
  lastRunTime: LastRunTimeResult;
  /** Repetition interval read from the LIVE task's own trigger config, in
   *  seconds. `null` when the task has no repeating trigger configured, the
   *  query output didn't include a usable `RepetitionIso`, or that value
   *  didn't parse — callers fall back to the target's own `repetitionSec`
   *  in that case (see {@link TaskDormancyTarget}). */
  liveRepetitionSec: number | null;
}

/** Strict `.NET` round-trip ('o') format for a UTC `DateTime`:
 *  `yyyy-MM-ddTHH:mm:ss[.fffffff]Z`. Deliberately NOT `Date.parse` on the
 *  raw string — an explicit capture-group regex plus `Date.UTC(...)` means
 *  there is no engine-dependent leniency and no possibility of a locale- or
 *  format-dependent misread; a string that doesn't match this shape is
 *  rejected outright rather than guessed at. */
const ISO_UTC_O_FORMAT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

function parseIsoUtcO(raw: string): Date | null {
  const m = raw.match(ISO_UTC_O_FORMAT);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  // .NET's 'o' format can carry up to 7 fractional digits (100ns ticks);
  // truncate to JS Date's 3-digit millisecond precision rather than relying
  // on any particular engine's tolerance for extra digits.
  const ms = frac ? Math.round(Number(`0.${frac.slice(0, 7)}`) * 1000) : 0;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms));
}

/** Non-throwing wrapper around task-xml.ts's `parseSimpleIso8601DurationSeconds`
 *  for untrusted/live input — the live task's `RepetitionIso` is real
 *  PowerShell output, not one of this codebase's own controlled literals, so
 *  an out-of-support-subset duration (e.g. one with a days component) must
 *  degrade to "use the fallback constant instead", never throw. */
function tryParseLiveRepetitionSec(iso: string | null): number | null {
  if (!iso) return null;
  try {
    return parseSimpleIso8601DurationSeconds(iso);
  } catch {
    return null;
  }
}

interface RawTaskQueryJson {
  LastRunTime: string | null;
  RepetitionIso: string | null;
}

/** Parses the combined JSON blob {@link defaultQueryTask} emits. Pure — no
 *  I/O — so it's independently testable against captured sample output
 *  without shelling out to PowerShell. */
export function parseTaskQueryOutput(raw: string): TaskQueryResult {
  const trimmed = raw.trim();
  if (!trimmed) return { lastRunTime: { kind: 'missing' }, liveRepetitionSec: null };

  let parsed: RawTaskQueryJson;
  try {
    parsed = JSON.parse(trimmed) as RawTaskQueryJson;
  } catch {
    return { lastRunTime: { kind: 'unparsable', raw: trimmed }, liveRepetitionSec: null };
  }

  let lastRunTime: LastRunTimeResult;
  if (parsed.LastRunTime == null) {
    lastRunTime = { kind: 'never-run' };
  } else {
    const date = parseIsoUtcO(parsed.LastRunTime);
    lastRunTime = date ? { kind: 'ok', date } : { kind: 'unparsable', raw: parsed.LastRunTime };
  }

  return { lastRunTime, liveRepetitionSec: tryParseLiveRepetitionSec(parsed.RepetitionIso) };
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
    // 'full', not 'cheap': each target is a real PowerShell child-process
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

      // Each target is an independent OS process spawn (~1s+ measured
      // PowerShell cold-start on a real box — see defaultQueryTask's doc
      // comment) — running targets sequentially made a 2-target doctor pass
      // take 2+ seconds and reliably blew past this repo's full-tier test
      // timeouts once combined with the rest of a doctor run. There is no
      // ordering dependency between targets, so fire all queries
      // concurrently and only serialize the (cheap, synchronous) result
      // processing below — cuts wall-clock roughly in half for the common
      // 2-target case and scales the same way for any future target count.
      const outcomes = await Promise.all(
        targets.map(async (target): Promise<{ target: TaskDormancyTarget; dormantMsg?: string; inconclusiveMsg?: string }> => {
          let out: string;
          try {
            out = await queryTaskImpl(target.taskName);
          } catch (err) {
            if (isInconclusiveFailure(err)) {
              return { target, inconclusiveMsg: `${target.taskName}: could not query task state (${(err as Error).message})` };
            }
            // Genuinely not registered (query ran to completion and reported
            // "task not found") — not this canary's concern; other checks
            // (service pointer, service unit) cover install state.
            return { target };
          }

          const { lastRunTime, liveRepetitionSec } = parseTaskQueryOutput(out);
          if (lastRunTime.kind === 'never-run') {
            return { target }; // fresh registration — nothing to measure yet, not a bug
          }
          if (lastRunTime.kind === 'missing' || lastRunTime.kind === 'unparsable') {
            return {
              target,
              inconclusiveMsg: lastRunTime.kind === 'unparsable'
                ? `${target.taskName}: Last Run Time present but unparsable ("${lastRunTime.raw}")`
                : `${target.taskName}: query output missing/unreadable`,
            };
          }

          const repetitionSec = liveRepetitionSec ?? target.repetitionSec;
          const staleMs = repetitionSec * staleMultiplier * 1000;
          const ageMs = nowMsImpl() - lastRunTime.date.getTime();
          if (ageMs > staleMs) {
            return {
              target,
              dormantMsg:
                `${target.taskName}: last ran ${Math.round(ageMs / 60_000)}m ago, repetition is every ` +
                `${Math.round(repetitionSec / 60)}m${liveRepetitionSec == null ? ' (fallback default — live interval unavailable)' : ''} ` +
                `(dormancy threshold ${staleMultiplier}x = ${Math.round(staleMs / 60_000)}m) — repetition likely never ` +
                `armed after (re)registration`,
            };
          }
          return { target };
        }),
      );

      // Preserve `targets`' own order in the final message regardless of
      // which concurrent query resolved first.
      const dormant = outcomes.map(o => o.dormantMsg).filter((m): m is string => m != null);
      const inconclusive = outcomes.map(o => o.inconclusiveMsg).filter((m): m is string => m != null);

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
