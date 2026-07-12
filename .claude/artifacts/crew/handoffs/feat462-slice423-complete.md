# SLICE-423 / FEAT-462 slice B — detached execution + PID/port manifest

## Objective
Implement AC-2 (`--detach` detached execution with a pollable status file)
and AC-3 (shard-daemon PID/port manifest for scoped kill) for both eval
harnesses, entirely inside `C:\work\mega\astramemory-local-worktrees\w462b`,
branch `feat/feat-462b-detach`. Slice A (resume ledger, run-params guard,
fake-eval-daemon fixture) was already merged to this branch's base (main
v0.13.0) before this slice started.

## Owner
Solo builder pass (dispatched directly by the team lead, no separate
reviewer/validator dispatch in this run).

## Scope
- Allowed: `scripts/eval/**` only.
- Forbidden (respected): main checkout, sibling worktree `w457s1`, `src/`,
  any production daemon code.

## Deliverable — branch / commit
- Branch: `feat/feat-462b-detach` (unchanged, already checked out).
- Commit: `42ad499` — "feat(eval): detached execution + PID/port manifest
  for eval harnesses (FEAT-462 slice B)".
- Not pushed, not merged, per instructions.

## Changed / added files
New shared modules (all under `scripts/eval/shared/`):
- `detach.ts` — `evaluateDetachDecision` (pure single-decision-point,
  mirrors `run-params.ts`'s `evaluateResumeGuard` / DEC-012 precedent),
  `isDetachedChild`, `buildDetachedChildArgs`, `spawnDetached`.
- `run-status.ts` — `RunStatus`/`RunPhase` types, atomic tmp+rename
  `writeRunStatus`/`readRunStatus`/`patchRunStatus` (same technique as
  `src/config/writer.ts`'s `writeConfig`, FEAT-433), `shouldFlushProgress`
  (pure throttle), `formatRunStatus`/`printRunStatus` (shared `--status`
  CLI implementation).
- `daemon-manifest.ts` — `DaemonManifestEntry`/`DaemonManifest` types,
  atomic `writeDaemonManifest`/`readDaemonManifest`, `killManifestDaemons`
  (scoped kill: signals only manifest PIDs, tolerant of ESRCH/already-dead).
- `__fixtures__/fake-detached-worker.mjs` — plain-Node heartbeat-file
  worker fixture for the detach integration test.

Tests (30 new, all passing):
- `shared/run-status.test.ts` (13 tests)
- `shared/daemon-manifest.test.ts` (6 tests, incl. real spawned-process
  scoped-kill + already-dead-PID cases)
- `shared/detach.test.ts` (10 tests: pure decision/arg-building + one real
  spawn-detached integration test proving the child survives independently
  of the spawning call and a manifest-scoped kill actually stops it)
- `longmemeval/detach-kill-resume.test.ts` (1 test: kill via the manifest,
  not a direct handle, then `--resume`-style re-ingest completes exactly
  once — the AC-3 "kill-safety" handshake explicitly requested)

Wired into both harnesses identically:
- `longmemeval/run-smoke.mts`, `locomo/run.mts` — `--detach`, `--status
  <run-dir>` flags; `run-status.json` + `daemon-manifest.json` written on
  EVERY invocation (detached or not — additive, same AC-7-safe precedent as
  slice A's ledger/run-params.json); status patched at phase transitions
  (starting/sampling/ingesting/completed/failed) and throttled (2s) during
  cross-shard ingest progress.
- `longmemeval/README.md` — new "Detached execution, status, and the
  PID/port manifest" section (mechanism + design rationale).
- `locomo/README.md` — short pointer section to the same mechanism.

## Design decisions worth flagging
1. **Detach mechanism: plain `child_process.spawn({detached:true}).unref()`
   re-invocation, not schtasks.** The FEAT body names the `AstraMemoryD`
   schtasks-keepalive pattern as a reference point, but that pattern solves
   a different problem (surviving a full OS reboot, needed for a long-lived
   service). An eval harness run only needs to survive the invoking
   terminal/session ending — `detached: true` + `unref()` already provides
   that on both Windows and POSIX with no OS-specific registration, no
   elevation concerns, and nothing left to clean up after the run finishes.
   Documented the tradeoff explicitly in `detach.ts`'s header comment and
   the README. If a future need arises for surviving a reboot, that's a
   different requirement warranting schtasks.
2. **Status/manifest are always written**, not gated behind `--detach` —
   matches slice A's precedent (ingest-ledger.jsonl / run-params.json are
   also unconditional). A foreground run someone wants to peek at from
   another terminal benefits too, and it keeps the "child re-evaluates the
   same args" path simple (no special-casing).
3. **`RunPhase` is coarse** (`starting | sampling | ingesting | completed |
   failed`) rather than modeling `answering` separately — per-shard work
   (ingest → distill-wait → answer) happens inside one concurrent
   `Promise.allSettled` dispatch from the orchestrator's point of view, so a
   finer phase breakdown wasn't cleanly observable from the top level
   without invasive per-shard callback plumbing beyond this slice's scope.
4. **`buildDetachedChildArgs`** strips `--detach` and force-pins
   `--run-dir` to the already-computed run dir (its own default is a
   `new Date().toISOString()` timestamp computed at call time, which would
   silently diverge on a second invocation if not pinned explicitly).

## Per-AC evidence
- **AC-2** (detach + status file): `scripts/eval/shared/detach.test.ts`'s
  "spawnDetached (real process integration)" test spawns a real detached
  child via `spawnDetached`, never awaits/holds a reference to it (proving
  `.unref()` doesn't keep anything alive), polls a heartbeat file the child
  writes independently, confirms it's genuinely progressing, then confirms
  a manifest-scoped `SIGKILL` actually stops it (heartbeat stops advancing).
  `run-status.test.ts` covers the status file's read/write/patch/throttle
  contract directly. PASS.
- **AC-3** (PID/port manifest + scoped kill): `daemon-manifest.test.ts`
  proves `killManifestDaemons` kills only the PID in the manifest (a
  bystander process spawned alongside is confirmed untouched) and handles
  an already-dead PID (ESRCH) without throwing.
  `longmemeval/detach-kill-resume.test.ts` proves the full handshake
  end-to-end against the real fake-eval-daemon fixture: spawn a shard
  daemon, write it into `daemon-manifest.json` (mirroring what
  `run-smoke.mts` now does live), kill it via `killManifestDaemons` (not a
  direct handle), then `--resume`-style re-ingest against a respawned
  daemon on the same persisted state file completes every session exactly
  once. PASS.
- **AC-7** (byte-compatibility of the default path): no existing test
  asserts absence of new files; the additive-file precedent (ledger/
  run-params.json) already established this pattern is acceptable.
  `tsc --noEmit`, `bun run build`, and the full `bun run test` suite
  (208 files, 2454 passed, 6 pre-existing skips, 0 new failures) all pass
  clean after the wiring changes — existing output shape/exit-code logic
  in both harnesses was only ever added to, never altered.

## Verification gates run (this worktree)
- `bunx tsc --noEmit` — clean.
- `bun run build` — clean.
- `bunx vitest run scripts/eval/` — 17 files, 140 tests, all passing.
- `bun run test` (full repo) — 208 files, 2454 passed, 6 skipped
  (pre-existing), 0 failures.

## Confidence
High on AC-2/AC-3 mechanism and test coverage. Medium-high on the phase
model's granularity (see design decision 3) — acceptable for this slice's
scope but a follow-up could add per-shard phase detail if operators want
finer-grained status during a real multi-hour run.

## Risks / open questions
- Not validated against a REAL multi-hour run on this machine (only fake
  daemon / synthetic fixtures, per the "no live LLM, no real daemon"
  instruction) — the detach mechanism itself is proven with a real
  detached process, just not the full harness end-to-end over hours.
- `process.kill(pid, signal)` signal semantics on Windows are limited to
  SIGKILL/SIGTERM/SIGINT/SIGHUP per Node's docs (same constraint the
  existing `killDaemon` in `spawn-daemon.ts` already lives with) —
  `killManifestDaemons` inherits that same limitation, not a regression.

## Suggested next handoff
Review dispatch (crew:reviewer) against this commit, then validation if the
team wants a real (non-fake) multi-shard `--detach` smoke run exercised
from a plain terminal per the harness README's own "don't trust a run
launched from inside a coding-agent sandbox" warning.
