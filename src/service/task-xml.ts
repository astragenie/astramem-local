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
 */

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
  // Swap the logon trigger for a daily calendar trigger; keep everything else.
  const trigger = `    <CalendarTrigger>
      <StartBoundary>2026-01-01T${startTime}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>`;
  return base.replace(/    <LogonTrigger>[\s\S]*?<\/LogonTrigger>/, trigger);
}

export function buildTaskXml(opts: TaskXmlOpts): string {
  const description = opts.description ?? 'AstraMemory local memory daemon (astramem-local). Managed by astramem-local service install / reinstall.';
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
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
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
