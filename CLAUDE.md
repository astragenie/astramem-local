# astramemory-local — session guidance

Local-first memory daemon. TypeScript + Node 20 + Fastify + better-sqlite3 + sqlite-vec.
Wire-compatible with astramem-plugin (v0.5.2+) and memory SaaS backend (FEAT-4a Phase 1).

## Install / onboarding

The wizard IS the installer. Do NOT hand-craft config.

```powershell
cd C:\work\mega\astramemory-local
bun install
bun run build
node dist/cli/index.js init
```

`init` writes `%APPDATA%\Astramem\config.yaml` + `secrets.env`, runs migrations, provisions the OS service (schtasks / systemd / launchd), runs doctor, prints next steps.

Prereqs the wizard checks: Node 20+, Ollama running with `mxbai-embed-large` (1024-dim, matches schema — do NOT use `nomic-embed-text-v2-moe` which is 768-dim; hotfix v0.2.1 swapped the default).

## Service / upgrade (post-hardening, feat/install-daemon-hardening)

One command fixes/installs/repairs everything — idempotent, non-elevated OK:
```powershell
node dist/cli/index.js reinstall     # materialize release → stop → shim → XML task → start → verify version
```
Upgrade flow: `git pull && bun install && bun run build && node dist/cli/index.js reinstall`.

Architecture: schtasks task `AstraMemoryD` points at a STABLE shim
(`%LOCALAPPDATA%\Astramem\bin\astramemd.cmd` → `launch.cjs` → `current.json` pointer).
Upgrades rewrite the pointer only; schtasks is never re-touched. Task registered via
XML: no 72h ExecutionTimeLimit, logon trigger + PT5M repetition = keepalive watchdog
(dead daemon restarts ≤5min; healthy re-runs exit <100ms via `daemon.lock` instance lock).

`reinstall` materializes an immutable release under `%LOCALAPPDATA%\Astramem\releases\<pkgversion>+<gitsha>\`
before ever touching the running daemon (FEAT-438) and repoints `current.json` at it —
the mutable checkout's `dist/` is never served directly, closing the 2026-07-07
stale-dist outage class. Every successful `reinstall` also prunes old releases,
keeping the newest 2 (the just-verified one is always protected, even if older).

`reinstall --rollback` repoints at the previous release with no new
materialization and no schtasks re-registration (task registration happens
exactly once, at first install) — fails loudly with a non-zero exit and
leaves `current.json` untouched if there is no older release on disk.

`reinstall --dev` is the escape hatch back to pre-FEAT-438 behavior: pins the
service straight at the checkout's own `dist/cli/index.js` (mutable — dev
churn can restrand the daemon again) and prints a loud warning every time.
`doctor` flags a dev-pinned install with a WARN row; run plain `reinstall`
(no `--dev`) to return to a pinned release.

### Unix service parity (FEAT-443)

`service install` / `init` / `reinstall` share ONE install path
(`install-flow.ts`) on all three platforms now: systemd units and launchd
plists point at the same STABLE shim architecture Windows always used
(`<dataDir>/bin/astramemd.sh` → `launch.cjs` → `current.json` pointer, see
`shim.ts`) — upgrades repoint `current.json` only, the unit/plist is
registered exactly once at first install, and `reinstall --rollback` works
on linux/darwin exactly like it does on win32 (SLICE-1).

`Restart=on-failure` (systemd) and `KeepAlive` (launchd) only fire when the
daemon process actually exits — a daemon that's alive but wedged (blocked
event loop, deadlocked native call) keeps holding `daemon.lock` and answering
nothing, and neither mechanism ever notices (same blind spot Windows' PT5M
keepalive has always had). SLICE-2 closes this for linux/darwin with a
separate recurring hang-watchdog probe (systemd `OnUnitActiveSec` timer /
launchd `StartInterval` agent, installed automatically alongside the main
service — not opt-in) that hits `/health` every 3 minutes and, on failure,
kills whatever actually holds `daemon.lock` and restarts via the adapter —
see `src/service/watchdog-probe.ts` for why this shells out to a probe+kill
cycle instead of genuine `sd_notify`/`WatchdogSec` (Node has no built-in Unix
datagram socket support). Invoke by hand with
`astramem-local service watchdog-probe`; remove with `service uninstall`.
Windows is out of scope here — its PT5M keepalive has the same hang blind
spot, unaddressed by this FEAT.

**Package name: `astramem-local` on npmjs** — first published 2026-07-08 as v0.9.0
(this repo, SQLCipher-capable). The OLD stale 0.4.0 lives under the scoped name
`@astragenie/astramemory-local` on GitHub Packages (scope-mapped in ~/.npmrc) —
never install that one (plain better-sqlite3, `SQLITE_NOTADB` on encrypted DBs).
For dev work still prefer `node dist/cli/index.js <cmd>` from the repo; a stale
GLOBAL install can shadow dev expectations, and `reinstall` asserts served
version == build version to catch exactly that.

Boot is degraded-start: port binds immediately, embed probe retries in background
(`/health.status`: starting|ok|degraded). `--strict-preflight` restores fail-fast.

Foreground dev (no service): `node dist/cli/index.js serve --port 7777`
Diagnose: `node dist/cli/index.js doctor` (now reads config.yaml same as serve)

## Config paths (Windows)
- Config: `%APPDATA%\Astramem\config.yaml`
- Secrets: `%APPDATA%\Astramem\secrets.env` (contains `MEMORY_BEARER=<64-hex>`)
- Ingest log: `%APPDATA%\Astramem\ingest.log` (rotated at 10MB)
- SQLite: `%LOCALAPPDATA%\AstraMemory\memory.sqlite`

Non-Windows: `~/.config/astramem/` and `~/.local/share/astra-memory/`.

## Wire contract (FEAT-4a Phase 2)

Daemon speaks BOTH envelopes on `POST /ingest/transcript`:
- **Canonical (v1.0)**: `{event, session_id, turns[], wire_version, client_scrub_*, ...}` — SaaS-aligned
- **Legacy (v0.0)**: `{session_id, source, content}` — backward-compat

`wire_version` regex: `^v(?:0|[1-9][0-9]*)\.[0-9]+$` — mirrors SaaS `IngestTranscriptRequest.cs:65` and plugin `wire.ts:106` (v0.2.1 tightened; prior versions accepted `v01.0`).

`GET /health` and `GET /version` are public (no Bearer). Everything else requires `Authorization: Bearer <token>` matching `MEMORY_BEARER`.

Idempotency via `Idempotency-Key` header: SHA-256 (stable-stringify) body hash. Same key + same body → 200 replay with `idempotent: true`. Same key + different body → 409.

## Bump discipline

`package.json.version` MUST match the git tag. `.github/workflows/version-tag-parity.yml` gates this on tag pushes. Bump package.json + tag same PR when cutting a release.

**Publish runbook: `docs/runbooks/release-publish.md`** (kb mirror: `kb/deployments/astramem-local-npm-publish.md`). `npm publish` auth = an npm **Automation** token in `~/.npmrc` (`//registry.npmjs.org/:_authToken=npm_...`) — Automation-type bypasses 2FA, so publish needs no OTP; a Publish/Granular token fails with `EOTP`. Package `astramem-local` on npmjs, owner account `heroboec`; regenerate token at npmjs.com → settings/heroboec/tokens → Classic → Automation. Token value lives ONLY in `~/.npmrc` (never committed).

## Recent (2026-07-01)

- v0.2.1 hotfix: swap embed default to `mxbai-embed-large` + boot-time dim preflight; regex tighten; version parity CI. See PR #4.
- Marketplace `astramem` entry tracks the PLUGIN version, not the daemon.

## Sensible defaults for testing
Local dev: `serve --port 7777` foreground, `ASTRA_MEMORY_DATADIR=:memory:` for throwaway state. Kill with Ctrl+C. Production-ish: `init` + `service install` + `service start`, real SQLite at default datadir.

## Formerly-deferred items — RESOLVED (verified 2026-07-03, do not re-fix)
- Turn flattening: DONE — `flattenTranscriptContent` (src/distill/flatten-turns.ts) wired at distill.ts:72 (D-DEF1, commit 55ac082). Canonical `JSON.stringify(turns)` flattens to `role: text` lines before the pipeline.
- `summary_memory_id`: DONE-as-designed — D-DEF2 backfill (same commit): first-response returns transcript UUID (distill is async — inherent), then `ingest_idempotency.summary_memory_id` is backfilled with the first real memory id post-distill; idempotent replays return it. Clients treat it as opaque.
- Retrieval eval gate: ADR-005 harness (tests/eval/retrieval-eval.test.ts) runs in every vitest/CI pass — recall@10 ≥ 0.9, NDCG@10 ≥ 0.7 regression floors, deterministic fake embedder.
- Usefulness → ranking: ADR-010 v1.x epsilon component live in src/search/fuse.ts (`epsilon: 0.1` default; Laplace-smoothed used/corrected per atom).

## Config reload (FEAT-433, resolved)
config.yaml is read exactly once per process at boot (`resolveRuntimeConfig` →
`loadConfigFromDisk`) — there is no live reload, so hand-editing it while the
service is running has no effect on the running process either way; the
change is picked up on the next restart. `writeConfig` (`init`,
`reembed-dim`, `pair`) now writes atomically via tmp-file + rename, so the
DAEMON's own writes (including the schtasks keepalive racing a restart) can
never be observed torn — that's the footgun this warning used to be about,
and it's fully closed.
Guarantee, precisely: a fully-empty boot-time read is retried then WARNs +
falls back to defaults; a non-empty read that parses to zero keys (cut off
before any complete line) also WARNs + falls back. A hand-edit's own save is
NOT atomic, though — if a restart lands mid-save AFTER at least one complete
key: value line was written, the loader applies that partial content with no
warning (indistinguishable from an intentionally minimal config). Stop the
service before hand-editing config.yaml to avoid that narrow window; don't
rely on the loader alone to catch it.

## Do NOT
- Do NOT commit `secrets.env` or the SQLite file — both in `.gitignore`.
- Do NOT kill processes machine-wide by image name (`taskkill /F /IM node.exe`, `/IM bun.exe`, `Stop-Process -Name node`). This box runs the production daemon, eval shard daemons, Ollama, and sibling agents' processes — an image-name kill murders all of them (2026-07-10: killed a 40-min LongMemEval run + prod daemon). Kill only PIDs you spawned (track them; use process-tree kill on your own root PID). If stray vitest daemons pile up, find YOUR strays via their listen ports / datadir paths and kill those PIDs.
- Do NOT `git stash` in worktrees — the stash stack is repo-global across all worktrees; a `stash pop` in one worktree can eat a sibling agent's stash (caused a 2026-07-09 work-loss race). Use `git diff > x.patch` + `git checkout` + `git apply` instead.
- Do NOT hand-edit `memories_vec FLOAT[N]` in a migration file directly. Since FEAT-409 (merged) the dim is single-sourced from `DEFAULT_EMBED_DIM` (`src/contracts/embed.ts`) — config default, embed providers, `SqliteVecStore`, mock providers, the `__EMBED_DIM__` migration placeholder, and the boot-time preflight (`src/doctor/probes/embed-probe.ts`) all derive from it or from `getVecSchemaDim()`. Changing the *default* is a one-constant edit for fresh DBs; migrating an *existing* DB's live vectors to a new dim requires `astramem-local reembed-dim` (migration 011, `docs/embed-dim-migration.md`) — there is no ALTER for a sqlite-vec vec0 table. FEAT-436 (2026-07-05) re-audited this and confirmed it is resolved, not an open coordinated-change hazard.

<!-- crew:start -->
<!-- Crew framework memory. Run /crew:install after plugin updates that change framework memory. -->
@.claude/crew/constitution.md
<!-- crew:end -->

<!-- runner:start -->
<!-- Installed by /runner:install. Edit .claude/loop.json to change stack-specific commands; re-run /runner:install to regenerate this block. The full HARD RULES live at .claude/loop/rules.md so this block stays small in per-session context. -->

## Autonomous Loop — HARD RULES (summary)

This repo runs the Wiggin Loop autonomously. Full rules: `.claude/loop/rules.md`.

- **Run until PASS.** Do not stop for confirmation. Stop only when every acceptance criterion is PASS with evidence, or the work is externally blocked.
- **Auto mode (default — `loop.marathonMode: true`).** Loop walks the entire backlog. Stops only on backlog exhaustion, crew `escalated_to_human`, warn-severity pattern alerts, or high-severity cost alerts. Iteration cap and soft `blocked` badge are advisory in this mode — set `loop.marathonMode: false` in `.claude/loop.json` to restore the legacy five-condition gating.
- **Slice start ceremony.** Every slice MUST open via `/runner:slice start --id SLICE-NN` (rotates `currentRun` so cost auto-emit attributes the work correctly + refreshes `.claude/state/crew/slice-progress.md`).
- **Dispatch discipline.** The loop is an orchestrator, not an implementer. Hand the `slice start` return's `dispatchInstruction` to a `crew:builder` subagent (implementation only); after it returns, dispatch `crew:reviewer`, then `crew:validator` if behavior changed; pivot to `/crew:fix` on any needs_fix or fail. Inline implementation is reserved for trivial single-line fixups.
- **Slice close ceremony.** Every slice MUST close via `/runner:slice complete --id SLICE-NN` (writes handoff + final-synthesis + cost-report + cost-advise) followed by `/runner:slice grade*`. Manual file moves + a `docs(slice): mark ... complete` commit are NOT a substitute.
- **Build entry points.** `/crew:build` is the interactive single-slice path (lighter — no run-brief required). Autonomous loop is the unattended multi-slice path (full ceremony). Never run both against the same branch — they race on workflow-state.
- **Auto-continue.** After the ceremony, scan `.claude/artifacts/loop/specs/` → `.claude/artifacts/loop/backlog/pending/` → `.claude/artifacts/loop/backlog/triaged/` and promote the next item without asking.
- **Phase gate.** When the last slice in a phase completes, run `/runner:phase-gate` before starting the next phase.
- **Worktree parallelism.** Run parallel features in sibling git worktrees — each has its own `.claude/state/`. Cost attribution is auto-scoped per worktree. Use `crew fleet --repo "$PWD"` for a one-glance view. Never check out the same branch twice; never push from inside the loop.

First action when starting the runner: read `.claude/loop/rules.md` → `.claude/artifacts/loop/ai-loop/00-entry/MASTER_PROMPT.md` → `.claude/artifacts/loop/ai-loop/backlog/approved-slices.md`.

<!-- runner:end -->
