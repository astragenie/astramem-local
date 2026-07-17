# Six-item stabilization plan — 2026-07-17 (pre-release, overnight window)

status: REVISED — architect + architect-reviewer sign-off folded in (2026-07-17)

## Review outcome (architect + architect-reviewer)
- **4 SOUND** (Items 1, 4, 5, 6), **2 NEEDS-REVISION** (Items 2, 3). Revisions
  folded inline below.
- **KEY CORRECTION — release is NOT blocked on Items 2/3.** The current rollback
  config (codex extraction, single-pass, standalone daemon) is shippable now.
  Items 2/3 improve UNATTENDED reliability; only Item 1 (CI green) gates
  *merging*. Release v0.19.0 can proceed independent of the managed-service fix.
- **#392 (`deb674c7`) is merged on main but was NEVER deployed** — prod's
  reinstall health-gate rolled back before repointing, so the running standalone
  daemon runs without it. The instance-lock bug exists in code regardless
  (Item 2 premise holds); the outage-recovery path is "get a reinstall to stick,"
  which a clean release enables.
- **Highest risk: Item 2** — a narrowly-scoped mutex (guarding only the lock
  write, not the port bind) looks complete, passes an organic-timing test, and
  still leaves a real TOCTOU window (ADR-016 §5: tests green for wrong reason).

Context: prod on a MANUAL standalone daemon (watchdog+keepalive tasks DISABLED,
zero auto-restart). LoCoMo qwen3:8b running overnight (PID 221068, run-dir
`.eval-data/locomo/runs/overnight-qwen38b`). v0.19.0-beta.0 release blocked on
daemon stability. Goal: land 6 non-colliding stabilization fixes so the managed
service can run unattended and the release can ship.

Constraints for ALL work below:
- Do NOT touch the running prod daemon or its datadir.
- Do NOT run a second LoCoMo/eval or load a model on the GPU (overnight run owns it).
- Branch off `origin/main`; never push from inside a loop; one owner per file.
- Auto-merge is OPT-OUT (`hold` label at PR creation to hold; else it arms on green).

---

## Item 1 — De-flake `cross-repo-roundtrip` CI

**Diagnosis (evidence, not hypothesis).** The check is FLAKY, not broken:
- Last 2 pushes to main (00:04, 00:15) GREEN; the 23:41 / 22:40 failures were
  **fast-fails** (49s, 1m14s) vs 8-10min for a real pass.
- No code changed between the failing and passing pushes — only docs commits.
- Failing-run log tail: the **"Checkout plugin (public, no token needed)"** step
  received a GitHub **404 HTML page** and died. That `actions/checkout@v7` step
  has **no retry**, unlike the two `bun install` steps below it (which already
  retry ETXTBSY). A transient GitHub 404/rate-limit on the sibling-repo checkout
  fails the whole gate.

**Fix (small, workflow-only).** Wrap the plugin checkout in a retry:
- Replace the `uses: actions/checkout@v7` plugin step with a `run:`-based
  `git clone` (or `actions/checkout` + a retry wrapper) that retries the
  sibling-repo fetch 2-3× with backoff, mirroring the existing ETXTBSY retry
  idiom already in this file. Public repo, no token — a bare
  `git clone --depth=1 https://github.com/astragenie/astramem-plugin plugin`
  in a retry loop is sufficient.
- Keep job name `cross-repo-roundtrip` stable (branch-protection required check).

**Unblock #397.** Independent of the de-flake: #397 is `MERGEABLE` and carries a
stale FAILURE from 23:24 (pre-flake-window). Re-trigger its check (empty commit
or `gh workflow run` on the branch / rebase on latest main) → merge on green.

**Owner:** release-engineer. **Gate:** CI green twice consecutively on the PR.
**Files:** `.github/workflows/cross-repo-roundtrip.yml` only.

---

## Item 2 — instance-lock atomic acquire (the real stabilization P0)

**Problem.** #397 grace-periods a still-booting daemon, but the managed service
still boots TWO daemons: the keepalive task (`AstraMemoryD`, PT5M) and the
watchdog task (`AstraMemoryDWatchdog`, PT3M) can fire near-simultaneously, and
both slip past instance-lock because takeover uses **health-probe zombie-
detection** (probe the port, decide if the holder is dead) rather than a real
**exclusive acquire**. Two near-simultaneous starts each see "no live holder"
and both proceed → EADDRINUSE crash-loop / split-brain.

**Design direction (for architect review — do NOT treat as decided).**
- Make lock acquisition atomically exclusive at the OS layer: `open(lockfile,
  O_CREAT|O_EXCL|O_WRONLY)` (Node `fs.openSync(path, 'wx')`) — the loser gets
  `EEXIST` and exits cleanly with `AlreadyRunningError` (exit 0), never races
  the port. Windows honors `wx` exclusivity.
- Keep the EXISTING zombie-takeover path for the genuine "previous daemon died
  holding a stale lock" case, but gate it behind the exclusive create: only ONE
  process can win the takeover attempt at a time (take an exclusive `.takeover`
  sentinel before rewriting the lock).
- Redundant scheduled-task spawns must exit 0 (AlreadyRunningError), NOT crash
  with EADDRINUSE — a self-perpetuating EADDRINUSE loop is invisible to the
  restart-storm breaker (which only counts watchdog kills).

**Open questions for architects:**
1. Is `fs.openSync(path,'wx')` sufficient cross-platform, or do we need the
   existing `daemon.lock`+PID scheme kept as the liveness record and a SEPARATE
   `.acquire` exclusive-create as the mutex? (two-file design vs one)
2. PID-reuse hazard: after an exclusive-create win, we still must verify the old
   PID in the lock file isn't a live unrelated process before SIGKILL. Keep the
   existing PID+start-time check (win32 `Get-Process` StartTime, #359) here.
3. Does the watchdog task even need to *start a daemon*, or only *probe + kill +
   let keepalive respawn*? If the watchdog never spawns, the 2-spawner race
   collapses to a 1-spawner problem. **This may be the simpler fix** — review
   whether removing the watchdog's spawn responsibility is safe.

**REVISIONS FROM REVIEW (load-bearing — build to these, not the sketch above):**
- The exclusive `openSync(path,'wx')` only guards the "no lock exists" branch.
  The real bug is the STEAL path (`holder && pidAlive && !healthy →
  writeLock(exclusive=false)`) using `writeFileSync + renameSync` — **`renameSync`
  never throws EEXIST, so two racers both "win" the steal and both bind.**
- **Two-file design:** a separate `daemon.lock.acquiring` sentinel opened `wx` at
  the TOP of `acquireInstanceLock`, released in `finally`, serializing the ENTIRE
  read→probe→decide→write→**bind** sequence. `daemon.lock` stays the liveness
  record (format unchanged — `readLockInfo`/`stopLockHolder`/doctor unaffected).
- **Mutex scope MUST extend through `app.listen()`** (couples with Item 3). If
  released at lock-write, a racer probes a holder that wrote-lock-but-not-bound,
  sees nothing listening, steals → reopens a ms-narrow version of the same bug.
- **Steal must KILL, not overwrite:** route the steal through `stopLockHolder`'s
  identity-verified kill (PID + `startedAt`, #359/#224) BEFORE taking the lock —
  else a false-zombie verdict = 2 live daemons + EADDRINUSE crash. Reviewer note:
  audit ALL callers funnel through the choke point (`restore.ts` once had a
  duplicate `stopDaemon` that bypassed it — #224 lesson).
- **Q3 SETTLED — do NOT remove the watchdog's spawn role.** `runWatchdogProbe`
  does call `adapter.start()` → `schtasks /run AstraMemoryD`, but task-XML already
  sets `MultipleInstancesPolicy=IgnoreNew`, and the race is reachable via keepalive
  alone. Removing the watchdog spawn only slows recovery (5min) without closing
  the race. Fix the mutex, keep the watchdog.
- **Test must inject artificial timing** between decide-and-write and bind — an
  organic "spawn N, see one bind" test can pass green with a wrong mutex scope.

**Owner:** builder (backend). **Gate:** review + a concurrency test with INJECTED
timing that asserts exactly one binds, N-1 exit 0. **Files:**
`src/service/instance-lock.ts`, `src/cli/serve.ts` (+ audit `restore.ts`,
`reinstall.ts`, `service.ts` callers). **Depends on:** this revised doc.

---

## Item 3 — Bind port before migrate/recover (#398, durable boot-race fix)

**Problem.** `serve.ts` binds the port at `app.listen()` (~L399) only AFTER
`acquireInstanceLock` → `migrate` (~L127) → `recoverOrphans` (~L156) →
`getProviders` (~L221). During that ~boot window `/health` cannot answer, so a
watchdog probe in the window reads "dead" and kills a daemon that is merely
booting. #397 grace-periods this; #398 is the durable fix.

**Design direction.** Move the TCP listener ahead of the slow boot steps: bind
first, serve `/health` as `status: 'starting'` immediately (the cached O(1)
liveness state already exists, commit 424cb671), run migrate/recover/providers
in the background, flip `/health` to `ok|degraded` when ready. Mirrors the
existing degraded-start pattern (`--strict-preflight` restores fail-fast).

**Interaction with Item 2:** the exclusive lock (Item 2) must be acquired BEFORE
binding the port (else two daemons bind-race). Sequence becomes: exclusive-lock
acquire → bind port (serve `starting`) → migrate/recover/providers → flip ready.
Items 2 and 3 touch `serve.ts` together — **same owner, one branch, sequential**,
not parallel (scope-discipline: two agents must not share `serve.ts`).

**REVISIONS FROM REVIEW:**
- Confirmed: this EXTENDS an already-shipped pattern (the non-strict embed
  preflight already backgrounds after `app.listen()`), not a new risk class.
- Confirmed: `/health` route returns 200 even when `status:'starting'` (Fastify
  sets no explicit code) → `probeHealth` (`res.ok`) reads starting-as-healthy.
  The watchdog blind-spot is real.
- **Make the yield EXPLICIT.** `migrate()`+`recoverOrphans()` are synchronous
  better-sqlite3 on the main thread — today a probe mid-migration times out at
  the socket (correct-by-accident). Schedule migrate/recover/providers via an
  explicit macrotask boundary after `listen()` resolves, and LOG (not gate) a
  warning if that phase exceeds ~5s so operators have an observable signal the
  watchdog structurally cannot see. Turns an implicit safety property into a
  documented one.
- **Do NOT let a half-migrated DB serve real requests:** only `/health` and
  `/version` answer during `starting`; all authed routes must 503 until ready
  (reuse the degraded-start gate). Reviewer's half-migrated-DB concern.

**Owner:** same as Item 2 (serial on `serve.ts`). **Gate:** review + a test
asserting `/health` answers `starting` <500ms after spawn AND authed routes 503
until ready. **Files:** `src/cli/serve.ts` (+ health route). **Depends on:**
Item 2 (mutex must hold through the bind this item moves earlier).

---

## Item 4 — Ollama orphan `llama-server` doctor check + reaper (#399)

**Problem.** Ollama spawns one `llama-server` child per loaded model. When Ollama
restarts/dies, orphaned `llama-server` processes survive holding VRAM
indefinitely (tonight: pid 31436, parent 6384 dead since 08:09, held 2GB → qwen
slow). Silent — no canary.

**Design direction.** Add a DB-only `tier:'cheap'` doctor check
(`src/doctor/checks/ollama-orphans.ts`): enumerate `llama-server` processes,
flag any whose parent PID is not a live `ollama` process → WARN with the held
VRAM. Optional `--reap` flag (or `astramem-local service reap-ollama-orphans`)
to SIGKILL only confirmed orphans (never kill a llama-server with a live Ollama
parent). Cross-platform process enumeration: win32 `Get-CimInstance Win32_Process`
(ParentProcessId), linux `/proc/<pid>/stat` field 4.

**Safety:** the reaper must kill ONLY PIDs whose parent is provably dead — never
image-name kill (CLAUDE.md hard rule: no `taskkill /IM`). Detection-only ships
first; reaper is a follow-up flag behind explicit invocation.

**Owner:** builder. **Gate:** review + unit test with a mocked process table
(orphan vs live-parent → correct classification). **Files:**
`src/doctor/checks/ollama-orphans.ts`, doctor registry, optional CLI verb.
**Independent** of Items 1-3 (different files) — can run in PARALLEL.

---

## Item 5 — Backlog reconciliation (close stale-done items)

**Problem.** Backlog has shipped-but-open entries. Several `pending/` and
`in-progress/` FEATs are merged on main (e.g. governance-wiring, jsonSchema
extraction fix #369, judge/passB/triage configurability #373/#533/#534, doctor
canaries #394). Noise before a release.

**Design direction.** Read-only sweep: for each `pending/` + `in-progress/` FEAT,
cross-check its `github_issue`/PR against merged main. Move confirmed-done to
`done/` with a one-line closure note; leave genuinely-open ones. NO code change.
Produce a reconciliation table (FEAT → status → evidence) for the user to
approve the moves before committing them.

**Owner:** researcher (read-only sweep) → document-writer (apply moves after
approval). **Gate:** user approves the move list (file moves are cheap but
should not silently reclassify open work). **Files:** `.claude/artifacts/loop/
backlog/**` only. **Independent** — can run in PARALLEL.

---

## Item 6 — Config-drift audit of the temp holding state

**Problem.** `%APPDATA%\Astramem\config.yaml` carries TEMP rollback comments that
must not silently ship as intended defaults:
- `llm.compaction` + `llm.extraction` → `codex-subscription` (rolled back from
  local qwen3:8b — UNWIND after distill-slowness track lands).
- `distill.extractionPasses: 1` (rolled back from 2 — same condition).
- `consolidation.candidateSelection: full` (rolled back from knn — UNWIND after
  the knn scan is chunked/offloaded).
- `contradictionDetection.mode: 'dry-run'` (intentional rollout state).
- watchdog+keepalive tasks DISABLED (UNWIND after Items 2+3 land + soak).
- `ASTRA_SKIP_CONSOLIDATE=1` via shim (temp).

**Design direction.** This is a DOC/audit task, not a config edit. Produce a
single "holding-state ledger": each temp state → {reason, unwind-condition,
owner, unwind-tracking-issue}. Cross-check that `defaultConfig()` in
`src/config/config.ts` (the SHIPPED default, distinct from the operator's live
config.yaml) does NOT encode any holding state — the release must ship clean
defaults even though the operator's box runs the holding state. File the
unwind conditions as tracked issues so nothing is lost. NO runtime change.

**Owner:** researcher/document-writer. **Gate:** user reviews the ledger.
**Files:** new `docs/research/20260717-holding-state-ledger.md`; verify (not
edit) `src/config/config.ts` defaults. **Independent** — can run in PARALLEL.

---

## Execution shape

Two lanes, respecting scope-discipline (no two agents share a file):

- **Lane A (serial, one owner, `serve.ts`+`instance-lock.ts`):** Item 2 → Item 3.
  The real P0. Architect sign-off gates the start.
- **Lane B (parallel, independent files):** Item 1 (CI), Item 4 (#399 doctor),
  Item 5 (backlog sweep, read-only), Item 6 (config audit, read-only).

**Release sequencing (CORRECTED):** v0.19.0 is NOT gated on Lane A. Once Item 1
makes CI reliably green, the current safe rollback config is shippable. Lane A
(managed-service unattended reliability) can land AFTER the release. Items 4-6 are
ship-independent hygiene. Recommended order: Item 1 → cut release → Lane A soak →
re-enable watchdog+keepalive (unwind the holding state from Item 6's ledger).

**Item 6 factual note for the researcher:** live `%APPDATA%\Astramem\config.yaml`
has `contradictionDetection.mode: 'dry-run'` (verified this session). A stale
in-code comment in `defaultConfig()` claims the operator set `mode:'off'` — read
the live file, trust neither secondhand description. `defaultConfig()` itself
ships CLEAN (codex, extractionPasses:2, contradiction `enabled`) — the release
does not carry the holding state.

## For the reviewing architects
1. Item 2: exclusive-create mutex vs keep-PID-liveness — one-file or two-file
   design? Is removing the watchdog's *spawn* role the simpler root fix (Q3)?
2. Item 3: is degraded-`starting` /health during migrate safe, or does it hide a
   genuinely-wedged boot from the watchdog (the failure the watchdog exists for)?
3. Items 2+3 ordering on `serve.ts`: confirm lock-before-bind-before-migrate is
   correct and doesn't reopen the stale-lock-takeover race.
4. Any hidden coupling that makes a "parallel" Lane-B item actually collide?
