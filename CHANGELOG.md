# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
