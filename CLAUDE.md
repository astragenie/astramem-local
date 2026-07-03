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
node dist/cli/index.js reinstall     # stop → shim → XML task → start → verify version
```
Upgrade flow: `git pull && bun install && bun run build && node dist/cli/index.js reinstall`.

Architecture: schtasks task `AstraMemoryD` points at a STABLE shim
(`%LOCALAPPDATA%\Astramem\bin\astramemd.cmd` → `launch.cjs` → `current.json` pointer).
Upgrades rewrite the pointer only; schtasks is never re-touched. Task registered via
XML: no 72h ExecutionTimeLimit, logon trigger + PT5M repetition = keepalive watchdog
(dead daemon restarts ≤5min; healthy re-runs exit <100ms via `daemon.lock` instance lock).

**Do NOT use bare `astramem-local`** — global bun install is v0.3.4 (plain
better-sqlite3, no cipher) and throws `SQLITE_NOTADB` on the encrypted DB. Registry
maxes at 0.4.0. Always `node dist/cli/index.js <cmd>` from the repo. `reinstall`
asserts served version == build version to catch this shadowing.

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

## Do NOT
- Do NOT edit `%APPDATA%\Astramem\config.yaml` by hand while service is running — reload racey. Stop service first.
- Do NOT commit `secrets.env` or the SQLite file — both in `.gitignore`.
- Do NOT change embed dim without also editing schema (`memories_vec FLOAT[N]`), config default, embed provider `dim`, contracts. Six-file coordinated change. Backlog: parameterize.

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
