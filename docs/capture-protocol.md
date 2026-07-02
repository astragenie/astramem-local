# Capture protocol (`astramem-capture@1`)

astramem-local accepts session capture from any tool that can speak one small
HTTP contract. This is the "write an adapter" invitation: a new tool
integration is a ~100-line translator, not a fork of the daemon's
redaction/distillation pipeline. Design rationale: [ADR-008](adr/ADR-008-capture-protocol.md).

## Endpoint

```
POST /ingest/transcript
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: <optional, recommended>
```

## Envelope

Every request is an `astramem-capture@1` envelope:

```jsonc
{
  "event": "pre_compact | session_end | subagent_stop",
  "session_id": "opaque session identifier",
  "project_id": "your project/repo identifier",
  "agent_type": "claude-code",          // optional
  "cwd": "/path/to/project",            // optional
  "captured_at": "2026-07-02T10:00:00.000Z",
  "kind": "transcript | events",        // optional, defaults to "transcript"
  "tool": "runner-plugin",              // optional provenance — no default, record what's sent
  "client_scrub_applied": true,
  "client_scrub_hits": 0,
  "client_version": "0.6.0",
  "client_scrub_version": "1.2.0",
  "wire_version": "v1.0",
  // ... plus "turns" or "events" below, depending on "kind"
}
```

`wire_version` must match `^v(?:0|[1-9][0-9]*)\.[0-9]+$` (e.g. `"v1.0"`).

The daemon owns **all** intelligence — redaction, distillation, storage,
retrieval, policy. Adapters stay dumb translators: capture whatever the tool
surface gives you, shape it into one of the two kinds below, POST it.

## Kind: `transcript` (default)

Raw session text as turns. The daemon runs the full 8-stage distillation
pipeline (cleanup → normalize → chunk → compact → extract → reduce →
memory-normalize → embed+index) to produce memories.

```jsonc
{
  "kind": "transcript",   // or omit — this is the default
  "turns": [
    { "role": "user", "text": "what vector store should we use?" },
    { "role": "assistant", "text": "sqlite-vec — no network dependency." }
  ]
  // ...envelope fields above
}
```

`turns` must be a non-empty array of `{ role: "user" | "assistant", text, ts? }`.

## Kind: `events` (pre-typed atom candidates)

For sources that already know their semantics — runner-plugin slice grades,
lessons, review verdicts — skip the extraction guesswork. `events` are
atom-shaped payloads that **skip pipeline stages 1–5** (the raw-text and
LLM stages) and enter directly at stage 6 (reduce), the graded-exhaust
pathway that feeds procedural memory (ADR-010).

```jsonc
{
  "kind": "events",
  "tool": "runner-plugin",
  "events": [
    {
      "type": "lesson",
      "text": "Bun does not support better-sqlite3 native bindings on Windows in CI.",
      "importance": 0.8,
      "confidence": 0.95,
      "evidence": "npm test failed: better_sqlite3.node is not a valid Win32 application"
    },
    {
      "type": "decision",
      "text": "SLICE-2d graded PASS — events capture kind ships stages 6-8 only, no schema change.",
      "importance": 0.6
    }
  ]
  // ...envelope fields above
}
```

Each event:

| field | required | notes |
|---|---|---|
| `type` | yes | one of `decision`, `fact`, `lesson`, `command`, `todo`, `note`, `event` |
| `text` | yes | non-empty string |
| `importance` | no | `0.0`–`1.0`, defaults to `0.7` |
| `confidence` | no | `0.0`–`1.0`, defaults to `0.9` |
| `evidence` | no | short excerpt supporting the atom |
| `occurred_at` | no | epoch ms, when the event happened (vs. when it was captured) |

`events` must be a non-empty array, capped at 500 events per request.

Both `text` and `evidence` pass through the same stage-0 secret-redaction
choke point as `transcript` turns — a leaked token in a lesson gets
`[REDACTED:...]`'d exactly like one in a chat turn.

## curl example — runner-plugin emitting a grade + lesson

```bash
curl -X POST http://127.0.0.1:7777/ingest/transcript \
  -H "Authorization: Bearer $ASTRA_MEMORY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: slice-2d-grade-$(date +%s)" \
  -d '{
    "event": "session_end",
    "session_id": "runner-slice-2d-001",
    "project_id": "astramem-local",
    "captured_at": "2026-07-02T10:00:00.000Z",
    "kind": "events",
    "tool": "runner-plugin",
    "client_scrub_applied": false,
    "client_scrub_hits": 0,
    "client_version": "0.1.0",
    "client_scrub_version": "n/a",
    "wire_version": "v1.0",
    "events": [
      {
        "type": "lesson",
        "text": "JobKind is an unconstrained TEXT column — new job kinds never need a migration.",
        "importance": 0.7,
        "confidence": 0.9
      },
      {
        "type": "event",
        "text": "SLICE-2d graded PASS: events capture kind, 0 schema migrations.",
        "importance": 0.5
      }
    ]
  }'
```

Response (200):

```json
{ "ok": true, "summary_memory_id": "<transcript-id>", "session_id": "runner-slice-2d-001", "idempotent": false }
```

## Write an adapter

A new tool integration is: capture at the tool surface (hook, plugin, CLI
wrapper — whatever the tool exposes), shape into one `astramem-capture@1`
envelope per session boundary, POST it here. That's the whole contract.
See [ADR-008](adr/ADR-008-capture-protocol.md) for the ownership matrix and
adapter sequencing (runner-plugin `events` → tightened Claude Code hook →
one external tool).
