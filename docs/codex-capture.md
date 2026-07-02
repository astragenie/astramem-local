# Codex CLI capture connector (Wave 4c, ADR-008)

Ingests OpenAI Codex CLI sessions into the astramem-local distill pipeline.

**Decision (2026-07-02):** Codex first, Cursor postponed. Codex persists
sessions as open, stable JSONL under `~/.codex/sessions/`; Cursor stores
chats in a proprietary SQLite blob that breaks across updates. Cursor users
connect via MCP for recall (no capture) — point Cursor's MCP config at the
daemon's MCP endpoint.

## Usage

```sh
# One-shot: scan for new/grown sessions, ingest them, remember what was seen
astramem-local capture codex

# Options
astramem-local capture codex --sessions-dir /custom/path --dry-run --json
```

Environment: `ASTRA_MEMORY_URL` (default `http://127.0.0.1:7777`),
`ASTRA_MEMORY_TOKEN` (default `devtok`).

Run it from a shell profile hook, a scheduled task, or manually after Codex
sessions. Re-runs are always safe:

- a state file (`<dataDir>/codex-capture-state.json`) skips files that have
  not grown since the last run;
- every POST carries a content-stable `Idempotency-Key`, so even a lost
  state file only causes server-side replays, never duplicate memories.

## What gets captured

- `user` / `assistant` message turns. Tool calls, reasoning items, and
  Codex-injected context blocks (`<user_instructions>`,
  `<environment_context>`, …) are filtered out.
- Sessions need at least one real exchange (≥ 2 turns incl. an assistant
  reply) — lone prompts are skipped.
- Envelopes are `astramem-capture@1` transcript kind with `tool:
  "codex-cli"`; the daemon applies stage-0 secret redaction before
  persistence (SEC-3/5), then the full 8-stage distill pipeline runs —
  identical treatment to Claude Code captures.

## Recall side (works today, no connector needed)

Codex CLI is an MCP client. Add the daemon to `~/.codex/config.toml`:

```toml
[mcp_servers.astramem]
command = "npx"
args = ["astramem-local", "mcp"]  # or point at your daemon's MCP transport
```

Parser notes: tolerant across Codex line shapes (`session_meta` +
`response_item` wrappers, and legacy bare `message` items); unknown or
corrupt lines are skipped, never fatal.
