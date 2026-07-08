# AstraMemory Local

Local-first memory daemon for AI coding agents — wire-compatible with [astramem-plugin](https://github.com/astragenie/astramem-plugin) (v0.5.2+). Current daemon release: v0.8.1.

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

## Quick start

```bash
git clone https://github.com/astragenie/astramemory-local.git
cd astramemory-local
bun install
bun run build
node dist/cli/index.js init
# follow the wizard — picks Ollama or Azure, writes config.yaml + secrets.env
node dist/cli/index.js service install
export MEMORY_API_URL=http://127.0.0.1:7777
export MEMORY_BEARER=$(node dist/cli/index.js token print)
```

> **First run takes 10-30 minutes if Ollama isn't installed yet.** The wizard's default Ollama
> tier pulls `qwen2.5-coder:7b` (~4.7 GB) plus `mxbai-embed-large` (~670 MB) — about **5.4 GB**
> total — with no separate confirmation prompt. Install and start Ollama first
> (see [docs/providers.md](docs/providers.md)) if you'd rather not wait mid-wizard.

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

Canonical ~10-value `type` registry (U4 contract-unification, ADR D4),
single-sourced in `@astragenie/astramem-contracts`
(`contracts/schemas/atom.v1.schema.json`) and mirrored in
`src/contracts/memory.ts` `MEMORY_TYPES`. astramem-local writes the first 7
today; the last 3 are cloud-authored types local can read (e.g. via sync)
but does not yet produce.

| Type          | Description                                            | Example                                      | Ships from            |
|---------------|---------------------------------------------------------|-----------------------------------------------|------------------------|
| `decision`    | Architectural or design choice made during a session   | "Use sqlite-vec for v1 vector storage"       | local                  |
| `fact`        | Objective project fact, configuration detail           | "Port 7777 is the default daemon port"       | local                  |
| `lesson`      | Something that went wrong and how it was resolved      | "sqlite-vec rowid must match memories rowid" | local                  |
| `command`     | CLI command or script worth remembering                | "bun run build && bun run test -- migrate"   | local                  |
| `todo`        | Outstanding work item surfaced in conversation         | "Add reembed job when provider changes"      | local                  |
| `note`        | Freeform observation not fitting another type           | "Team prefers PRs under 400 lines"           | local                  |
| `event`       | Something that happened at a point in time              | "Deployed v0.8.1 to prod"                     | local                  |
| `preference`  | User/agent preference atom                               | "User prefers terse commit messages"          | cloud only (today)     |
| `task_result` | Outcome of a completed task                              | "Migration 014 applied cleanly"               | cloud only (today)     |
| `summary`     | Session/thread summary atom                              | "Summary of the FEAT-424 filter-unification session" | cloud only (today) |

---

## Provider matrix

| Concern         | Ollama (local, free)                     | Azure OpenAI (cloud)                         |
|-----------------|------------------------------------------|----------------------------------------------|
| LLM compaction  | qwen2.5-coder:7b (default)              | gpt-4.1 or any deployment                   |
| LLM extraction  | qwen2.5-coder:7b (default)              | gpt-4.1 or any deployment                   |
| Embedding       | mxbai-embed-large (1024-dim)             | text-embedding-3-small (1024 via dimensions) |
| Cost            | $0 (local inference)                     | ~$0.02/1K tokens + $0.0001/1K embed tokens  |
| Setup           | `ollama serve` + `ollama pull <model>`   | Azure portal + endpoint + deployment name    |

Providers are configurable independently per stage. Embedding provider is system-wide — switching
requires `astramem-local rebuild --reembed` to re-index all memories in the new model's vector space.

See [docs/providers.md](docs/providers.md) for full setup instructions.

---

## Public endpoints

All endpoints require Bearer token authentication except `GET /version` and `GET /health`.
`GET /dashboard` additionally accepts an `HttpOnly` session cookie, bootstrapped via a one-time
`?token=` visit (see [Dashboard](#dashboard) below).

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` | — | Daemon health probe: `{ ok, version, wire_versions_supported, schema_version }` |
| `GET /version` | — | Version discovery: `{ name, version, wire_versions_supported, schema_version, ts }` |
| `POST /ingest/transcript` | Bearer | Capture protocol endpoint — accepts `transcript` and `events` kinds; idempotency via `Idempotency-Key` header. See [docs/capture-protocol.md](docs/capture-protocol.md). |
| `GET /search` | Bearer | Hybrid search with type/repo/project/since filters |
| `POST /recall` | Bearer | Top-K semantic recall (alias: `search` with k=5) |
| `POST /recall/pack` | Bearer | Token-budgeted memory pack for a repo/project/branch — powers the SessionStart hook |
| `POST /remember` | Bearer | Direct memory insert, bypasses distillation |
| `GET /memory/:id` | Bearer | Single memory lookup |
| `GET /memory/:id/why` | Bearer | Provenance receipt — extraction evidence + confidence for a memory |
| `GET /memory/:id/history` | Bearer | Full `memory_events` log for a memory (invalidate/supersede/promote chain) |
| `POST /memory/:id/invalidate` | Bearer | Soft-delete a memory (lifecycle op) |
| `POST /memory/:id/supersede` | Bearer | Replace a memory with a newer one, linked via `memory_events` |
| `POST /memory/:id/promote` | Bearer | Promote a memory's scope: personal → team → org |
| `POST /memory/:id/used` | Bearer | Record an explicit recall-usefulness signal for a memory |
| `GET /sessions/:id/digest` | Bearer | Session summary digest |
| `GET /dashboard` | Bearer, cookie, or one-time `?token=` bootstrap | Read-only HTML metrics dashboard, auto-refreshing every 5s |
| `POST /mcp` | Bearer | Model Context Protocol endpoint (auto-discovered tools, see below) |

## MCP tools (Claude Code auto-discovery)

The daemon exposes a **Model Context Protocol** (Streamable HTTP) endpoint at `POST /mcp`.
Claude Code discovers and calls the tools below automatically when configured in `.mcp.json`.

| Tool | Description | Maps to |
|---|---|---|
| `search_memory` | Hybrid FTS + vector search with optional type/repo/project/since filters | `GET /search` |
| `recall_memory` | Top-K semantic recall (default k=5) | `POST /recall` |
| `remember` | Direct memory insert, bypasses distillation | `POST /remember` |
| `get_health` | Daemon health probe: `{ ok, version, wire_versions_supported, schema_version }` | `GET /health` |
| `why_memory` | Provenance receipt — extraction evidence + confidence for a memory | `GET /memory/:id/why` |
| `session_digest` | Session summary digest | `GET /sessions/:id/digest` |
| `invalidate_memory` | Soft-delete a memory (lifecycle op) | `POST /memory/:id/invalidate` |
| `supersede_memory` | Replace an old memory with a new one, linked via `memory_events` | `POST /memory/:id/supersede` |
| `promote_memory` | Promote a memory's scope: personal → team → org | `POST /memory/:id/promote` |
| `memory_history` | Full `memory_events` log for a memory | `GET /memory/:id/history` |
| `submit_feedback` | Explicit recall-usefulness signal — "this memory mattered" (U5 canonical name, shared with cloud) | `POST /memory/:id/used` |
| `mark_memory_used` | **DEPRECATED** one-release alias for `submit_feedback` (same handler) — migrate now | `POST /memory/:id/used` |

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
(printed by `astramem-local token print`).

---

## Budget cap

The daily LLM spend cap (default: **$10 USD**) is enforced before each LLM call.

- Ollama always reports `$0` cost — the cap only applies to Azure usage.
- When the cap is reached, pending distillation jobs move to `paused` state. Ingest continues
  to accept transcripts (no data loss). Distillation resumes the next UTC day automatically.
- Override: `astramem-local budget --reset` (logged).
- Check current spend: `astramem-local budget`.

---

## Security

### Encryption at rest

`memory.sqlite` is encrypted by default using `better-sqlite3-multiple-ciphers` (SQLCipher-compatible
cipher driver). The 32-byte key is resolved through a provider chain:

1. **OS credential store** — Windows Credential Manager / macOS Keychain / Linux libsecret, via
   `@napi-rs/keyring`.
2. **Key-file fallback** — `<configDir>/db.key` (mode `0600`) with a WARN log, used only when the
   credential store throws (e.g. headless Linux with no secret-service session).

A pre-existing plaintext `memory.sqlite` (from a version predating encryption) is **auto-migrated**
transparently on daemon startup: the file is checkpointed, re-keyed via `PRAGMA rekey`, and
verified (row-count match) before the encrypted copy replaces the original. The pre-migration
plaintext file is preserved at `memory.sqlite.pre-encryption.bak` — nothing is deleted. Migration
is idempotent; an already-encrypted file is a no-op.

Disabling encryption (`security.encryption.enabled: false`) is a deliberate trust trade-off — the
daemon logs a prominent WARN at startup, and `astramem-local doctor` reports
`encryption: OFF — memory.sqlite is stored in PLAINTEXT`.

### Stage-0 secret redaction

Every transcript turn and manual `/remember` write passes through a redaction choke point *before*
it is persisted — downstream pipeline stages only ever see already-redacted text. Detection runs in
three passes:

1. **PEM private-key blocks** (multiline, whole block).
2. **Vendor/pattern detectors** — AWS access keys, GitHub tokens, Azure storage keys/SAS tokens, GCP
   API keys, Slack tokens, JWTs, generic `key=value` credentials, connection-string userinfo — plus
   any org-specific regexes from `security.redaction.customPatterns`.
3. **Shannon-entropy fallback** — flags high-entropy strings (default threshold 4.0 bits/char) that
   pattern detectors missed.

Matches are replaced with a placeholder — `[REDACTED:<type>:<hash8>]`, where `hash8` is the first 8
hex chars of `SHA-256(secret value)` — so the same secret always redacts to the same placeholder
(dedup-safe) while the raw value is **never stored or logged**. Only counts are persisted, in the
`redaction_log` table (`type`, `count`, `session_id`, `created_at`) — `astramem-local doctor` surfaces
a 7-day breakdown, e.g. `redaction: on — 12 secrets redacted (3 aws_access_key, 9 generic_credential) in last 7d`.
Toggle with `security.redaction.enabled` (default `true`).

### Bearer token storage

The daemon's Bearer token is stored the same way as the DB encryption key: OS credential store
first, `secrets.env` (mode `0600`) only as a fallback when the credential store is unavailable. A
token found only in `secrets.env` is opportunistically promoted into the credential store the next
time the daemon resolves it — `secrets.env` itself is never rewritten or deleted as part of that
promotion.

---

## Capture protocol

`astramem-local` accepts session capture from any tool that can speak one small HTTP contract —
`POST /ingest/transcript` with an `astramem-capture@1` envelope. Two kinds are supported:

- **`transcript`** (default) — raw turns, run through the full 8-stage distillation pipeline.
- **`events`** — pre-typed atom candidates (decision/fact/lesson/command/todo/note/event) that skip
  the raw-text/LLM stages and enter directly at the reduce stage. Built for sources that already
  know their own semantics (e.g. `runner-plugin` slice grades and lessons).

Both kinds pass through the same stage-0 redaction choke point described above. Writing a new tool
integration is a small translator — capture at the tool surface, shape into one envelope per session
boundary, POST it. See [docs/capture-protocol.md](docs/capture-protocol.md) for the full contract,
field reference, and a curl example.

---

## Memory lifecycle

Every memory has an append-only history in the `memory_events` log. Lifecycle operations never
delete a row — they append an event and update derived state:

| Operation | Effect |
|---|---|
| **Invalidate** | Soft-deletes a memory (optionally with a reason) — it stops surfacing in search/recall. |
| **Supersede** | Replaces an old memory with a new one; the two are linked via the event log. |
| **Promote** | Widens a memory's scope: `personal` → `team` → `org` (downward/same-scope transitions are rejected). |

`GET /memory/:id/history` (and the `memory_history` MCP tool) return the full event chain for a
memory — the complete invalidate/supersede/promote provenance trail.

**`why_memory` receipts** (`GET /memory/:id/why`, MCP `why_memory`) answer "why does the daemon
believe this?" — they return the extraction evidence and confidence that produced the memory, so a
recalled fact or decision can be traced back to its source.

---

## Usefulness metric

The daemon tracks a **recall-usefulness rate**: of the memories served by a search/recall/pack call,
how many were later marked as actually used (`POST /memory/:id/used`, MCP `submit_feedback` — or its
deprecated one-release alias `mark_memory_used` — or the REST twin). The rate is
`distinct atoms used / distinct atoms served` in a given time window, computed per memory type and
per surface (`mcp` / `rest` / `cli`).

This is a **v1 measure-only signal** — it does not yet feed ranking (see ADR-010). Query text is
never stored; only a truncated SHA-256 digest of the query is kept alongside the served/used events,
themselves appended to the same `memory_events` log lifecycle operations use.

---

## Dashboard

`GET /dashboard` serves a single-file, auto-refreshing (every 5s) HTML metrics page — no
JavaScript, no CDN, no external assets, dark mode by default. It shows memory counts by type,
recent captures, job-queue state, distill throughput, provider health, today/MTD budget spend vs
cap, and the pending-capture queue depth.

Auth accepts either the usual `Authorization: Bearer <token>` header, or an `HttpOnly` session
cookie. To open the dashboard directly in a browser (which can't set an `Authorization` header),
visit it once with `?token=<bearer>` — the daemon exchanges that for the cookie via a 302 redirect
to the clean URL, so the bearer never persists in browser history or gets re-sent by the
`<meta refresh>` poll. A missing or wrong credential returns a plain-text 401, never HTML, and the
query string is stripped from the log line so a wrong `?token=` guess doesn't persist a candidate
secret.

---

## Commands reference

| Command                                    | What it does                                       |
|--------------------------------------------|----------------------------------------------------|
| `astramem-local init [--no-hook]`            | Interactive wizard — writes config + secrets, runs migrations, installs service, offers the SessionStart memory-pack hook |
| `astramem-local serve [--port N]`            | Start daemon in foreground (dev/debug)             |
| `astramem-local service install`             | Register daemon as a user-scope OS service         |
| `astramem-local service status`              | Show service state                                 |
| `astramem-local service start`               | Start the service                                  |
| `astramem-local service stop`                | Stop the service                                   |
| `astramem-local service uninstall`           | Remove the service unit                            |
| `astramem-local doctor`                      | Run all health checks, print table                 |
| `astramem-local doctor --json`               | Machine-readable health check output               |
| `astramem-local search "<query>"`            | Hybrid search, print results table                 |
| `astramem-local search "<query>" --type decision` | Filter by memory type                       |
| `astramem-local recall "<question>"`         | Top-5 semantic recall (alias for search k=5)       |
| `astramem-local remember "<text>" [--type]`  | Direct insert, bypasses distillation pipeline      |
| `astramem-local queue`                       | Show pending/failed jobs                           |
| `astramem-local queue --state failed`        | Show only failed jobs                              |
| `astramem-local rebuild [--reembed]`         | Rebuild derived indexes; --reembed re-vectors all  |
| `astramem-local providers list`              | List configured providers and their health         |
| `astramem-local providers test [name]`       | Ping provider, print latency + dim                 |
| `astramem-local budget`                      | Show today and month spend vs cap                  |
| `astramem-local budget --reset`              | Clear today's spend counter (override, logged)     |
| `astramem-local token print`                 | Print the current Bearer token                     |
| `astramem-local token rotate`                | Generate new token, invalidate the old one         |

---

## Further reading

- [docs/migration-from-saas.md](docs/migration-from-saas.md) — switch the plugin from remote SaaS to local daemon
- [docs/configuration.md](docs/configuration.md) — full config.yaml reference
- [docs/providers.md](docs/providers.md) — Ollama and Azure OpenAI setup
- [docs/capture-protocol.md](docs/capture-protocol.md) — `astramem-capture@1` wire contract (`transcript` + `events` kinds)
- [docs/hooks/memory-pack.md](docs/hooks/memory-pack.md) — SessionStart memory-pack hook (auto-installed by `init`)
- [docs/troubleshooting.md](docs/troubleshooting.md) — common issues and fixes
- [docs/contracts.md](docs/contracts.md) — frozen type interfaces (for contributors)
- [CHANGELOG.md](CHANGELOG.md) — release history

---

## Development

This project uses [Bun](https://bun.sh/) as the package manager and script runner.

```bash
bun install          # install dependencies
bun run build        # compile TypeScript → dist/
bun run test         # run the vitest suite
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for build/test/PR conventions, including the maintainer
publishing flow.

---

## Status

**v0.8.1** — local-first memory daemon with 17 migrations, a 15-tool MCP surface, hybrid
BM25+vector+importance+freshness search, event-sourced memory lifecycle (invalidate/supersede/
promote) with full provenance (`why_memory`), consolidation proposals, and local↔SaaS sync
(shipper/puller/conflict-resolve). CI-gated retrieval eval (ADR-005) runs recall@10 ≥ 0.9 /
NDCG@10 ≥ 0.7 floors on every push.

Companion plugin: [github.com/astragenie/astramem-plugin](https://github.com/astragenie/astramem-plugin)
