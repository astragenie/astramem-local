/**
 * task-xml.ts — Task Scheduler XML for the daemon task (D1).
 *
 * Why XML instead of `schtasks /create /sc onlogon ...`:
 *  - CLI-created tasks carry a DEFAULT ExecutionTimeLimit of 72 hours —
 *    Task Scheduler silently kills the daemon after 3 days. Only XML can
 *    express PT0S (no limit).
 *  - Only XML can express a logon trigger WITH a repetition interval —
 *    the PT5M repetition is our no-admin watchdog: a healthy daemon makes
 *    the re-run exit in <100ms (single-instance lock), a dead daemon gets
 *    restarted within 5 minutes.
 *  - MultipleInstancesPolicy=IgnoreNew prevents pile-ups if a run is slow.
 *  - StartWhenAvailable=true catches up a missed logon trigger.
 *
 * Issue #370 — repetition arms only at the NEXT logon, not at registration:
 * Task Scheduler only starts a trigger's `<Repetition>` pattern once that
 * trigger itself fires. A `<LogonTrigger>`'s repetition therefore stays
 * completely dormant from the moment of (re)registration until the next
 * interactive logon — a `reinstall` (or `service install`) run mid-session
 * leaves the just-registered task's keepalive/hang-probe repetition dead
 * until the box is next rebooted or the user logs back in, with
 * `LastTaskResult` still reading a healthy `0` the whole time (it simply
 * never runs). Both `AstraMemoryD` (PT5M keepalive) and
 * `AstraMemoryDWatchdog` (hang-probe, schtasks.ts's `installWatchdogTimer`)
 * share this trigger shape and therefore both go dormant on every
 * (re)registration. Fix: add a SECOND trigger — `<TimeTrigger>` with
 * `StartBoundary` set to registration time, carrying the exact same
 * `<Repetition>` block — alongside the `<LogonTrigger>` (not instead of it;
 * the logon trigger still matters for a cold-boot scenario where the task
 * is registered but the box then reboots before the time-trigger's own
 * repetition would have caught up). A `<TimeTrigger>` fires once its
 * `StartBoundary` is reached — effectively immediately at registration — so
 * its `<Repetition>` arms right away with no logon required, and repeats on
 * the same cadence forever after, independent of the logon trigger. A
 * schedule-type switch (`/SC MINUTE`) was considered and rejected: it can
 * only be expressed via the CLI `/create` form, which regresses the
 * ExecutionTimeLimit=PT0S fix above (CLI-created tasks default to 72h).
 */

/** Numeric seconds equivalent of the `repetitionIso` default ('PT5M') used
 *  when `buildTaskXml` registers the main daemon task (schtasks.ts's
 *  `install()`). Exported so the "Task repetition dormancy" doctor canary
 *  (issue #370) can compute a staleness threshold without hand-parsing an
 *  ISO-8601 duration or re-hardcoding 300 as a second source of truth — MUST
 *  stay in sync with the 'PT5M' string literal below if that ever changes. */
export const DEFAULT_REPETITION_SEC = 300;

export interface TaskXmlOpts {
  /** Full command to execute (the stable shim .cmd path). */
  command: string;
  /** Optional arguments string. */
  args?: string;
  /** Working directory for the task. */
  workingDir?: string;
  /** User id for the principal — DOMAIN\user or plain username. */
  userId: string;
  description?: string;
  /**
   * ISO-8601 duration for the Repetition Interval shared by BOTH triggers
   * (LogonTrigger and TimeTrigger, issue #370). Defaults to 'PT5M' (the
   * daemon task's own keepalive tick). The hang-watchdog probe task
   * (schtasks.ts's installWatchdogTimer, issue #206) reuses this exact same
   * dual-trigger-with-repetition mechanism at WATCHDOG_PROBE_INTERVAL_SEC's
   * cadence instead — same proven trigger shape (fires once at logon or at
   * registration time, then repeats indefinitely with no Duration), just a
   * different command and interval.
   */
  repetitionIso?: string;
  /**
   * StartBoundary for the TimeTrigger (issue #370) — local time, no
   * milliseconds/offset, matching the existing CalendarTrigger convention
   * below. Defaults to "now" (formatted via {@link localIsoNow}). Test-only
   * override — production callers should never need to set this; a fixed
   * value here would mean a stale, already-past StartBoundary at every real
   * registration, which Task Scheduler still fires immediately (a past
   * StartBoundary is not an error), so this is a pure determinism seam, not
   * a behavior lever.
   */
  startBoundaryIso?: string;
}

/** Local time, no milliseconds/offset: "YYYY-MM-DDTHH:mm:ss". Matches the
 *  existing CalendarTrigger StartBoundary convention (buildDailyTaskXml,
 *  below) — Task Scheduler XML StartBoundary values throughout this file are
 *  naive local timestamps, never UTC/offset-qualified. */
function localIsoNow(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Daily-trigger variant (backup timer): CalendarTrigger at `startTime`
 * every day. Same Settings block reasons as the daemon task — most
 * importantly registered via XML so it installs without elevation on the
 * same boxes where the CLI form gets "Access is denied".
 */
export function buildDailyTaskXml(opts: TaskXmlOpts & { startTime?: string; description?: string }): string {
  const startTime = opts.startTime ?? '03:00:00';
  const base = buildTaskXml(opts);
  // Replace the WHOLE <Triggers> block (not just <LogonTrigger>) with a
  // single daily calendar trigger. A CalendarTrigger fires on its own
  // schedule boundary regardless of logon state, so it never suffers the
  // dormant-repetition class #370 fixes for LogonTrigger — no TimeTrigger
  // needed here. Replacing only the LogonTrigger element would leave
  // buildTaskXml's now-added <TimeTrigger> behind as an unwanted extra
  // immediate+repeating trigger on this daily task.
  const triggers = `  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-01T${startTime}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>`;
  return base.replace(/  <Triggers>[\s\S]*?<\/Triggers>/, triggers);
}

export function buildTaskXml(opts: TaskXmlOpts): string {
  const description = opts.description ?? 'AstraMemory local memory daemon (astramem-local). Managed by astramem-local service install / reinstall.';
  const repetition = `<Interval>${opts.repetitionIso ?? 'PT5M'}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>`;
  const startBoundary = opts.startBoundaryIso ?? localIsoNow();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(opts.userId)}</UserId>
      <Repetition>
        ${repetition}
      </Repetition>
    </LogonTrigger>
    <TimeTrigger>
      <StartBoundary>${xmlEscape(startBoundary)}</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        ${repetition}
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(opts.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(opts.command)}</Command>${opts.args ? `
      <Arguments>${xmlEscape(opts.args)}</Arguments>` : ''}${opts.workingDir ? `
      <WorkingDirectory>${xmlEscape(opts.workingDir)}</WorkingDirectory>` : ''}
    </Exec>
  </Actions>
</Task>
`;
}
