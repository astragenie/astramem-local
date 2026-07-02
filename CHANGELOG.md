# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.5.0] — 2026-07-02

Waves 1 + 2 of the target-architecture migration map: the trust floor and the contract + flywheel.

### Added — Wave 1: trust floor (SEC-1..10)

- **Encryption at rest** (SEC-1/2/7/8): production driver is now `better-sqlite3-multiple-ciphers`; `memory.sqlite` is encrypted by default (`security.encryption.enabled`, default `true`). Key lives in the OS credential store (Windows Credential Manager / macOS Keychain / libsecret via `@napi-rs/keyring`) with a `0600` `db.key` file fallback. Pre-existing plaintext DBs auto-migrate on startup (`PRAGMA rekey` on a verified copy) keeping a `.pre-encryption.bak`; backups of encrypted DBs stay encrypted (`VACUUM INTO` fallback).
- **Stage-0 secret redaction** (SEC-3..6): pattern + entropy detectors (AWS/GitHub/Azure/GCP/Slack keys, generic credentials, JWTs, PEM blocks, connection strings, config custom patterns) run at the ingest choke point and on `/remember` before anything is persisted. Placeholders `[REDACTED:<type>:<hash8>]`; counts-only `redaction_log` (migration 005); surfaced via `doctor` and `/health`.
- **Bearer token → OS credential store** (SEC-10): `secrets.env` kept as read-only fallback; file-only bearers are promoted one-way into the store.
- **D-DEF1 fixed**: canonical JSON turns are flattened to `role: text` lines at pipeline entry — role attribution reaches extraction.
- **D-DEF2 fixed**: `ingest_idempotency.summary_memory_id` is backfilled with the first real memory id after distillation.
- **CLI un-stubbed**: `queue` (job state counts + recent failures), `rebuild` (enqueues reembed jobs), `providers` (config + live chat/embed probes).
- **Dashboard auth hardening**: bearer no longer lives in the URL — `?token=` is a one-time bootstrap exchanged for an HttpOnly SameSite=Strict cookie via 302; `Authorization` header also accepted; 401 logs strip the query string.

### Added — Wave 2: contract + flywheel

- **Atom v3** (ADR-001, migration 006): `memories` gains bitemporal validity (`valid_from`/`valid_to`), `superseded_by`, `derived_from` lineage, and `scope` (`personal`/`team`/`org`, default `personal`). Search and `/recall/pack` exclude invalidated memories; receipts (`why_memory`) still see them.
- **`memory_events` append-only log** (ADR-002, migration 007): `create`/`invalidate`/`supersede`/`promote_scope`/`erase_request`/`usefulness` events with synthetic hash-stable `create` backfill; state change + event append in one transaction. Lifecycle REST: `POST /memory/:id/{invalidate,supersede,promote}`, `GET /memory/:id/history`.
- **MCP lifecycle tools** (ADR-007): `invalidate_memory`, `supersede_memory`, `promote_memory`, `memory_history`; `why_memory` now returns the populated `history` chain. MCP server exposes 11 tools.
- **`events` capture kind** (ADR-008): `POST /ingest/transcript` accepts `kind: "events"` — pre-typed atom candidates (runner-plugin grades/lessons/verdicts) that are redacted, stored, and enter the pipeline at stage 6 (reduce → normalize → embed+index) via the new `distill-events` job. Public protocol doc: `docs/capture-protocol.md`.
- **Recall-usefulness metric** (ADR-010 v1): `recall_served` / `recall_used` / `memory_corrected` event families captured from day 1 (query text never stored — sha256/16 hash only). Explicit feedback via MCP `mark_memory_used` + `REST POST /memory/:id/used`. Rate surfaced on `/health`, `doctor`, and a dashboard section. Measure-only in v1.
- **init: memory-pack hook auto-install**: `astramem-local init` offers to install the KF-B SessionStart hook into `~/.claude/settings.json` (idempotent, platform-appropriate command, `--no-hook` to skip); flips `recallPack.enabled`.

### Changed

- `SCHEMA_VERSION` 4 → 7 (migrations 005 security, 006 atom v3, 007 memory events).
- `/health` gains `security: { encryption, redaction }` and `usefulness: { served_7d, used_7d, rate_7d }`.

---

## [0.4.0] — 2026-07-01

### Added

#### Read-only HTML dashboard at `GET /dashboard`
- **`GET /dashboard?token=<bearer>`** — single-file HTML metrics page auto-refreshing every 5 seconds via `<meta http-equiv="refresh" content="5">`. No JS, no CDN, no external assets. Dark mode by default (`#1a1a1a` bg, `#e0e0e0` text).
- **Metrics rendered** (one SQLite pass):
  - Memory counts by type — CSS bar chart driven by `SELECT type, COUNT(*) FROM memories GROUP BY type`.
  - Recent captures — last 25 memories with truncated text (120 chars), `HH:MM:SS` timestamp, type badge, importance, confidence, session prefix.
  - Job queue state — colored badges: `poison` red, `pending` yellow if >3, `completed` green, `running` blue.
  - Distill throughput last 24h — text-bar histogram by hour.
  - Provider state — table with health status and last-check timestamp.
  - Budget — today spend + MTD spend vs daily cap from config; delta color (green <50%, yellow 50-80%, red >80%).
  - Pending queue — file count + oldest age from `%APPDATA%\Astramem\pending\`; shows "0 pending" if dir absent or empty; wrapped in try/catch.
- **Auth**: same Bearer token as all other authenticated routes, supplied as `?token=`. Missing/wrong token → 401 plain text (not HTML). Dashboard is excluded from the `Authorization` header preHandler check; it enforces its own query-param auth.
- **New files**:
  - `src/server/routes/dashboard.ts` — Fastify route factory.
  - `src/server/routes/dashboard-html.ts` — `renderDashboard(data, config): string` server-side HTML renderer.
  - `src/server/queries/dashboard.ts` — extracted read queries (testable without route layer).
  - `tests/server/dashboard.test.ts` — 16 inject tests covering 401/200, content-type, all section headers, meta-refresh, no-script, cache-control, public-route preservation.
- **`AppOpts`** gains optional `config?: Config` field (defaults to `defaultConfig()`); used by dashboard for budget cap display.

### Changed
- `src/server/app.ts` preHandler skip-list extended to include `/dashboard` (dashboard handles own auth via `?token=`).

---

## [0.2.0] — 2026-06-30

### Added

#### Wire protocol alignment (SaaS-canonical envelope)
- **`POST /ingest/transcript` accepts SaaS-canonical envelope** — new shape: `{event, session_id, turns[], wire_version (required, regex `^v\d+\.\d+$`), captured_at, client_version, client_scrub_version, client_scrub_hits_by_label, project_id?, cwd?, agent_type?}`. Legacy `{session_id, source, content}` shape still accepted — both parse and ingest correctly, backward-compatible distiller dual-reads.
- **`GET /version` endpoint** — public endpoint (no Bearer required), returns `{name, version, wire_versions_supported: ['v0.0', 'v1.0'], schema_version: 2, ts: ISO-8601}`. Matches SaaS discovery contract.
- **`GET /health` wire metadata** — extended response to include `wire_versions_supported` and `schema_version` (was `ok` + `version` only).
- **Idempotency header support** — `Idempotency-Key` on `POST /ingest/transcript` deduplicates via SHA-256 body hash. New `ingest_idempotency` table (PK: `idempotency_key`, unique index: `(idempotency_key, request_hash)`). Same key + same body → 200 + original `transcript_id` (replay); same key + different body → 409 Conflict.

#### Schema extension (migration 002)
- **`transcripts` table gains 8 new nullable columns**:
  - `event: TEXT` — event type ('pre_compact', 'session_end', 'subagent_stop')
  - `turns: TEXT` — newline-joined `role: text` pairs from `turns[]` array
  - `captured_at: TIMESTAMP` — ISO-8601 event timestamp
  - `client_scrub_version: TEXT` — scrubber version from client
  - `client_scrub_hits_json: TEXT` — stringified `{label: count}` map
  - `client_version: TEXT` — client plugin version
  - `project_id: TEXT` — SaaS project identifier
  - `cwd: TEXT` — working directory context
- **`wire_version` column on `transcripts`** — TEXT NOT NULL DEFAULT `'v0.0'`. Existing v0.1.x rows automatically backfilled; new rows adopt the sent `wire_version` (or default 'v0.0' if omitted in legacy envelope).
- **`ingest_idempotency` table** — stores `(idempotency_key TEXT PRIMARY KEY, request_hash TEXT UNIQUE, transcript_id TEXT, created_at TIMESTAMP)`.

#### Testing
- **9 new E2E integration tests** covering dual-envelope parsing, idempotency replay/conflict, `/version` endpoint, `/health` metadata, wire_version backfill. Full integration test suite: 429 passing.

### Changed

- **No breaking changes** — legacy `{session_id, source, content}` envelope preserved and fully supported. Daemon recognizes both shapes; distiller dual-reads with fallback.
- **`POST /ingest/transcript` response shape** — now includes: `{summary_memory_id, extraction_job_id, extracted_count, failed_atom_count, scrub_hits: {client, server}, queued_extraction_types}`. Extraction fields stubbed (full job queue in v0.3.0+).
- **Service metadata** — daemon reports `schema_version: 2` on health and version endpoints.

### Commits

- `2a6d517` — Migration 002: wire-v1 columns + ingest_idempotency table
- `df4aef3` — Dual-envelope Zod schema (legacy + SaaS canonical)
- `c45d762` — Canonical insert + idempotency wired
- `70a0f2a` — /version endpoint + /health wire-support metadata
- `4d945ac` — E2E integration tests (9 cases)

### Known issues

- **KNOWN ISSUE: D-DEF1 — Distill pipeline turn-flattening** *(FIXED in 0.5.0)*: The distill pipeline currently consumes `transcripts.content` as a flat string. Canonical ingests write `JSON.stringify(turns)` into that column. Distillation quality silently degrades on canonical paths until the distill handler is updated to flatten turns to `role: text\n` pairs before pipeline entry.
- **KNOWN ISSUE: D-DEF2 — `summary_memory_id` semantic change** *(FIXED in 0.5.0)*: The `summary_memory_id` returned by `POST /ingest/transcript` is currently the transcript row UUID. Wave-3 distillation will produce a real summary memory with a different UUID. Clients MUST treat the value as opaque — in 0.5.0 the idempotency row is backfilled with the real memory id once distillation completes.

### Related specification

- [astramemory-plugin FEAT 4a](https://github.com/astragenie/astramemory-plugin/blob/main/docs/superpowers/specs/2026-06-29-hooks-provider-migration-4a.md) — end-to-end three-repo wire contract convergence (daemon, plugin, SaaS). Daemon v0.2.0 = Phase 2 implementation.

---

## [0.1.4] - 2026-06-28

### Fixed

#### Windows install hardening
- **Startup-folder fallback** when `schtasks /sc onlogon` returns "Access is denied"
  even with `/RU "%USERNAME%" /IT /RL LIMITED`. Adapter now drops a `.cmd` shim into
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` so the daemon launches
  at next logon without admin privileges.
- **Auto-read bearer from `secrets.env`** during `astramem-local install` so a
  freshly seeded secrets file is picked up without manual env var export.

### Changed
- `GET /health` and MCP daemon-version constant bumped `0.1.3` → `0.1.4`.

---

## [0.1.3] - 2026-06-27

### Added

#### MCP HTTP server (Wave 5)
- `POST /mcp` — MCP Streamable HTTP transport (JSON-RPC 2.0, stateless per-request).
  Auth enforced by existing Bearer preHandler; no new auth code.
- 4 MCP tools auto-discovered by Claude Code:
  - `search_memory` — hybrid FTS + vector search with filters (type, repo, project, since).
  - `recall_memory` — top-K semantic recall (alias of search_memory, default k=5).
  - `remember` — direct memory insert, bypasses distillation pipeline.
  - `get_health` — daemon health probe (`{ ok, version }`).
- Zod-validated input schemas on all 4 tools; structured text/JSON output.
- 7 integration tests in `tests/mcp/server.test.ts` covering tools/list, each tool/call, and auth gates.
- Uses `@modelcontextprotocol/sdk@^1.29.0` (`McpServer` + `StreamableHTTPServerTransport`).

### Changed

- Version bumped from `0.0.1` to `0.1.3`.
- `GET /health` now reports version `0.1.3`.

---

## [0.1.0] - 2026-06-27

First public release. Covers Milestones 1-5 of the v1 design spec: storage, pipeline,
distillation, hybrid search, and installer.

### Added

#### Storage (Wave 1)
- SQLite schema v1: `sessions`, `messages`, `transcripts`, `memories`, `jobs`, `artifacts`,
  `provider_state`, `budget_spend` tables.
- FTS5 virtual table `memories_fts` with auto-maintained triggers on insert, update, delete.
- sqlite-vec virtual table `memories_vec` — 1024-dim FLOAT vector index.
- `schema_version` migration runner — idempotent, append-only migration files under `migrations/`.
- WAL mode + `foreign_keys ON` + `synchronous = NORMAL` pragmas applied at DB open.
- `MemoryRepo` — insert with hash deduplication, FTS5 keyword search.
- `SqliteVecStore` — upsert and cosine-distance ANN search via sqlite-vec.

#### HTTP daemon (Wave 1)
- Fastify HTTP server bound to `127.0.0.1` (loopback only).
- `GET /health` — returns `{ok: true, version}`. No auth required.
- `POST /ingest/transcript` — wire-compatible with `memory-plugin` hooks. Writes session +
  transcript + queues a `distill` job atomically. Requires Bearer token.
- `POST /recall` — hybrid search with body `{query, k, filters}`.
- `POST /remember` — direct memory insert, bypasses distillation pipeline.
- `GET /search` — query-string hybrid search.
- `GET /memory/:id` — single memory lookup.
- Zod request validation on all endpoints. 400 on schema failure, 401 on missing/wrong token.

#### Pipeline and workers (Wave 2)
- Job table state machine: `pending -> running -> completed | failed | poison | paused`.
- In-process polling worker loop — configurable poll interval.
- Retry with exponential backoff; job transitions to `poison` after 3 failed attempts.
- Handler registry — `register(kind, handler)` map.
- `cleanup` handler — prunes sessions and artifacts older than 30 days.

#### Hybrid search (Wave 2)
- Score fusion: `alpha * norm(BM25) + beta * norm(cosine) + gamma * importance + delta * freshness`.
- Default weights: alpha=0.4, beta=0.4, gamma=0.1, delta=0.1 (config-overridable).
- Query filter parser: `type:decision`, `repo:astramemory-local`, `since:7d`.
- FTS-only fallback when no embeddings exist for a memory (beta=0 path).

#### Service install (Wave 2)
- `ServiceAdapter` interface with per-OS implementations: systemd (Linux), launchd (macOS),
  schtasks (Windows).
- User-scope install — no admin/UAC required on any platform.
- `astra-memory service install|status|start|stop|uninstall` CLI commands.
- Doctor checks contributed by each track owner via plugin architecture.

#### Providers (Wave 2)
- `LLMProvider` interface: `chat(messages, opts) -> {text, usage}` + `health()`.
- `EmbedProvider` interface: `embed(texts) -> Float32Array[]` + `health()`.
- Ollama LLM adapter — chat via `/api/chat`, health via `/api/tags`. Cost always `$0`.
- Ollama embed adapter — embed via `/api/embeddings`, validates 1024-dim output.
- Azure OpenAI LLM adapter — chat completions, cost computed from token usage + pricing table.
- Azure OpenAI embed adapter — `text-embedding-3-small` with `dimensions=1024` parameter.
- Contract test suite shared across all four provider implementations.

#### Distillation pipeline (Wave 3)
- 8-stage distillation pipeline: cleanup, normalize, chunk, compact, extract, reduce,
  memory-normalize, embed+index.
- Stage 1 (cleanup): regex deduplication, whitespace normalization, repeated tool output removal.
- Stage 2 (normalize): path canonicalization, timestamp normalization, agent name normalization.
- Stage 3 (chunk): token-aware chunking (~800 tokens), respects turn boundaries.
- Stage 4 (compact): LLM call per chunk to remove redundancy.
- Stage 5 (extract): LLM JSON-mode, emits typed atoms. Zod-validated. Retries once on parse
  failure with stricter prompt.
- Stage 6 (reduce): hash-merge duplicate atoms across chunks.
- Stage 7 (memory-normalize): canonical text, lowercase entity dictionary, final hash.
- Stage 8 (embed+index): embed via configured provider, write `memories` row + `memories_vec`
  row + FTS5 update.
- `ExtractionSchema` (Zod): `{type, text, importance, confidence, evidence}`.
- Memory types: `decision`, `fact`, `lesson`, `command`, `todo`.
- Idempotency: same `session_id + source_hash` short-circuits without re-processing.
- Budget tracker: pre-call cap check, `paused` job state on cap exceeded, per-day spend record.
- `astra-memory budget` CLI: show today + month spend. `--reset` override (logged).

#### Install wizard (Wave 4)
- `astra-memory init` — interactive wizard using `@inquirer/prompts`.
- Wizard flow: vector store, embedding provider, LLM provider, data directory, port, budget cap,
  service install.
- Conditional provider checks: Ollama reachability, model presence, Azure ping.
- Writes `config.yaml` + `secrets.env` (mode 0600) + generates 32-byte random Bearer token.
- Runs migrations and doctor on completion; prints next-steps block.
- `astra-memory token rotate` — generate new token, invalidate old, rewrite secrets.env.
- `astra-memory token print` — print current Bearer token.

#### Doctor (Wave 2-4)
- `astra-memory doctor` — prints check table; exits 0 if all green, 1 if any red.
- `--json` mode for CI/scripting.
- Checks: SQLite writable + WAL, FTS5 + sqlite-vec loadable, daemon reachable, LLM provider
  < 5s, embed provider 1024-dim, pipeline queue not stuck, disk free > 1GB, service unit
  present and active, budget within cap, embedding provider mismatch.

#### CI (Wave 4)
- GitHub Actions matrix: ubuntu-latest, macos-latest, windows-latest x node-20, node-22.
- sqlite-vec prebuilt verified on all three OS targets.

#### Documentation (Wave 4)
- Full README with architecture diagram, provider matrix, commands index.
- `docs/migration-from-saas.md` — step-by-step guide for switching from SaaS to local.
- `docs/configuration.md` — config.yaml reference with all fields and defaults.
- `docs/providers.md` — Ollama and Azure OpenAI setup instructions.
- `docs/troubleshooting.md` — common issues and fixes.
- `docs/contracts.md` — frozen type interfaces for contributors.

### Changed

- `README.md` replaced Wave 1 stub with full v1 documentation.

### Known limitations

- Distillation lag: memories are not searchable until the distillation worker processes the
  queue (~5-30s typical with Ollama running locally). Ingest is synchronous; distillation is
  async.
- Loopback only: daemon binds `127.0.0.1`. Remote access requires `--allow-network` flag (not
  recommended; no TLS in v0.1.0).
- Single embedding space: all memories must use the same embedding model. Changing the model
  requires `astra-memory rebuild --reembed`.
- No SaaS sync: local memories are not synchronized to the AstraMemory cloud.
- No knowledge graph: relationships between memories are not modeled. Entity graph is deferred
  to v1.1.

[0.1.0]: https://github.com/astragenie/astramemory-local/releases/tag/v0.1.0
