# AstraMemory Local

Local-first memory daemon for AI coding agents — wire-compatible with `memory-plugin` (v0.2.0+).

> **v0.2.0 closes the schema gap**  
> Daemon v0.2.0 now accepts the SaaS-canonical wire envelope: `{event, turns[], wire_version (required), scrub metadata, client_version, captured_at, project_id, cwd}` alongside backward-compatible `{session_id, source, content}`. The daemon and SaaS backend now share a wire contract. See the [astramemory-plugin FEAT 4a spec](https://github.com/astragenie/astramemory-plugin/blob/main/docs/superpowers/specs/2026-06-29-hooks-provider-migration-4a.md) for the unified wire contract and migration timeline.

## Wire compatibility

The daemon's ingest endpoint now speaks the same wire protocol as the SaaS backend. Both old and new clients work:

**Legacy plugin (v0.1.x):**
```json
POST /ingest/transcript
Content-Type: application/json
Authorization: Bearer <token>

{
  "session_id": "claude-20260630-abc123",
  "source": "precompact",
  "content": "[Assistant]: Distilled 3 facts..."
}
```

**SaaS canonical (v0.2.0+):**
```json
POST /ingest/transcript
Content-Type: application/json
Authorization: Bearer <token>

{
  "event": "pre_compact",
  "session_id": "claude-20260630-abc123",
  "turns": [{"role": "user", "content": "..."}, ...],
  "wire_version": "v1.0",
  "captured_at": "2026-06-30T12:34:56Z",
  "client_version": "0.5.0",
  "project_id": "my-project",
  "cwd": "/home/user/src"
}
```

Both shapes are accepted — no migration needed. See [src/contracts/wire.ts](src/contracts/wire.ts) for the complete schema definition.

## Why it exists

Claude Code sessions compact and terminate, taking context with them. AstraMemory Local captures
every session transcript, distills typed memories (decisions, facts, lessons, commands, todos),
and serves them back via hybrid search (BM25 + vector + importance + freshness). It runs entirely
on your workstation — no cloud account, no data leaves your machine. The plugin's hooks post to
the local daemon instead of the SaaS endpoint through a single environment variable swap.

---

## Quick start (5 commands)

```bash
npm install -g @astragenie/astramemory-local
astra-memory init
# follow the wizard — picks Ollama or Azure, writes config.yaml + secrets.env
astra-memory service install
export MEMORY_API_URL=http://127.0.0.1:7777
export MEMORY_BEARER=$(astra-memory token print)
```

Restart Claude Code. All plugin hooks (PreCompact, SessionEnd, SubagentStop) now post to the
local daemon. No other plugin changes needed.

---

## Architecture

```
 memory-plugin hooks
    |
    |  POST /ingest/transcript (v0.2.0+ — SaaS-canonical envelope)
    |  Authorization: Bearer <token>
    v
+------------------+      SQLite (memory.sqlite)
|  HTTP daemon     | ---> +-------------------+
|  Fastify         |      | sessions          |
|  127.0.0.1:7777  |      | messages          |
|  (v0.2.0+)       |      | transcripts       |
+------------------+      | ingest_idempotency|
                          | jobs (queue)      |
                          | memories          |
                          | memories_fts (FTS5)|
                          | memories_vec (vec0)|
                          | budget_spend      |
                          +-------------------+
                                   |
                          in-process worker loop
                                   |
                          8-stage distillation
                          (cleanup -> normalize ->
                           chunk -> compact ->
                           extract -> reduce ->
                           memory-normalize ->
                           embed + index)
                                   |
                    +--------------+--------------+
                    |              |              |
              memories        FTS5 index    sqlite-vec
                (rows)       (BM25 search)  (cosine ANN)
                    |              |              |
                    +--------------+--------------+
                                   |
                          hybrid score fusion
                          a*BM25 + b*cosine +
                          c*importance + d*freshness
                                   |
                          GET /search  POST /recall
                                   |
                          /recall in plugin slash commands
```

Single Node process. Workers run in-process on a polling loop. SQLite is the source of truth.
Everything derived (vectors, FTS rows, compactions) can be rebuilt by replaying the jobs table.

---

## Memory types

| Type       | Description                                            | Example                                      |
|------------|--------------------------------------------------------|----------------------------------------------|
| `decision` | Architectural or design choice made during a session   | "Use sqlite-vec for v1 vector storage"       |
| `fact`     | Objective project fact, configuration detail           | "Port 7777 is the default daemon port"       |
| `lesson`   | Something that went wrong and how it was resolved      | "sqlite-vec rowid must match memories rowid" |
| `command`  | CLI command or script worth remembering                | "npm run build && npm test -- migrate"       |
| `todo`     | Outstanding work item surfaced in conversation         | "Add reembed job when provider changes"      |

---

## Provider matrix

| Concern         | Ollama (local, free)                     | Azure OpenAI (cloud)                         |
|-----------------|------------------------------------------|----------------------------------------------|
| LLM compaction  | qwen2.5-coder:7b (default)              | gpt-4.1 or any deployment                   |
| LLM extraction  | qwen2.5-coder:7b (default)              | gpt-4.1 or any deployment                   |
| Embedding       | nomic-embed-text-v2-moe (1024-dim)      | text-embedding-3-small (1024 via dimensions) |
| Cost            | $0 (local inference)                     | ~$0.02/1K tokens + $0.0001/1K embed tokens  |
| Setup           | `ollama serve` + `ollama pull <model>`   | Azure portal + endpoint + deployment name    |

Providers are configurable independently per stage. Embedding provider is system-wide — switching
requires `astra-memory rebuild --reembed` to re-index all memories in the new model's vector space.

See [docs/providers.md](docs/providers.md) for full setup instructions.

---

## Public endpoints

All endpoints require Bearer token authentication except `GET /version` and `GET /health`.

| Endpoint | Auth | v0.2.0+ | Description |
|---|---|---|---|
| `GET /health` | — | ✓ | Daemon health probe: `{ ok, version, wire_versions_supported, schema_version }` |
| `GET /version` | — | ✓ | Version discovery: `{ name, version, wire_versions_supported, schema_version, ts }` |
| `POST /ingest/transcript` | Bearer | ✓ | Accepts legacy + SaaS-canonical envelope; idempotency via `Idempotency-Key` header |
| `GET /search` | Bearer | ✓ | Hybrid search with type/repo/project/since filters |
| `POST /recall` | Bearer | ✓ | Top-K semantic recall (alias: `search` with k=5) |
| `POST /remember` | Bearer | ✓ | Direct memory insert, bypasses distillation |
| `POST /mcp` | Bearer | ✓ | Model Context Protocol endpoint (4 auto-discovered tools) |

## MCP tools (Claude Code auto-discovery)

The daemon exposes a **Model Context Protocol** (Streamable HTTP) endpoint at `POST /mcp`.
Claude Code discovers and calls the 4 tools below automatically when configured in `.mcp.json`.

| Tool | Description | Maps to |
|---|---|---|
| `search_memory` | Hybrid FTS + vector search with optional type/repo/project/since filters | `GET /search` |
| `recall_memory` | Top-K semantic recall (default k=5) | `POST /recall` |
| `remember` | Direct memory insert, bypasses distillation | `POST /remember` |
| `get_health` | Daemon health probe: `{ ok, version, wire_versions_supported, schema_version }` | `GET /health` |

**Plugin `.mcp.json` wiring:**

```json
{
  "mcpServers": {
    "astramem": {
      "type": "http",
      "url": "${MEMORY_API_URL}/mcp",
      "headers": { "Authorization": "Bearer ${MEMORY_BEARER}" }
    }
  }
}
```

Set `MEMORY_API_URL=http://127.0.0.1:7777` and `MEMORY_BEARER` to your token
(printed by `astra-memory token print`).

---

## Budget cap

The daily LLM spend cap (default: **$10 USD**) is enforced before each LLM call.

- Ollama always reports `$0` cost — the cap only applies to Azure usage.
- When the cap is reached, pending distillation jobs move to `paused` state. Ingest continues
  to accept transcripts (no data loss). Distillation resumes the next UTC day automatically.
- Override: `astra-memory budget --reset` (logged).
- Check current spend: `astra-memory budget`.

---

## Commands reference

| Command                                    | What it does                                       |
|--------------------------------------------|----------------------------------------------------|
| `astra-memory init`                        | Interactive wizard — writes config + secrets, runs migrations, installs service |
| `astra-memory serve [--port N]`            | Start daemon in foreground (dev/debug)             |
| `astra-memory service install`             | Register daemon as a user-scope OS service         |
| `astra-memory service status`              | Show service state                                 |
| `astra-memory service start`               | Start the service                                  |
| `astra-memory service stop`                | Stop the service                                   |
| `astra-memory service uninstall`           | Remove the service unit                            |
| `astra-memory doctor`                      | Run all health checks, print table                 |
| `astra-memory doctor --json`               | Machine-readable health check output               |
| `astra-memory search "<query>"`            | Hybrid search, print results table                 |
| `astra-memory search "<query>" --type decision` | Filter by memory type                       |
| `astra-memory recall "<question>"`         | Top-5 semantic recall (alias for search k=5)       |
| `astra-memory remember "<text>" [--type]`  | Direct insert, bypasses distillation pipeline      |
| `astra-memory queue`                       | Show pending/failed jobs                           |
| `astra-memory queue --state failed`        | Show only failed jobs                              |
| `astra-memory rebuild [--reembed]`         | Rebuild derived indexes; --reembed re-vectors all  |
| `astra-memory providers list`              | List configured providers and their health         |
| `astra-memory providers test [name]`       | Ping provider, print latency + dim                 |
| `astra-memory budget`                      | Show today and month spend vs cap                  |
| `astra-memory budget --reset`              | Clear today's spend counter (override, logged)     |
| `astra-memory token print`                 | Print the current Bearer token                     |
| `astra-memory token rotate`                | Generate new token, invalidate the old one         |

---

## Further reading

- [docs/migration-from-saas.md](docs/migration-from-saas.md) — switch the plugin from remote SaaS to local daemon
- [docs/configuration.md](docs/configuration.md) — full config.yaml reference
- [docs/providers.md](docs/providers.md) — Ollama and Azure OpenAI setup
- [docs/troubleshooting.md](docs/troubleshooting.md) — common issues and fixes
- [docs/contracts.md](docs/contracts.md) — frozen type interfaces (for contributors)
- [CHANGELOG.md](CHANGELOG.md) — release history

---

## Status

**v0.1.0** — Waves 1-4 of the implementation plan completed.

- Wave 1: SQLite schema, migration runner, FTS5, sqlite-vec, ingest endpoint, Fastify server, CLI skeleton.
- Wave 2: Job worker loop, hybrid search, service install adapters, Ollama + Azure providers.
- Wave 3: 8-stage distillation pipeline, budget tracker, Zod-validated extraction.
- Wave 4: Install wizard, cross-OS CI matrix, E2E plugin integration test, this documentation.

Spec: [astramemory-plugin/docs/superpowers/specs/2026-06-27-astramemory-local-v1-design.md](../astramemory-plugin/docs/superpowers/specs/2026-06-27-astramemory-local-v1-design.md)
