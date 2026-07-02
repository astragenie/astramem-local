# Memory-tool backend adapter (ADR-007 Wave 4a)

Anthropic's client-side [memory tool](https://docs.claude.com/en/docs/agents-and-tools/tool-use/memory-tool)
(tool name `memory`, commands `view` / `create` / `str_replace` / `insert` /
`delete` / `rename`) expects the *harness* — not Anthropic — to execute
file-like commands against a virtual `/memories` filesystem. This adapter
maps those commands onto astramem-local memories, so any Claude app using the
memory tool can be backed by the daemon with one HTTP call per tool
invocation.

Two pieces:

- `src/memory-tool/adapter.ts` — `handleMemoryToolCommand(db, config, cmd)`,
  the pure mapping logic (no HTTP, no async — synchronous, never throws).
- `POST /memory-tool` (`src/server/routes/memory-tool.ts`) — the bearer-authed
  REST surface a harness calls directly, one request per tool command.

## Virtual filesystem shape

```
/memories                     directory listing of "<type>.md" files
/memories/<type>.md           markdown bullet list of current valid memories
                               of that type — "- [<id>] <text>" per line
/memories/<type>.md/<id>      addresses a single memory (delete only)
```

`<type>` is one of astramem's memory types: `decision`, `fact`, `lesson`,
`command`, `todo`, `note`, `event`.

## Command mapping

| Memory-tool command | Maps to | Notes |
|---|---|---|
| `view` `/memories` | Directory listing | One line per `<type>.md` that currently has ≥1 valid (non-invalidated, non-erased) memory. Supports `view_range`. |
| `view` `/memories/<type>.md` | Rendered markdown | One bullet per current valid memory of that type, `- [<id>] <text>`. Supports `view_range` (1-indexed, `[start, end]`, `end: -1` = to EOF). |
| `create` `/memories/<type>.md` | Append **one** memory | `file_text` becomes the memory's text verbatim (after redaction). Bullet-parsing `file_text` back into multiple memories was considered and rejected as lossy — a `create` always yields exactly one new memory. Type comes from the path; an unrecognized type slug falls back to `note`. Inserted via `MemoryRepo.insertWithCreateEvent` (same service pattern as `POST /remember`), but **without** embedding metadata — the memory is FTS-searchable immediately; the vector index catches up on the next reembed pass rather than blocking the tool call on an embed round-trip. |
| `insert` `/memories/<type>.md` | Append **one** memory | Identical to `create` (`insert_text` in place of `file_text`). The memory tool's line-numbered insert semantics don't apply — there's no line-addressed document underneath, just an atom log. |
| `str_replace` `/memories/<type>.md` | Supersede | Finds the single current valid memory of that type whose text contains `old_str` (must match exactly one memory, and exactly once within it — otherwise `{error}`). Inserts a **new** memory with `old_str` replaced by `new_str`, then calls `MemoryEventRepo.supersede(oldId, newId)`. The old memory is never mutated in place — it's marked invalid with `superseded_by` pointing at the new one, preserving full history. |
| `delete` `/memories/<type>.md` | Erase all | Erases (hard delete + `erase_request` tombstone event, ADR-006 W5) every current valid memory of that type. |
| `delete` `/memories/<type>.md/<id>` | Erase one | Erases just that memory by id (must belong to the named type and currently be valid). |
| `rename` | **Not supported (v1)** | Always returns `{ error }`. A rename would mean changing an atom's type, which isn't modeled — delete and re-create under the new type-file instead. |
| Unknown command / path | — | Always returns `{ error }`, never throws. |

## REST contract

```
POST /memory-tool
Authorization: Bearer <token>
Content-Type: application/json

{ "command": "create", "path": "/memories/fact.md", "file_text": "The API key rotates every 90 days." }
```

Response is always one of:

```json
{ "content": "created memory 3f2a...-...-... in fact.md" }
```
```json
{ "error": "old_str not found in /memories/fact.md" }
```

`{content}` / `{error}` is exactly the shape a harness needs to build a
`tool_result` content block back to the model — no further translation
required. A `400` is only returned when the request body has no `command`
field at all (not a valid memory-tool command in any shape); every other
failure — bad path, unsupported command, missing field, storage conflict —
comes back as HTTP 200 with `{ error }`.

## Wiring a harness to this endpoint

The snippet below is the manual agentic-loop shape (see the `claude-api`
skill's TypeScript tool-use reference) — call `POST /memory-tool` from your
own `memory` tool executor instead of implementing `BetaAbstractMemoryTool`
locally.

### TypeScript

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const ASTRAMEM_URL = process.env.ASTRAMEM_URL ?? "http://127.0.0.1:7777";
const ASTRAMEM_TOKEN = process.env.ASTRAMEM_TOKEN!;

async function runMemoryCommand(cmd: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${ASTRAMEM_URL}/memory-tool`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ASTRAMEM_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  const body = (await res.json()) as { content?: string; error?: string };
  return body.error ?? body.content ?? "";
}

// Inside your manual tool-use loop:
for (const block of response.content) {
  if (block.type === "tool_use" && block.name === "memory") {
    const result = await runMemoryCommand(block.input as Record<string, unknown>);
    toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
  }
}
```

### Python

```python
import os
import requests

ASTRAMEM_URL = os.environ.get("ASTRAMEM_URL", "http://127.0.0.1:7777")
ASTRAMEM_TOKEN = os.environ["ASTRAMEM_TOKEN"]

def run_memory_command(cmd: dict) -> str:
    resp = requests.post(
        f"{ASTRAMEM_URL}/memory-tool",
        headers={"authorization": f"Bearer {ASTRAMEM_TOKEN}"},
        json=cmd,
        timeout=10,
    )
    body = resp.json()
    return body.get("error") or body.get("content") or ""

# Inside your manual tool-use loop:
for block in response.content:
    if block.type == "tool_use" and block.name == "memory":
        result = run_memory_command(block.input)
        tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": result})
```

Declare the tool itself with the Anthropic-defined, schema-less shape:
`{"type": "memory_20250818", "name": "memory"}` — no `input_schema`.

## Limitations

- **`rename` is unsupported.** There's no type-change operation on an atom;
  a rename request always returns `{ error }`.
- **`str_replace` is supersede, not in-place edit.** The old memory becomes
  invalid (`valid_to` set, `superseded_by` set to the new id) rather than
  being mutated — full history is preserved via the ADR-002 `memory_events`
  log (`GET /memory/:id/history`).
- **Deletes are erasure-v1 tombstones (ADR-006 W5).** `delete` hard-deletes
  the `memories` row (and its vector index entry) and appends an
  `erase_request` event as the tombstone. This is not a soft invalidate —
  the text is unrecoverable locally after the call, and re-distillation of
  the same content is blocked by the erasure replay filter.
- **`create`/`insert` never parse `file_text` as multiple memories.** One
  call always yields exactly one memory, even if the model writes what looks
  like a multi-bullet markdown list.
- **No synchronous embedding.** Memories created through this adapter are
  FTS-searchable immediately but have `embedding_provider: null` until the
  next reembed pass populates the vector index — mirrors how `/remember`
  behaves when the embed call is skipped or fails.
