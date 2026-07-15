# ADR-019: Windows Long-Lived Supervisor Process — Replace PT5M/PT3M schtasks Keepalive + Watchdog

**Status:** Proposed
**Date:** 2026-07-15
**Confidence:** High on the architecture shape (spawn/watch/backoff loop, lock-file reuse, migration
sequencing into `reinstall`). **Low** on the single highest-risk factual claim — that `wscript.exe` +
a generated VBS shim reliably produces a zero-flash hidden launch on all target Windows 10/11
builds and is not blocked by default Windows Defender ASR/SmartScreen policy. That claim is
unverified in this ADR (no web access, no live Windows smoke test from this design session) and is
made the first blocking acceptance criterion of Phase 1, not an assumption baked into the plan.
**Tier:** Large (new long-lived subsystem, cross-cutting into `reinstall`/`install-flow`, retires two
existing scheduled tasks, win32-only — Unix path is explicitly untouched).

## Context

The daemon is kept alive on Windows today by **two** `schtasks` tasks, both `LogonType=InteractiveToken`
and **not** hidden at the process-window level, so each firing pops a visible console window:

- `AstraMemoryD` (`src/service/schtasks.ts` `TASK_NAME`) — action `astramemd.cmd serve --port 7777`,
  XML-registered `LogonTrigger` + `PT5M` `Repetition` (`src/service/task-xml.ts`). A healthy re-run
  fast-exits via `daemon.lock` (`instance-lock.ts`'s `AlreadyRunningError` path, <100ms) but the
  console still flashes every 5 minutes.
- `AstraMemoryDWatchdog` (`WATCHDOG_TASK_NAME`) — action `... service watchdog-probe`, `PT180S`
  (`WATCHDOG_PROBE_INTERVAL_SEC`) repetition, added by issue #206 to close the "alive but wedged"
  gap `watchdog-probe.ts`'s header describes: a held `daemon.lock` is not proof of health, only
  `/health` answering is. Each tick shells out to `stopLockHolder` (`instance-lock.ts`) on failure.

Both are polling-based: a crashed daemon waits up to 5 minutes to restart; a hung one waits up to
~2×180s (two consecutive failures, `DEFAULT_FAILURE_THRESHOLD=2`) before the probe kills it. Both
also flash a console window on every tick regardless of health, because the scheduler launches a
console-subsystem process (`cmd.exe` → `node.exe`) with no window-suppression at any layer.

### Patterns Found

- **Stable shim / immutable pointer** (`src/service/shim.ts`): the scheduler is pointed FOREVER at
  `<dataDir>/bin/astramemd.cmd` → `launch.cjs` → `current.json`. Upgrades rewrite `current.json`
  only; the scheduler registration itself happens exactly once, at first install
  (`install-flow.ts`'s header states this explicitly). `launch.cjs` already owns: reading
  `current.json` fresh on every invocation, `spawnSync`-blocking on the daemon child, capturing
  stdout/stderr to real fds (never `pipe`, to avoid the documented `ENOBUFS`-kills-a-healthy-daemon
  hazard), and appending `{ts, exitCode, durationMs}` to `exit-history.jsonl` (ring-buffered, 50
  entries) plus a rolling 64KB `crash.log` tail. This exit-history mechanism is exactly what
  `src/doctor/checks/crash-loop.ts`'s `checkCrashLoop` (`CRASH_LOOP_THRESHOLD = 3` consecutive
  non-zero exits) already reads — a **doctor canary that requires zero changes** if the supervisor
  keeps writing to the same files in the same shape.
- **Instance lock** (`src/service/instance-lock.ts`): `daemon.lock` under `dataDir` protects the
  data directory (single-writer invariant), not just the port. `acquireInstanceLock` does
  exclusive-create-or-steal with a 3-probe `/health` liveness check before treating a live PID as a
  "zombie" worth stealing from. `stopLockHolder` is the existing **identity-verified, PID-level
  kill** primitive (drift-checked OS process-start-time against the lock's recorded `startedAt`,
  `IDENTITY_TOLERANCE_MS = 60_000`) — built specifically because a scheduler-level stop only reaches
  the launcher process, never the `spawnSync` grandchild it started. This is the exact gap a
  long-lived supervisor closes structurally: **if the supervisor holds the actual `ChildProcess`
  handle it spawned, it never needs PID-recycling identity verification for its own restart
  decisions** — that whole risk category (`identity-unverifiable`/`identity-mismatch` in
  `StopLockHolderResult`) only exists because today's watchdog is a *stateless, one-shot, external*
  process with no memory of which PID it spawned.
- **Hang probe** (`src/service/watchdog-probe.ts`): `runWatchdogProbe` is already a clean,
  side-effect-isolated function — `probeHealth` → on `DEFAULT_FAILURE_THRESHOLD=2` consecutive
  failures → `stopLockHolder` → `adapter.start()`. Its failure-count persistence
  (`watchdog-probe-state.json`) exists ONLY because each invocation is a fresh, memoryless process
  (a scheduler tick) — a long-lived supervisor can hold this count in memory instead, but should
  keep writing the same on-disk shape for anyone still reading it post-migration (doctor doesn't
  today; kept as a compatibility no-cost).
- **`ServiceAdapter`** (`src/service/types.ts`): `install/uninstall/start/stop/status` +
  `installBackupTimer/uninstallBackupTimer`. `hasWatchdogTimer` (`watchdog-probe.ts`) duck-types an
  optional `installWatchdogTimer/uninstallWatchdogTimer` pair that all three adapters implement —
  the exact extension pattern this ADR reuses for the supervisor-migration capability, so plain
  test-mock adapters that don't implement it degrade to a silent no-op rather than throwing.
- **`install-flow.ts`** is the one shared path `service install` / `init` / `reinstall` all funnel
  through: `resolveBuild()` → `writeShim()` → `adapter.install()` → (win32/linux/darwin)
  `installWatchdogTimer()`. This is precisely where the supervisor-vs-watchdog-timer branch belongs.
- **`reinstall.ts`** sequence: resolve config → materialize immutable release → `stopRunningDaemon`
  (via `stopLockHolder`) → `installServiceFlow` (shim + scheduler) → `start` → `waitForHealth` +
  `waitForVersion`, with `restoreOnce()` rolling `current.json` back to the prior pointer AND
  stopping the unverified daemon on ANY post-repoint failure. `--rollback`/`--dev` share
  `repointStopStartVerify`, which deliberately **never** calls `installServiceFlow`/`adapter.install()`
  — task/unit/plist registration happens exactly once, at first install, and this invariant must
  survive the supervisor migration unchanged.
- Windows console-window suppression is genuinely a distinct concern from Task Scheduler's own
  `<Hidden>` setting: `<Hidden>true</Hidden>` in `task-xml.ts` only hides the task from the Task
  Scheduler UI list — it does **not** suppress the console window of the launched process. That is
  a separate, well-known Windows problem (`CREATE_NO_WINDOW` at the `CreateProcess` layer) with no
  `schtasks`-level flag at all. This is why today's `<Hidden>false</Hidden>` is not actually the bug
  — the real gap is that nothing in the launch chain ever asks for `CREATE_NO_WINDOW`.
- Next ADR number confirmed via `docs/adr/*.md` listing (highest existing is ADR-018).

## Decision

Introduce **one long-lived, hidden Node process** (`astramem-local service supervisor`) that owns
the daemon's entire Windows lifecycle: spawn, instant exit-triggered restart with backoff,
continuous in-process `/health` hang detection, and crash-loop reporting via the existing
`exit-history.jsonl` canary. It **retires** `AstraMemoryDWatchdog` entirely and **retires the PT5M
daemon-keepalive semantics** of `AstraMemoryD`, replacing both with a single scheduled task,
`AstraMemorySupervisor`, whose only job is to ensure the supervisor process itself is running.

This is **win32-only**. linux/darwin already have correct, OS-native exit-triggered supervision
(`Restart=on-failure` / `KeepAlive`) plus the FEAT-443 SLICE-2 hang-watchdog timer — nothing on
those platforms changes.

### 1. Who supervises the supervisor

**Decision: ONE schtasks task, `AstraMemorySupervisor`, XML-registered with a `LogonTrigger` +
`PT5M` `Repetition` — structurally identical to today's `AstraMemoryD` registration
(`buildTaskXml`), just retargeted.** Each tick launches the hidden-launch wrapper; the supervisor's
own startup is idempotent via a new `supervisor.lock` (same shape/pattern as `daemon.lock`), so a
healthy re-tick fast-exits in the same sub-100ms style the daemon's `AlreadyRunningError` path does
today. This gives a ≤5-minute recovery bound for the one failure mode that matters here (the
supervisor process itself crashing) — a much rarer event than a daemon crash, since the supervisor's
own loop is small and does no I/O-heavy work (LLM calls, SQLite writes) that could wedge it.

Options considered:

1. **Single logon-trigger task, NO repetition** (fires once at logon only). *Why rejected:* if the
   supervisor dies mid-session (OOM-killed by the OS, a bug, an operator `taskkill`), nothing
   restarts it until the next logon — for a machine that stays logged in for days, that is an
   unbounded recovery window, directly violating the "supervisor crash is itself recovered"
   acceptance criterion.
2. **Logon trigger + PT5M repetition on the SAME task that also runs the supervisor** (chosen).
   Reuses the exact XML shape (`buildTaskXml`) and cadence already proven reliable in production for
   over a year of this repo's history. The console-flash cost that made PT5M expensive in the OLD
   architecture is gone here, because the hidden-launch mechanism (decision 2) means the tick itself
   never shows a window — so there is no longer a reason to prefer a longer interval. PT5M is chosen
   over a shorter interval (e.g. PT1M) because a tighter tick buys negligible extra safety (the
   supervisor-crash case is rare) for no clear benefit, and matches existing, well-understood prior
   art rather than inventing a new interval that would need its own justification.
3. **A SEPARATE second scheduled task** that only checks "is the supervisor alive, if not launch
   it" (mirroring today's split between `AstraMemoryD` and `AstraMemoryDWatchdog`, just repointed at
   the supervisor instead of the daemon). *Why rejected:* functionally equivalent to option 2 but
   with an extra task to register/version/migrate, and an extra hidden-launch-mechanism invocation
   path to verify — pure complexity with no behavioral upside, since a single logon-trigger+
   repetition task can express "run once at logon, then keep checking" in one XML document exactly
   as it does today.
4. **No backstop at all — document that a supervisor crash requires a manual `reinstall` or
   logout/login.** *Why rejected:* explicitly fails one of the ADR's own required acceptance
   criteria; unacceptable for a daemon whose whole reason for existing is "the user should never
   have to think about it."

### 2. Hidden-launch mechanism

**Decision: `wscript.exe` running a generated `.vbs` shim that calls
`WshShell.Run(cmd, 0, false)` (window style `0` = hidden, wait `false` = don't block) — for BOTH
the scheduler's launch of the supervisor AND, as documented fallback reasoning below, is NOT needed
for the supervisor's own spawning of the daemon child, which uses Node's native `windowsHide: true`
`child_process.spawn` option instead (a different, more reliable mechanism available specifically
because the supervisor itself is a Node process).**

Two genuinely different sub-problems, with two different mechanisms:

- **Scheduler → supervisor** (once per logon, or once per ≤5min backstop tick if the supervisor
  died): the scheduler launches a **new, unrelated** process with no Node runtime in the loop yet —
  this needs an OS-level hidden-launch trick. `wscript.exe` + VBS is the choice.
- **Supervisor → daemon child** (every daemon restart — the frequent, latency-sensitive path):
  the supervisor IS already a Node process, so it uses `child_process.spawn(nodeBin, args, {
  windowsHide: true, ... })` directly — `windowsHide` maps straight to the Win32 `CREATE_NO_WINDOW`
  flag, no VBS/PowerShell/AV-policy dependency at all, and is unconditionally reliable across every
  supported Windows version since it's a documented, stable Node API, not an OS shell trick.

This split matters for risk containment: **even in the worst case where the `wscript.exe` mechanism
is blocked by a security policy**, only the rare supervisor-(re)launch is affected — every daemon
restart (crash recovery, hang recovery, `reinstall` repoint) stays windowless regardless, because
that path never touches `wscript.exe` at all.

Options considered for the scheduler→supervisor hop:

1. **`wscript.exe` + generated VBS (`WshShell.Run(cmd, 0, false)`)** (chosen). Ships on every
   Windows install since Windows 98 (no version gate, no feature-flag dependency); the
   `WshShell.Run` hidden-window trick is a decades-old, extremely well-documented pattern
   specifically because it is the ONE mechanism that reliably produces a **zero-flash** launch (not
   "hidden after a brief flash" — genuinely no window is ever created, because `WshShell.Run` calls
   `CreateProcess` with `SW_HIDE` before the child process's first paint). **Named risk (the ADR's
   own low-confidence item):** VBScript launchers are a well-known malware delivery pattern, so some
   hardened environments (Windows Defender Attack Surface Reduction rules, e.g.
   "Block execution of potentially obfuscated scripts," or corporate AppLocker/WDAC policy) may
   block `wscript.exe` from running a script out of a user-writable data directory. This is NOT
   verified against a live target machine in this design session.
2. **`conhost.exe --headless`** (Windows 11 headless-console flag). *Why rejected as primary:*
   genuinely the "correct" modern mechanism if universally available, but this ADR cannot verify
   (no web access) which Windows 11 builds ship it, whether it exists at all on Windows 10 (this
   repo's `CLAUDE.md` targets "Windows 11 Home" for the dev box, but published installs are not
   guaranteed to be Windows 11), and whether its exact CLI contract (`--headless <command>`) is
   stable across the builds it does exist on. Flagged as a candidate future upgrade once verified,
   not the v1 choice, given the version-compatibility uncertainty is the single biggest known-unknown
   in the whole "hidden launch" sub-problem.
3. **`powershell.exe -WindowStyle Hidden -Command "Start-Process ... -WindowStyle Hidden"`**.
   *Why rejected as primary:* widely reported (community forum consensus, not independently
   verified here) to still produce a **brief** visible flash in many configurations, because
   `-WindowStyle Hidden` on `powershell.exe` itself hides the window only after the console host has
   already been created/painted once — the opposite of `WshShell.Run`'s "never create a window at
   all" guarantee. Also carries PowerShell execution-policy dependency risk (`Restricted` policy on
   a locked-down machine can block the whole script) that `wscript.exe`'s file-based VBS invocation
   does not share to the same degree, and adds ~150–400ms of interpreter startup latency versus
   `wscript.exe`'s near-instant start. Kept as the **documented fallback** if `wscript.exe` proves
   blocked (see below) — it is materially better than nothing even with the flash risk, since a
   single flash at logon/backstop-tick is still a massive improvement over the current PT5M/PT3M
   dual-task flashing.
4. **A tiny native/compiled Win32 launcher stub (C, or a signed AutoHotkey-compiled EXE) that calls
   `CreateProcess` with `CREATE_NO_WINDOW` directly.** *Why rejected:* the objectively most robust
   mechanism (no scripting-engine dependency, no AV-heuristic surface at all), but introduces a
   compiled-binary build/signing/distribution problem this pure-TypeScript-and-Node repo has no
   existing precedent or toolchain for (unlike the already-accepted native-binary *dependency*
   pattern of `better-sqlite3-multiple-ciphers`, this would be a native binary this repo itself must
   BUILD and ship, a materially different and heavier commitment). Rejected for v1 as
   disproportionate to the problem; revisit only if both `wscript.exe` and the PowerShell fallback
   prove unreliable in the field.

**Fallback chain, in priority order, decided at install time (not per-tick):**
`installServiceFlow` (or a dedicated smoke-test step) attempts a `wscript.exe`-hidden launch of a
trivial marker command (e.g. writes a marker file and exits) and confirms both (a) the marker file
appears and (b) no window was observed — the second half is not automatable without a live desktop
session, so this is honestly a **best-effort** smoke test that can confirm success but not
definitively rule out a flash; if the `wscript.exe` invocation itself fails outright (exits
non-zero, or `wscript.exe` is missing/blocked by policy — detectable via exit code / exec error),
fall back to the PowerShell-hidden mechanism, logging which mechanism was selected so `doctor`/
`status` can report it.

### 3. Instance-lock interplay

**Decision: the supervisor does NOT hold `daemon.lock` — the daemon child still self-manages
`daemon.lock` exactly as it does today (unchanged `serve.ts` → `acquireInstanceLock` call).** The
supervisor instead:

- Holds a **new, parallel** `supervisor.lock` (same file shape as `daemon.lock`: `{pid, startedAt,
  port, version}`, minus the `/health`-probe liveness check since the supervisor has no HTTP
  surface — a plain `pidAlive()` check is sufficient, mirroring the identity-drift-checked pattern
  in `instance-lock.ts` but generalized to a second lock path). **Recommend generalizing
  `instance-lock.ts`'s `acquireInstanceLock`/`stopLockHolder` to accept a lock-file-path parameter**
  rather than hardcoding `daemon.lock` — the steal-detection, atomic tmp+rename write, and
  PID-identity-drift logic are 100% reusable, only the liveness-probe strategy differs
  (`/health` fetch for `daemon.lock`, `pidAlive()` only for `supervisor.lock`).
- Owns the actual `ChildProcess` handle for the daemon it spawns. This is the load-bearing
  simplification: because the supervisor never loses track of which OS process it started, its own
  restart decisions **never need `stopLockHolder`'s PID-recycling identity verification at all** —
  it calls `child.kill('SIGTERM')` directly against a handle it knows is correct, closing the
  `identity-unverifiable`/`identity-mismatch` risk class entirely for the supervisor's own restart
  path (that risk class still exists and is still needed for `reinstall`'s and a human operator's
  `stopLockHolder` calls, which act on lock files with no live handle — unchanged).
- **Adopt-on-start.** On its own startup (fresh logon, or a backstop-tick relaunch after a
  supervisor crash), the supervisor checks `daemon.lock` FIRST via the existing
  `acquireInstanceLock`-style health probe *before* spawning anything. If a healthy daemon is
  already running (the orphan case below), the supervisor attaches its `/health`-polling loop to
  that PID instead of spawning a duplicate — a duplicate spawn would immediately self-terminate via
  `AlreadyRunningError` anyway, but adopt-on-start avoids the wasted spawn AND correctly resumes
  hang-detection over the pre-existing child, rather than leaving it unsupervised until the next
  crash.
- **Orphan risk, named explicitly:** Windows does not automatically kill child processes when a
  parent dies (no Job Object is used in v1 — see Open Questions). If the supervisor is killed
  ungracefully (not via its own SIGTERM handler, e.g. `taskkill /F`), its daemon child keeps running
  normally, just unsupervised, until the next `AstraMemorySupervisor` backstop tick (≤5 min) adopts
  it via the mechanism above. The child is never broken in this window, only temporarily
  un-babysat — an acceptable v1 trade-off given the `wscript`/PowerShell-scripted stop paths always
  route through the supervisor's own graceful-shutdown handler first (see decision 5), so this gap
  is reserved for genuinely abnormal termination only.
- **`reinstall`'s stop step is broadened**, not narrowed: today's step 3 (`stopRunningDaemon` via
  `stopLockHolder(dataDir, port)`) is retained UNCHANGED as a belt-and-suspenders catch-all (exactly
  today's reasoning: a scheduler-level stop only reaches the launcher, not further descendants — now
  one layer deeper, supervisor→child instead of task→child), but is preceded by a NEW cooperative
  step: signal `supervisor.lock`'s PID first (graceful, bounded wait), giving the supervisor a
  chance to cleanly stop its own child before the existing `stopLockHolder` fallback ever needs to
  fire. Two layers, same "verify identity before touching a PID" discipline at each layer.

### 4. Restart policy

**Decision:**

- **Crash restart (child `exit` event fires):** exponential backoff starting at 1s, doubling each
  consecutive rapid failure, capped at 30s, reset to 1s once the child has stayed up for ≥60s
  (mirrors the well-understood pm2/systemd-style "count only rapid restarts, forgive a long-lived
  run" shape). This satisfies the "<1s restart" acceptance criterion for the common single-crash
  case (first retry has zero backoff — the AC is about detection+first-restart latency, not steady
  -state retry cadence under a genuine crash loop).
- **Hang restart (continuous in-process `/health` probe):** reuses `runWatchdogProbe`'s exact
  threshold (`DEFAULT_FAILURE_THRESHOLD = 2` consecutive failures) and timeout
  (`DEFAULT_PROBE_TIMEOUT_MS = 10_000`) constants — same reasoning already documented in
  `watchdog-probe.ts` for why 2 and not 1. The supervisor's probe loop ticks continuously (e.g.
  every `WATCHDOG_PROBE_INTERVAL_SEC` = 180s still, reused as-is — this constant does not need to
  shrink just because probing moved in-process; the reasoning for 180s was about the daemon's own
  legitimate slow-boot/busy-event-loop windows, not about the probe mechanism's own latency), with
  the failure count held in memory instead of `watchdog-probe-state.json` (no cross-process memory
  loss risk anymore, since the supervisor never restarts between ticks the way a scheduler-tick
  process did). On the 2nd consecutive failure, the supervisor kills its OWN child handle directly
  (no `stopLockHolder` needed — see decision 3) and lets the normal crash-restart path pick it back
  up.
- **Crash-loop cap:** two independent triggers, either one trips the cap — (a) 5 consecutive
  restarts each occurring within <5s of the previous restart (fast/tight loop), or (b) 5 restarts
  within a rolling 10-minute window (slower flapping that never triggers (a) because each individual
  crash is >5s apart but the pattern is still unhealthy). **On trip: back off to a fixed, long
  retry interval (15 minutes — matching doctor's own cheap-tier cadence, an intentional reuse of an
  existing time constant rather than a new invented number) — never give up permanently.** A
  permanent-stop design was considered and rejected: it would reintroduce exactly the "silently
  dead daemon with no auto-recovery" failure this whole ADR exists to close, e.g. a config typo that
  gets fixed by an operator hand-editing `config.yaml` (see CLAUDE.md's "Config reload" section —
  picked up on the daemon's next restart, no live-reload) should eventually self-heal without
  requiring the operator to ALSO remember to run `reinstall`/`service start` again.
- **Reporting:** the supervisor writes to the SAME `exit-history.jsonl` / `crash.log` files, same
  `{ts, exitCode, durationMs}` schema, that `launch.cjs` already writes today (see decision on
  reuse below) — **`src/doctor/checks/crash-loop.ts`'s existing `checkCrashLoop` (threshold=3
  consecutive non-zero exits) requires zero code changes** to keep detecting a crash-looping
  supervised daemon, and (per CLAUDE.md's "Doctor DOES run unattended" section) that check already
  runs on the 15-minute cheap-tier schedule — the crash-loop cap tripping reaches the operator
  through the existing doctor RED path with no new plumbing.
- **Sub-decision — does the supervisor spawn the daemon directly, or reuse the existing stable shim
  (`astramemd.cmd` → `launch.cjs`) asynchronously?** **Decision: reuse the existing shim**, via
  `child_process.spawn(cmdPath, [], { windowsHide: true, stdio: 'ignore' })` (async, not
  `spawnSync` — the supervisor must stay responsive to run its concurrent `/health` polling loop).
  This means `launch.cjs`'s stdio-capture / exit-history-append logic needs **zero changes** — the
  supervisor merely watches the outer `cmd.exe` process's `exit` event, which fires exactly when the
  blocked-on-`spawnSync` `node.exe` grandchild finishes, adding negligible (<50ms) latency versus
  spawning `node.exe` directly. Rejected alternative: have the supervisor absorb `launch.cjs`'s
  responsibilities directly (skip the `cmd.exe` hop entirely) — marginally faster and one fewer
  process layer, but duplicates already-tested logic (`LAUNCHER_SOURCE`) and would make
  `shim.ts`'s cross-platform launcher source serve two different purposes on two different
  platforms (win32-under-supervisor vs. linux/darwin-under-systemd/launchd), adding maintenance
  complexity for a marginal win. Flagged as a legitimate future optimization once the shim-reuse
  design is proven in production, not a v1 requirement.

### 5. Migration

**Decision:** `install-flow.ts`'s win32 branch registers `AstraMemorySupervisor` (via the same
`buildTaskXml` shape, retargeted command) instead of `AstraMemoryD`, and skips
`installWatchdogTimer` entirely (retired). A new, duck-typed adapter capability —
`uninstallLegacyTasks?(): Promise<void>` on `SchtasksAdapter` (mirroring `hasWatchdogTimer`'s
pattern so non-schtasks/mock adapters silently skip it) — removes `AstraMemoryD` and
`AstraMemoryDWatchdog` if present.

**Ordering, to avoid stranding a running daemon mid-switch:**

1. `reinstall` step 3 (unchanged): stop whatever currently holds `daemon.lock` via `stopLockHolder`
   — works identically whether the current holder was launched by the OLD `AstraMemoryD` task or
   (post-migration) the new supervisor's child.
2. `reinstall` step 4, inside `installServiceFlow`: register the NEW `AstraMemorySupervisor` task
   FIRST. Only after that registration is confirmed (`adapter.install()` resolves) does the new
   `uninstallLegacyTasks()` step run, removing `AstraMemoryD`/`AstraMemoryDWatchdog`. This ordering
   guarantees there is never a window with **zero** registered recovery mechanism — worst case
   during a migration reinstall, both the old and new tasks are briefly registered simultaneously
   (harmless: the old `AstraMemoryD` task, if its PT5M tick fires in this narrow window, just
   re-triggers a fast `AlreadyRunningError` no-op exactly like it does today when the daemon is
   already healthy — no new hazard, this race already exists today for any two overlapping
   `reinstall` runs).
3. `reinstall` step 5 (`start`): for the schtasks adapter under the supervisor architecture,
   `adapter.start()`'s meaning narrows to **"ensure the supervisor process is running"** (idempotent
   — a no-op if `supervisor.lock` shows a live, healthy supervisor) rather than today's literal
   "fire a new daemon run." The actual daemon (re)launch with the freshly-repointed
   `current.json` happens **reactively**: step 3 already killed the old child, so the running (or
   just-(re)started) supervisor's own child-`exit` handler notices and respawns using the just-
   updated `current.json` — automatically picking up the new release with no separate "tell the
   supervisor to reload" IPC mechanism needed. This is a documented behavior change worth flagging:
   `steps.push({step:'start-service', ok:true})` now means "supervisor confirmed alive," not
   "daemon confirmed started" — daemon-start confirmation remains step 6's `/health`+`/version`
   check exactly as today, so the accuracy of `reinstall`'s existing step semantics is preserved,
   just the underlying mechanism shifted from "explicit trigger" to "supervisor reacts to the kill
   already performed in step 3."
4. `reinstall --rollback`/`--dev` (`repointStopStartVerify`): **unchanged in structure** — never
   calls `installServiceFlow`/`adapter.install()`, so the supervisor task registration is untouched
   by rollback/dev, exactly preserving the existing "scheduler registered exactly once, at first
   install" invariant. The stop→repoint→start→verify sequence works identically under the new
   architecture per point 3 above (stop kills the child, the already-running supervisor's exit
   handler respawns against the freshly repointed pointer, `start-service`'s narrowed "supervisor
   alive" check is a no-op since it's already running).
5. **First install on a machine with no prior `AstraMemoryD`/`AstraMemoryDWatchdog` at all:**
   identical to today's first-install path, just registering `AstraMemorySupervisor` instead —
   `uninstallLegacyTasks()` is a safe no-op (idempotent delete-if-present, same pattern as
   `uninstallWatchdogTimer` today).

### 6. Unix parity — untouched, win32-only

**Decision: the supervisor abstraction is win32-only.** linux/darwin keep their existing
`systemd`/`launchd` native supervision (`Restart=on-failure`/`KeepAlive`) plus the FEAT-443 SLICE-2
`OnUnitActiveSec`/`StartInterval` hang-watchdog timer, completely unchanged by this ADR.

Options considered:

1. **Win32-only supervisor, Unix untouched** (chosen). The OS already does correct,
   battle-tested exit-triggered supervision on those platforms; there is nothing broken to fix.
2. **Build a unified cross-platform supervisor abstraction, running on all three platforms.**
   *Why rejected:* would mean re-implementing (in userspace, in this repo's own code) functionality
   the OS already provides natively and correctly on linux/darwin — strictly more code, more
   surface for a NEW bug class, for zero behavioral improvement over what SLICE-1/SLICE-2 already
   ship there. This directly contradicts this repo's own architecture verdict
   (`docs/research/20260713-teardown-and-reinvent.md`: "salvage, not rewrite" — replacing a working
   mechanism with a bespoke one is exactly the class of change that verdict warns against).
3. **Also give linux/darwin a userspace supervisor process, layered ON TOP of systemd/launchd's own
   supervision** (a supervisor supervising a service that the init system ALSO supervises).
   *Why rejected:* a redundant third layer of babysitting-the-babysitter, adding a new
   single-point-of-failure process (the userspace supervisor itself) with no offsetting benefit —
   systemd/launchd's own `Restart=`/`KeepAlive` semantics are already the correct exit-triggered
   restart mechanism at the OS level; a userspace layer on top only adds a new thing that can itself
   crash, break, or drift out of sync with the unit file's own restart policy.

### 7. CLI surface

**New entry point:** `astramem-local service supervisor [--port N]` — long-running, blocks forever
until signaled (this is what the `AstraMemorySupervisor` task's hidden-launch wrapper invokes).
Mirrors the existing `service watchdog-probe` verb's argument shape but is a different kind of
command (loops forever vs. single-shot) — kept as a sibling `case` in `src/cli/service.ts`'s
existing switch, not folded into `watchdog-probe` itself.

**Human control, reusing `service stop`:** `service stop`'s existing win32 path (`SchtasksAdapter.stop`,
today `schtasks /end /tn AstraMemoryD`) is extended to, in order: (1) gracefully signal
`supervisor.lock`'s PID with a bounded wait (letting the supervisor cleanly stop its own child
first), (2) unconditionally ALSO run the existing `stopLockHolder(dataDir, port)` against
`daemon.lock` as the belt-and-suspenders catch-all described in decision 3 — identical dual-layer
reasoning `instance-lock.ts` already documents, one layer deeper. `service status` gains a second,
clearly-labeled line reporting supervisor liveness (from `supervisor.lock`) alongside the existing
daemon-liveness line, so an operator can distinguish "supervisor down, daemon orphaned-but-healthy"
from "both down" from "both healthy."

## Build Sequence

| Phase | Files | Change type | Acceptance criteria | Validation command |
|---|---|---|---|---|
| 1 | `src/service/instance-lock.ts` (generalize lock-path param) · `src/service/supervisor-lock.ts` (new, thin wrapper for `supervisor.lock` reusing generalized primitives) · `tests/service/supervisor-lock.test.ts` (new) | modify / add | `acquireInstanceLock`/`stopLockHolder` accept an injectable lock-path; existing `daemon.lock` call sites unchanged (default param preserves current behavior); new `supervisor.lock` acquire/steal/identity-drift behavior unit-tested with the same steal/zombie/stale cases `instance-lock.test.ts` already covers for `daemon.lock` | `bun test tests/service/instance-lock.test.ts tests/service/supervisor-lock.test.ts` |
| 2 | `src/service/hidden-launch.ts` (new — `wscript.exe`+VBS generator, PowerShell fallback, mechanism-selection + smoke test) · `tests/service/hidden-launch.test.ts` (new) | add | **BLOCKING criterion:** live smoke test on a real Windows 10 AND Windows 11 box confirms `wscript.exe` hidden launch produces a genuinely zero-flash window (manual human observation, not automatable) and is not blocked by default Defender ASR rules on either a home and a hardened/corporate-policy machine if available; PowerShell fallback exercised and documented; mechanism selection logged | manual (documented in PR) + `bun test tests/service/hidden-launch.test.ts` (marker-file round-trip, no live-window assertion possible in CI) |
| 3 | `src/service/supervisor.ts` (new — spawn/watch/backoff/hang-probe loop, adopt-on-start, crash-loop cap) · `src/cli/service.ts` (`case 'supervisor'`) · `tests/service/supervisor.test.ts` (new) | add / modify | child spawned via existing stable shim async; instant respawn (<1s) on child exit with exponential backoff (1s→30s cap, reset after 60s uptime); continuous hang probe reuses `DEFAULT_FAILURE_THRESHOLD=2`/`DEFAULT_PROBE_TIMEOUT_MS`; crash-loop cap (5-in-<5s OR 5-in-10min) backs off to 15min retry, never permanent-stops; adopt-on-start verified against a pre-existing healthy `daemon.lock` holder (no duplicate spawn); exit-history.jsonl/crash.log entries land in the same schema/location `launch.cjs` already writes, unit-verified against a stubbed child | `bun test tests/service/supervisor.test.ts` |
| 4 | `src/service/schtasks.ts` (`AstraMemorySupervisor` registration replacing `AstraMemoryD`'s PT5M semantics; `uninstallLegacyTasks()`; `stop()` dual-layer signal) · `src/service/task-xml.ts` (reuse `buildTaskXml`, no change expected — retarget command only) · `tests/service/schtasks.test.ts` (extend) | modify | new task registers via existing XML-first/CLI-fallback tiers unchanged; `uninstallLegacyTasks()` idempotently removes both legacy tasks if present, no-ops if absent; `service stop` signals supervisor then falls back to `stopLockHolder` | `bun test tests/service/schtasks.test.ts` |
| 5 | `src/service/install-flow.ts` (branch: win32 → supervisor task, skip `installWatchdogTimer`; call `uninstallLegacyTasks()` post-registration) · `src/cli/reinstall.ts` (no structural change expected — verify step-5 `start` semantics against the new adapter behavior; add a code comment documenting the narrowed meaning) · `tests/service/install-flow.test.ts` (extend) · `tests/cli/reinstall.test.ts` (extend) | modify | migration ordering (register-new-before-remove-old) verified by test; `reinstall` end-to-end (mocked adapter) confirms no window with zero recovery mechanism registered; `--rollback`/`--dev` paths confirmed to NOT touch scheduler registration (existing invariant re-asserted, not just assumed) | `bun test tests/service/install-flow.test.ts tests/cli/reinstall.test.ts` |
| 6 | `src/doctor/checks/crash-loop.ts` (verify-only, zero-diff expected) · `docs/CLAUDE.md`/service docs (update: two-task keepalive → one supervisor task; document `service supervisor`/`supervisor.lock`) | verify / docs | `checkCrashLoop` confirmed to detect a supervised crash loop with no code change (manual/integration check against Phase 3's exit-history writes) | `bun test tests/doctor/checks/crash-loop.test.ts` (existing suite, unmodified, run against Phase 3 output) |

## Acceptance criteria (Given-When-Then)

1. **Instant crash restart.** Given the supervisor is running with a healthy daemon child, when
   the daemon process exits unexpectedly (crash, `taskkill`), then the supervisor detects the exit
   via its owned `ChildProcess` handle and respawns within <1s (first-retry backoff = 0/near-0),
   with the new PID reflected in a fresh `daemon.lock`.
2. **Hung daemon detected and restarted.** Given a daemon child whose event loop is fully blocked
   (e.g. a synchronous call that never returns), when two consecutive in-process `/health` probes
   (10s timeout each) fail, then the supervisor kills its own child handle directly (no PID-lookup
   delay) and the crash-restart path (AC-1) respawns it.
3. **Zero console windows, steady state.** Given the supervisor and daemon are both running
   healthily, when 30 minutes elapse (covering multiple PT5M backstop ticks and continuous hang
   probes), then no console window is observed at any point (backstop ticks fast-exit via
   `supervisor.lock` before ever reaching a visible launch; hang probes are pure in-process HTTP
   calls with no process spawn at all).
4. **Zero console windows, crash-restart.** Given a daemon crash, when the supervisor respawns it
   via the stable shim, then no console window appears (`windowsHide: true` on the supervisor's own
   `child_process.spawn` call, verified by manual observation during Phase 2/3 testing).
5. **Supervisor crash is itself recovered.** Given the supervisor process is forcibly killed (not
   via graceful `service stop`), when the next `AstraMemorySupervisor` PT5M backstop tick fires
   (≤5 min later), then a new supervisor instance starts, acquires `supervisor.lock`, and
   **adopts** the orphaned-but-still-healthy daemon child (verified via `daemon.lock` health check)
   rather than spawning a duplicate.
6. **Survives logout/login.** Given a fresh logon (no prior supervisor or daemon process alive for
   this session), when the `AstraMemorySupervisor` task's `LogonTrigger` fires, then the supervisor
   starts, finds no existing healthy `daemon.lock` holder, and spawns a fresh daemon — normal cold
   start, no adoption needed.
7. **`reinstall` migrates cleanly.** Given an existing install still running the OLD
   `AstraMemoryD`+`AstraMemoryDWatchdog` two-task architecture, when `reinstall` runs, then (a) the
   running daemon is stopped, (b) `AstraMemorySupervisor` is registered BEFORE the two legacy tasks
   are removed (no window with zero recovery mechanism), (c) the daemon is healthy under the new
   supervisor post-`reinstall`, and (d) a `service status` check afterward shows no trace of the two
   legacy task names (`schtasks /query` for either returns "not found").
8. **`reinstall --rollback` still works.** Given a prior release exists on disk, when
   `reinstall --rollback` runs post-migration, then it repoints `current.json` only (no scheduler
   re-registration, `AstraMemorySupervisor` untouched/still the same single registration from first
   install), the running supervisor's own child-exit-triggered respawn picks up the rolled-back
   pointer, and `/health`+`/version` verify against the target release.

## Open questions / riskiest assumptions

1. **`wscript.exe` hidden-launch reliability is unverified** (this ADR's stated low-confidence
   item) — both "does it truly never flash" and "is it blocked by default/common security policy."
   Phase 2's live smoke test is the actual gate; this ADR's design is deliberately structured so a
   negative result there degrades to the PowerShell fallback (single occasional flash, still far
   better than today) rather than blocking the whole redesign.
2. **`conhost.exe --headless` version-gating is unverified** — flagged as a candidate future
   upgrade over the VBS mechanism, not investigated further here for lack of web access.
3. **No Windows Job Object in v1** — the supervisor cannot guarantee its child dies with it on an
   ungraceful supervisor kill; v1 relies on adopt-on-start (decision 3) to close the gap within one
   backstop-tick window (≤5 min) rather than instantly. A native Job-Object binding (via a small
   native addon or an existing npm wrapper) would close this fully but is out of scope for v1 given
   the native-binary maintenance cost this repo already tracks as a real risk class
   (`better-sqlite3-multiple-ciphers` precedent, ADR-018's same framing). Worth a follow-up ADR if
   the adopt-on-start window proves insufficient in practice.
4. **Crash-loop cap thresholds (5-in-<5s / 5-in-10min / 15min backoff) are proposed, not measured**
   — reasonable defaults grounded in existing constants (`CRASH_LOOP_THRESHOLD=3`'s spirit, doctor's
   15-min cheap-tier cadence) but not load-tested against a real flapping scenario. Flag for
   adjustment once Phase 3 has real-world crash-loop telemetry.
5. **Should `reinstall` bounce the supervisor process itself on every upgrade, or only its child?**
   This ADR's design lets the supervisor's own (older) code stay running indefinitely across
   upgrades — only the daemon child picks up new code via the repointed `current.json`. If a given
   release changes `supervisor.ts` itself, that fix won't take effect until the next logon or a
   supervisor crash/backstop cycle. Recommend the dispatcher decide whether Phase 5 should ALSO
   cooperatively bounce the supervisor on every `reinstall` (simpler mental model: one command
   always yields fully-current code at every layer) versus leaving it as designed here (fewer
   moving parts touched per upgrade, supervisor code changes ship more slowly) — this ADR takes no
   position and flags it as a genuine open trade-off, not a settled sub-decision.

## Consequences

- **Positive:** eliminates all console-window flashing in steady state and on crash-restart
  (subject to open question 1's live verification); sub-second crash recovery (down from up to 5
  min); hang detection latency unchanged (~2×10s probe cycle) but no longer dependent on a
  scheduler tick's own timing jitter; crash-loop reporting reuses 100% of the existing doctor
  canary with zero new plumbing; PID-recycling identity-verification risk is structurally
  eliminated for the supervisor's own restart decisions (though it remains, correctly, for
  external/human-operator stop paths).
- **Negative:** new subsystem (`supervisor.ts`, `hidden-launch.ts`, `supervisor-lock.ts`) is new
  code with new failure modes of its own — most notably the no-Job-Object orphan window (open
  question 3) and the unverified hidden-launch mechanism (open question 1). Migration adds one more
  sequencing-sensitive step to `install-flow.ts`/`reinstall.ts`, an area this repo's own history
  (FEAT-438, the 2026-07-07 stale-dist outage) shows is worth taking seriously.
- **Negative / deferred:** does not unify the Windows and Unix supervision models — an operator or
  future contributor reading this repo's service layer now finds two genuinely different lifecycle
  architectures (win32 supervisor process vs. Unix native init-system supervision), which is the
  deliberate, justified outcome of decision 6, but is worth stating plainly as an asymmetry rather
  than letting it be discovered by surprise.
