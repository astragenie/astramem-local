# FEAT-443 — Unix service parity — handoff

**Worktree:** `C:\work\mega\astramemory-local-worktrees\w443` (branch `feat/w443-wave1`)
**Commits:** `94bcec0` (implementation) → `1997d0c` (handoff) → `581cc65` (review fix)

## Review status

`crew:reviewer` pass (`.claude/artifacts/crew/reviews/20260712T161143Z-review-result-feat-443-slice-2-watchdog-probe-review.md`)
returned **REJECTED**: `runWatchdogProbe` ignored `stopResult.ok` and
unconditionally called `adapter.start()` + reported `action:'restarted'` even
when `stopLockHolder` failed to actually stop the hung PID (it never throws on
failure — it returns `{ok:false, ...}`). On systemd, `adapter.start()` is a
silent no-op against an already-"active" unit, so a genuinely-wedged daemon
would get a false `'restarted'` report every ~3 minutes forever — a
false-positive recovery signal from the exact mechanism whose job is honest
hang reporting. Fixed in `581cc65`: skip `adapter.start()` and report
`'restart-failed'` with an honest "NOT restarted" detail when `stopResult.ok`
is false. Added a regression test isolating this exact case. Full suite
re-verified: 294/294 passing. Re-review requested from the same reviewer
agent before merge.

## Scope discovery: SLICE-1 was already done

Before writing anything, `src/service/install-flow.ts` and `src/service/shim.ts`
turned out to already carry FEAT-443 SLICE-1 comments ("ported this from
Windows-only to all three platforms"). `git log --all --grep FEAT-443` confirmed
it: commit `58de236` ("feat(service): release-pinned pointer + rollback for
systemd/launchd (FEAT-443 slice 1) (#139)") is already merged to `main` and was
already in this branch's ancestor history. `reinstall.ts`'s `restorePriorPointer`
doc comment confirms the cross-platform pointer indirection and
`reinstall --rollback` port are both live today — nothing left to do there.

**Only SLICE-2 (hang-watchdog) remained**, and that's what this handoff covers.

## What SLICE-2 builds

`Restart=on-failure` (systemd) and `KeepAlive` (launchd) both only fire when the
daemon **process exits**. A daemon that's alive but wedged (blocked event loop,
deadlocked native call) keeps holding `daemon.lock` and answering nothing — same
blind spot the Windows PT5M keepalive has always had (a healthy-looking re-run
only checks whether the lock is held by a *live* PID, not whether that PID is
*responsive*).

**Design decision — probe+kill, not sd_notify:** the task brief asked for
`WatchdogSec` + `sd_notify`, with a documented fallback to a timer-based re-exec
if raw `NOTIFY_SOCKET` writes aren't feasible without a native dependency. I
verified via `nodejs/node#61933` that Node has **no built-in Unix datagram
socket support** — genuine `sd_notify` from JS would require either a native
addon (`unix-dgram`) or shelling out to the `systemd-notify` CLI **from inside
the daemon's own request-handling loop** (needing edits to `server`/`serve.ts`,
outside the assigned `src/service/*` scope, and with no launchd equivalent at
all). So I implemented the documented fallback for **both** platforms: a
periodic external probe that hits `/health` and force-restarts on failure.

**Recovery mechanism:** reuses `stopLockHolder` (`instance-lock.ts`) — the same
PID-level kill `service stop` already relies on, chosen there specifically
because a scheduler-level stop only reaches the launcher process
(`launch.cjs`), not the `spawnSync` daemon child it started. The probe kills
whatever actually holds `daemon.lock`, then calls `adapter.start()`.

## Files changed

- **`src/service/watchdog-probe.ts`** (new) — `runWatchdogProbe()` (probe +
  recovery, fully injectable: `fetchImpl`, `stopLockHolderImpl`, `adapter`),
  `hasWatchdogTimer()` duck-typing guard, `WATCHDOG_PROBE_INTERVAL_SEC` (180s)
  and `DEFAULT_PROBE_TIMEOUT_MS` (10s) constants.
- **`src/service/systemd.ts`** — `installWatchdogTimer`/`uninstallWatchdogTimer`
  on `SystemdAdapter`: writes a oneshot `astra-memoryd-watchdog.service`
  (`ExecStart=... service watchdog-probe`) + `astra-memoryd-watchdog.timer`
  (`OnUnitActiveSec=180s`, `OnBootSec` capped at 60s for a fast first check).
- **`src/service/launchd.ts`** — same on `LaunchdAdapter`: a
  `com.astragenie.astra-memoryd-watchdog.plist` LaunchAgent with
  `StartInterval` (no `RunAtLoad`/`KeepAlive` — the main agent already covers
  "just booted").
- **`src/service/install-flow.ts`** — calls `installWatchdogTimer` right after
  `adapter.install()`, gated on `result.kind === 'task'` and
  `hasWatchdogTimer(adapter)`; soft-fails (console warning, never throws).
  Registered by default (not opt-in like the backup timer) — consistent with
  Windows' "always-on" PT5M framing.
- **`src/cli/service.ts`** — new `service watchdog-probe [--port N]`
  subcommand (what the timer/agent invokes; safe to run by hand, never exits
  non-zero); `service uninstall` now also removes the watchdog timer when
  present.
- **`CLAUDE.md`** — new "Unix service parity (FEAT-443)" subsection under
  "Service / upgrade" documenting both slices.
- **Tests:** `tests/service/watchdog-probe.test.ts` (new, 10 cases — probe
  healthy/unhealthy/throwing paths, restart-failed never-throws, timeout
  plumbing, `hasWatchdogTimer` guard against plain-object mocks), plus
  extensions to `tests/service/systemd.test.ts`,
  `tests/service/launchd.test.ts` (unit/plist snapshot content + install/
  uninstall idempotency), and `tests/service/install-flow.test.ts` (wiring +
  the Startup-shortcut-fallback skip case).

## Evidence

- `bun run build` (tsc -p .) — clean, no errors.
- `npx vitest run tests/service tests/cli` — **293/293 passed**, 31 test files.
- `npx tsc -p tsconfig.tests.json` — pre-existing baseline errors in unrelated
  files (`distill/`, `doctor/`, `e2e/`, `entity/`, `providers/`, `search/`,
  `server/`, `vector/`) — none touch anything in this diff; looks like the
  known drift FEAT-464 (TS7 + `@types/node` 26 migration) exists to fix.

## What needs live-Unix validation (cannot verify from Windows)

1. **systemd unit/timer syntax** — `OnBootSec`/`OnUnitActiveSec` relative-timer
   semantics and the oneshot-service-triggers-from-timer pairing (implicit
   basename match, same pattern the existing backup timer already uses) are
   textbook systemd, but I have no live systemd host to `systemctl --user
   daemon-reload && systemctl --user start astra-memoryd-watchdog.timer`
   against.
2. **launchd `StartInterval` cadence** — Apple's actual scheduling behavior
   for `StartInterval`-only agents (no `RunAtLoad`) around sleep/wake and
   whether a missed interval while the Mac was asleep fires immediately on
   wake — untestable without real macOS.
3. **SIGTERM delivery to a genuinely-blocked event loop** — `stopLockHolder`
   signals the daemon's own PID (not the launcher), so it isn't blocked by
   `launch.cjs`'s synchronous `spawnSync` the way a scheduler-level stop
   would be. But if the daemon's OWN event loop is fully blocked by
   synchronous JS (not just I/O-bound), its `SIGTERM` handler (`serve.ts`)
   can't run until the loop yields, so this specific hang flavor may not be
   recoverable by this mechanism either. This is a **pre-existing** limitation
   of `stopLockHolder`/`service stop`, not a new gap — flagging it rather than
   expanding scope to a SIGKILL escalation, which wasn't in the FEAT's stated
   ACs.
4. **`systemctl --user`/`launchctl` command availability and permissions** in
   whatever CI/prod Unix environment eventually runs this — the adapters
   already assumed this (pre-existing `SystemdAdapter`/`LaunchdAdapter` code),
   nothing new introduced by this slice.

## Confidence

High on code correctness and test coverage for the pure/injectable logic
(`watchdog-probe.ts`) and the generated unit/plist text (snapshot-asserted).
Medium on live systemd/launchd runtime behavior, per the validation gaps above
— recommend a live-Unix smoke pass (install → let a probe cycle fire → kill
the daemon PID directly → confirm the next probe restarts it within one
interval) before calling this fully proven.

## Suggested next step

Reviewer pass on this diff, then validator/live-Unix smoke test per the gaps
above if a Linux/macOS box is available. Not pushed — local commit only, per
instructions.
