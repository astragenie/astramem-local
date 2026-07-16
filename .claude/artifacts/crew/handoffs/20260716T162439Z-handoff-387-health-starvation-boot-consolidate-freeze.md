# Handoff: issue #387 — boot-time consolidation wedges the daemon, /health starves

- **Objective**: root-cause why `/health` never answers on a daemon that otherwise looks alive (distilling, logging).
- **Owner**: researcher (this investigation), read-only on code, read-only probing on the live daemon.
- **Scope**: `src/service/instance-lock.ts`, `src/cli/serve.ts` boot sequence, `src/pipeline/job-repo.ts`, `src/storage/consolidation-cursor.ts`, live process/log/DB interrogation on `127.0.0.1:7777` / `%LOCALAPPDATA%\Astramem`.
- **Confidence**: high on both findings below — one is corroborated by the repo's own code comments plus the issue's own A/B test; the other is corroborated by a captured crash-log stack trace plus live process telemetry gathered during this session.

## Finding 1 (primary): recovered 'running' consolidate job re-enters the same unbounded synchronous setup on every boot

`src/cli/serve.ts:554-560` already documents the exact freeze class:

> "on a large corpus the consolidate pairwise scan's SETUP (load all valid atoms + group + build per-group embedding maps) is synchronous and unbounded — it can freeze the event loop long enough on boot that the daemon looks dead (2026-07-15)."

The P1.5 fix (`serve.ts:563-579`) delays the **new** boot-pass enqueue by 5 minutes and gates it behind `ASTRA_SKIP_CONSOLIDATE=1`. But that delay/gate only applies to `enqueueConsolidate()` — it does nothing for a job that is **already sitting in the `jobs` table**. `JobRepo.recoverOrphans()` (`src/pipeline/job-repo.ts:123-134`) runs unconditionally at boot, *before* the worker starts and *before* `app.listen()`:

```
UPDATE jobs SET state = 'pending', updated_at = ? WHERE state = 'running'
```

The interrupted knn consolidation run at ~14:45Z (per the issue) left a `consolidate` job in `state = 'running'` when it was killed. Every subsequent boot's `recoverOrphans()` flips that same job straight back to `'pending'` with no distinction for "this job's last attempt froze the event loop." The worker (`startWorker(...)`, `serve.ts:299`, started *before* `app.listen()` at `serve.ts:388`) picks it up on its first poll and re-runs the identical unbounded setup — reproducing the exact same freeze on every restart. `ASTRA_SKIP_CONSOLIDATE=1` "boots healthy in seconds" only because, in that test, there happened to be no such orphaned job sitting in the table at that moment — the env var stops new enqueues, it does not stop the registered `consolidateHandler` (`serve.ts:261`) from executing a job that's already `pending`.

This also explains the issue's own suspect #1 (`consolidation_cursor` / interrupted-run persisted state) without needing the cursor table itself to be corrupt: the *job row*, not the cursor row, is the reproducing mechanism. (`consolidation-cursor.ts`'s single-row table is worth clearing too, but it's not required to explain the reproduction — the orphan-recovery requeue alone is sufficient and is unconditional.)

**Minimal fix shape**: `recoverOrphans()` (or a boot-time check before it) needs to treat a `'running'` **consolidate** job that died mid-handle as suspect, not routine — either skip requeuing it automatically (require an explicit operator re-enqueue), or cap it so a second consecutive freeze poisons/quarantines it rather than requeuing verbatim forever. Longer-term, the setup phase itself needs the same yield/budget treatment `ASTRA_SKIP_CONSOLIDATE`'s own comment says the O(n²) scan already got — issue's ask #2 is correct.

## Finding 2 (compounding): zombie-lock takeover doesn't kill the old holder, causing an EADDRINUSE crash loop

`src/service/instance-lock.ts:344-360` (`acquireInstanceLock`): when the existing lock holder fails 3 `/health` probes, the code logs "treating as zombie and taking over the lock," overwrites the lock file via `writeLock(..., exclusive=false)`, and returns — **it never verifies the old PID actually died, and never signals it** (that logic exists, but only in the separate `stopLockHolder()` export, which the boot path never calls). `serve.ts` then proceeds straight through DB open/migrate to `app.listen()` (`serve.ts:388`).

When the "zombie" is actually still alive — which is precisely today's symptom (process alive, distilling, logging, just `/health`-unresponsive because of Finding 1) — the new process's `listen()` throws. Captured verbatim in `%LOCALAPPDATA%\Astramem\logs\crash.log`:

```
[astramem-local] daemon.lock held by pid 39440 but /health on port 7777 is unresponsive (3 probes) — treating as zombie and taking over the lock.
Error: listen EADDRINUSE: address already in use 127.0.0.1:7777
```

`serve.ts:84-92`'s crash handler catches this, releases the lock, and exits 1. The scheduler's 5-minute keepalive respawns another instance, which repeats the identical misdiagnosis. `%LOCALAPPDATA%\Astramem\logs\exit-history.jsonl` shows dozens of exits between 13:41Z and 16:08Z today, mostly `exitCode:1` at roughly 5-minute cadence — consistent with this loop, not with a single one-off crash.

This is why the daemon has been unable to self-heal for 2.5+ hours even though nothing is permanently wrong with the port or the binary: every restart attempt either (a) hits this EADDRINUSE loop while the truly-wedged process is still up, or (b) — once that process is finally killed (by the watchdog or manually) — boots clean into Finding 1's freeze again.

## Live corroboration gathered this session (2026-07-16, ~16:05–16:25Z)

- `daemon.lock` → `pid 47128`, `startedAt 2026-07-16T16:08:44.901Z`. Process confirmed running (`Get-Process -Id 47128`), command line `node ...\releases\0.19.0-beta.0+cf055eef\dist\cli\index.js serve --port 7777` (no `--strict-preflight`).
- `curl --max-time 5` to both `/health` and `/version` → connection failed (exit 7), and `Test-NetConnection 127.0.0.1:7777` → `TcpTestSucceeded: False`. `Get-NetTCPConnection -OwningProcess 47128` → **no rows** — `app.listen()` has not completed after 15+ minutes of uptime, contradicting the documented "port binds immediately" degraded-start design.
- CPU time for pid 47128 measured twice, 8s apart: **2.953125 → 2.953125 (zero delta)** — the process is blocked/waiting, not computing (rules out a hot CPU-bound loop as what's *currently* stuck; consistent with a blocked native call, held lock, or unresolved await inside the boot path between DB-open and `listen()`).
- `%LOCALAPPDATA%\Astramem\memory.sqlite` could not be opened by an independent `better-sqlite3-multiple-ciphers` probe (same binary the daemon uses) — failed in <100ms with `unable to open database file` (a sharing-violation-class rejection, not a busy-timeout wait). A byte-identical copy of the file opened instantly from the same tool. This proves something currently holds the live file in an incompatible OS-level lock state; by elimination (no other astramem process was found running) that's pid 47128, meaning it *has* progressed past DB-open and is stuck somewhere later in the boot sequence — most likely inside the worker's first job pickup (Finding 1) or a downstream synchronous DB call blocked behind it.
- `%LOCALAPPDATA%\Astramem\watchdog-probe-state.json`'s `consecutiveFailures` incremented live during this investigation (2 → 3, i.e. past `DEFAULT_FAILURE_THRESHOLD = 2` in `src/service/watchdog-probe.ts:81`), while `watchdog-kills.jsonl` shows only one kill all day (08:14Z, unrelated) — corroborating issue #370's "dormant watchdog" finding independently.
- `daemon.live.log`'s last write was at **15:04:14Z**, ~70 minutes stale as of this check, from a since-exited process (pid 49900, not present in the current process list) — the "actively distilling" process from the refined signature has since died (or was killed) entirely; the currently-running 47128 hasn't logged anything to that file yet.

## Suggested validation plan (for whoever takes the fix)

1. Reproduce cleanly: with the daemon stopped, inspect the `jobs` table for a `consolidate` row in `'running'`/`'pending'` state whose age predates 14:45Z today; confirm boot without `ASTRA_SKIP_CONSOLIDATE` reliably freezes with that row present and boots clean once it's deleted/quarantined — isolates Finding 1 from Finding 2.
2. Fix Finding 1 first (it's the actual freeze); Finding 2 is a real bug but only matters once something is genuinely dead vs. wedged — after Finding 1's fix, confirm the zombie-steal path by killing a live daemon with `SIGKILL` and confirming a fresh boot no longer EADDRINUSEs (or, independently, patch `acquireInstanceLock` to call something equivalent to `stopLockHolder` — with its identity-verification guard — before stealing, or to `net.connect`-probe the port before `listen()`).
3. Attach `_debugProcess`/CDP or a stack sampler to a freshly-wedged boot to confirm the exact frame it's parked in before `app.listen()` — this session did not attempt that (out of scope for a read-only investigation of a box other agents are actively operating on), and it would convert Finding 1 from "very well-evidenced" to "directly observed."
4. Once fixed, re-verify `reinstall`'s health gate no longer rolls back (the issue's own symptom: "reinstall health gates roll back").

## Files read (not modified — this investigation was read-only on code)

`src/server/routes/health.ts`, `src/service/instance-lock.ts`, `src/cli/serve.ts`, `src/pipeline/job-repo.ts`, `src/storage/consolidation-cursor.ts`.
