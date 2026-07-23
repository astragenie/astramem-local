# CLAUDE.md — astramem-local

@AGENTS.md

> The include above is the tool-agnostic scaffold (commands, structure, style, credentials,
> never-do). Everything below is **astramem-local-specific**: mission, decisions an agent must not
> re-litigate, and where volatile state lives. This file changes rarely by design — dated facts,
> eval numbers, and open/closed incidents live in `docs/memory.md`.

## Session protocol — memory + issue tracing (mandatory, not advisory)

Before any non-trivial work (feature, fix, review, plan):

1. **Read `docs/memory.md` in full.** It is the ONLY source for dated corrections, current LoCoMo/
   eval numbers, known open gaps, and closed-incident records — `CLAUDE.md` deliberately contains
   none of that. Skipping it means working on stale assumptions (this file itself used to embed
   that state directly; the 2026-07-21 rebuild extracted it for exactly this reason).
2. **Re-verify before relying.** `docs/eval-runs/LEDGER.md` numbers and `docs/memory.md`'s dated
   bullets are a cache, not the truth — re-check against the cited source (a test file, a config
   constant, a migration) before quoting either in a decision.
3. **Write-back is part of the task.** Any fact you verify, any number that moved, any incident
   that closed: update `docs/memory.md` in the same session — supersede the entry in place and
   refresh its date. A session that learns something and doesn't write it back is a defect.

## Mission

**astramem-local is a local-first memory daemon for AI coding agents** — it captures every Claude
Code session transcript, distills typed memories (decisions, facts, lessons, commands, todos)
through an 8-stage pipeline, and serves them back via hybrid search, entirely on the user's
workstation with no cloud account required. It is wire-compatible with the `astramem-plugin`
Claude Code plugin and the memory SaaS backend (shared atom/retrieval/capture/sync contracts). Per
the kb strategy research, **astramem-local is the flagship product** the company is built around
(see `../kb/12-research/astra-strategy-2026-07/README.md`, machine-local path).

## Authority documents (read for any non-trivial work)

- **`docs/research/20260713-teardown-and-reinvent.md`** + **`docs/specs/20260713-teardown-remediation-plan.md`**
  — the architecture-verdict investigation (see "Decisions not to relitigate" below). Read these
  before proposing a rewrite of the daemon, storage layer, or MCP transport.
- **`docs/eval-runs/README.md`** — canonical LoCoMo/eval tracker. Read before quoting any benchmark
  number.
- **`docs/architecture/README.md`** + `docs/adr/ADR-001..010` — the original design package
  (2026-07-02): memory atom shape, storage engine, sync protocol, retrieval contract.
- **`docs/memory.md`** — durable facts index (dated corrections, current numbers, open/closed
  incidents).
- **`docs/README.md`** — map of the whole `docs/` tree.

## Architecture (stable facts — see `docs/memory.md` for anything dated)

- **Install is wizard-only.** `init` (first install) and `reinstall` (idempotent fix/upgrade) share
  one install-flow path across win32/linux/darwin, all pointing a STABLE shim at a `current.json`
  pointer. `reinstall` materializes an immutable release before ever touching the running daemon
  (FEAT-438) and prunes old releases (keeps newest 2). `reinstall --dev` pins straight at the
  checkout's mutable `dist/` as an escape hatch; `doctor` flags a dev-pinned install.
- **Config paths (Windows):** `%APPDATA%\Astramem\config.yaml` + `secrets.env`;
  `%LOCALAPPDATA%\Astramem\memory.sqlite` + ONNX model cache. Non-Windows:
  `~/.config/astramem/` and `~/.local/share/astra-memory/`. Canonical dir name is `Astramem`
  (not `AstraMemory`, which is the legacy ≤0.2.2 dir).
- **MCP transport: two modes.** The long-lived HTTP daemon (`serve`) is mandatory for the
  LLM-proxy/capture path, background jobs, and sync. `mcp-stdio` is a lighter spawn-per-session
  stdio MCP server with no daemon lifecycle — a real way to use the MCP tools with no service
  install, not a daemon replacement.
- **Wire contract:** the daemon speaks both a canonical v1.0 envelope (SaaS-aligned) and a legacy
  v0.0 envelope on `POST /ingest/transcript`. Idempotency via `Idempotency-Key` (SHA-256 body hash).
- **Entity relations** (`entity_relations`, migration 027) hold entity-to-entity triples extracted
  alongside each atom's `entities[]` list, read via `get_entity_related` / `get_entity_timeline`.
- **Boot is degraded-start** — port binds immediately, embed probe retries in background
  (`--strict-preflight` restores fail-fast).

## Decisions not to relitigate

- **Architecture verdict (2026-07-13):** a 6-agent adversarial teardown concluded **sound core,
  accumulated debt; zero of five redesign gates cleared. Default to salvage, not rewrite.** Read
  the two authority docs above before re-deriving this question from scratch.
- **Contradiction detection ships `enabled`.** `defaultConfig()` sets
  `contradictionDetection.mode: 'enabled'` (`src/config/config.ts`) — this is the real shipped
  default. `DEFAULT_CONTRADICTION_DETECTION` (`mode: 'off'`) is a governance-fallback constant used
  only when a config override is missing/invalid; it does **not** describe the default. Do not
  "fix" this as off-by-default — see `docs/memory.md`'s FEAT-482 record for why that flip is
  guarded, not reverted.
- **Temporal reasoning: the schema is NOT at fault.** Bitemporal storage and `as_of`-aware
  retrieval are both correct; the LoCoMo temporal-category gap is an extraction problem (facts
  rarely carry a populated `valid_at`/`invalid_at` window), not a data-model gap. Don't let any doc
  imply the schema needs replacing.
- **Doctor DOES run unattended** — a frequent 15-min pass (cheap-tier, DB-only checks) plus the
  existing 24h cleanup tick (full-tier, metered LLM/embed probes). Don't propose "wiring doctor
  into serve" — it already is.
- **`memory-health` check MUST stay `tier: 'full'`** — promoting it to the 15-min cheap tier was
  already tried and reverted (incident #226): its queries are unbounded full-table scans with no
  date filter. Hard-locked by `FULL_TIER_ONLY_CHECK_NAMES` in `tests/doctor/schedule.test.ts`.
- **Package identity:** `astramem-local` on npmjs (owner `heroboec`) is canonical.
  `@astragenie/astramemory-local` on GitHub Packages (0.4.0, plain better-sqlite3) is stale — never
  install or publish it.
- **Publish flow:** a `v*` tag push **auto-publishes via CI** (`.github/workflows/publish.yml`).
  Never run a manual `npm publish` after pushing the release tag — it collides with CI's own
  publish (this was learned once already; don't re-learn it).
- Everything in `@AGENTS.md`'s Never-do still applies.

## Ecosystem canon (kb)

`../kb/...` links are filesystem-relative — machine-local, work only on this box.

- Strategy context: [astra strategy series](../kb/12-research/astra-strategy-2026-07/README.md) —
  why this repo is the flagship product, not a side bet.
- Engineering standards: [definition-of-done etc.](../kb/08-engineering/),
  [AI/agent-workflow rules](../kb/10-ai-rules/) (directly relevant — this product *is*
  extraction/retrieval/prompt-engineering), [security](../kb/security/12-security-standards.md).
- Patterns: [crew-harness / wiggin-loop / phase-gates](../kb/05-patterns/) (this repo runs both).
- Publish reference mirror: `../kb/deployments/astramem-local-npm-publish.md` — currently carries
  the same stale manual-`npm publish` instruction this run corrected in
  `docs/runbooks/release-publish.md`; kb is out of this repo's edit scope, flagged for the kb
  owner instead of fixed here.

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
- **Dispatch discipline.** The loop is an orchestrator, not an implementer. Hand the `slice start` return's `dispatchInstruction` to a crew builder subagent — `crew:fullstack-dev` (or the stack-specific `crew:backend-dev` / `crew:frontend-dev`), or generic `claude` (implementation only; there is no agent literally named `crew:builder`); after it returns, dispatch `crew:reviewer`, then `crew:validator` if behavior changed; pivot to `/crew:fix` on any needs_fix or fail. Inline implementation is reserved for trivial single-line fixups.
- **Slice close ceremony.** Every slice MUST close via `/runner:slice complete --id SLICE-NN` (writes handoff + final-synthesis + cost-report + cost-advise) followed by `/runner:slice grade*`. Manual file moves + a `docs(slice): mark ... complete` commit are NOT a substitute.
- **Build entry points.** `/crew:build` is the interactive single-slice path (lighter — no run-brief required). Autonomous loop is the unattended multi-slice path (full ceremony). Never run both against the same branch — they race on workflow-state.
- **Auto-continue.** After the ceremony, scan `.claude/artifacts/loop/specs/` → `.claude/artifacts/loop/backlog/pending/` → `.claude/artifacts/loop/backlog/triaged/` and promote the next item without asking.
- **Phase gate.** When the last slice in a phase completes, run `/runner:phase-gate` before starting the next phase.
- **Worktree parallelism.** Run parallel features in sibling git worktrees — each has its own `.claude/state/`. Cost attribution is auto-scoped per worktree. Use `crew fleet --repo "$PWD"` for a one-glance view. Never check out the same branch twice; never push from inside the loop.

First action when starting the runner: read `.claude/loop/rules.md` → `.claude/artifacts/loop/ai-loop/00-entry/MASTER_PROMPT.md` → `.claude/artifacts/loop/ai-loop/backlog/approved-slices.md`.

<!-- runner:end -->
