# ADR-008: Capture Protocol — the LSP move for agent-session memory

**Status:** accepted · **Date:** 2026-07-02 · **Confidence:** High on shape; Medium on adapter sequencing
**Context:** Cross-tool capture is the verified neutrality wedge (strategy Pass 5: single-tool
memory is what the platforms bundle; memory that survives tool choice is what they structurally
won't build). runner-plugin must become an adapter (final verdict). The design reference is LSP
(constraint C5): a thin protocol that made one capability work across every editor.

## Decision

Define **`astramem-capture@1`** — the minimal contract ANY tool can speak to feed the daemon:

```jsonc
POST /ingest/transcript
{
  "protocol": "astramem-capture@1",
  "tool": "claude-code | codex-cli | cursor | runner-plugin | <registered>",
  "session_id": "opaque",
  "repo": "…", "project": "…",          // best-effort context
  "kind": "transcript | events",        // two payload kinds, below
  "content": …
}
```

- **`transcript` kind:** raw session text/turns (today's path). The daemon owns ALL intelligence
  (redaction, distillation) — adapters stay dumb translators. A new tool integration is a
  ~100-line adapter, not a fork of the pipeline.
- **`events` kind (NEW):** pre-typed atom candidates for sources that already know their
  semantics — runner-plugin emits `slice_completed`, `review_verdict`, `grade`, `lesson` as
  atom-shaped events (ADR-001 fields, `provenance.tool="runner-plugin"`). These skip stages 1–5
  and enter at reduce/normalize — the graded-exhaust pathway that feeds procedural memory
  (ADR-010, strategy Pass 3 P3).

**Ownership matrix (nothing overlaps):**

| Responsibility | Owner |
|---|---|
| Capture at tool surface | Adapters (runner-plugin, Claude Code plugin, future Codex/Cursor) |
| Redaction, formation, storage, retrieval, policy | astramem-local daemon |
| Team/org ledger, workspaces, audit, retention | AstraMem cloud |
| Work grading / slice orchestration | AstraRunner + runner-plugin (internal), exhaust flows in as `events` |
| Cross-agent memory access | MCP + memory-tool adapter (ADR-007) |

**Adapter sequencing:** 1) runner-plugin `events` (starts the flywheel, 90-day plan) →
2) tighten the existing Claude Code hook capture → 3) one external tool (Codex CLI or Cursor,
whichever has the cleaner session-export surface at build time) to make neutrality demonstrable.

## Options considered

1. **Thin versioned capture protocol, dumb adapters (chosen).** N tools scale at adapter cost;
   quality improvements land once, centrally.
2. **Smart adapters (per-tool extraction).** Rejected: N implementations of the crown jewel,
   divergence guaranteed, C1 violated.
3. **File-watching capture (tail tool logs/dirs without adapters).** Rejected as primary
   (fragile, undocumented formats, consent-ambiguous — ADR-009); acceptable as a stopgap inside
   a specific adapter where a tool offers no hook.

## Consequences & migration

- Wire envelope already versioned (v0.2.0 wire-v1) — evolve to `capture@1` with `kind` field;
  additive.
- runner-plugin work: emit `events` at slice-complete/grade ceremonies (its artifacts already
  contain everything; this is serialization, not new logic).
- Docs: "write an adapter" page = the ecosystem invitation. The protocol doc is public by design.
  See [docs/capture-protocol.md](../capture-protocol.md) for the envelope reference, both kinds,
  and a runner-plugin `events` curl example.

## Addendum (2026-07-14, FEAT-495 item 2): cursor/watermark convention for future watched-directory or event-stream capture modes

Today's sources (Claude Code hook capture, Codex, the LLM-proxy) have **no cursor concept at
all** — each is a synchronous, hook-fired read of one already-complete transcript/turn, not a
resumable stream. There is nothing to initialize, so this convention is **N/A for them by
construction**; it exists for the file-watching stopgap option 3 above ever gets built (FEAT-489's
possible watched-folder mode, FEAT-491), or any other future source that maintains a resumable
position (a cursor, offset, or watermark) into a stream or directory of historical content:

**Any such source MUST initialize its cursor/watermark to "now" the first time it sees a given
directory/stream, never to "the beginning."** Enabling capture for a source must only ever start
capturing NEW activity going forward — it must never replay a backlog of historical content that
predates the moment capture was turned on. This mirrors the existing convention
`src/sync/puller.ts`'s pull watermark and `src/sync/shipper.ts`'s ship cursor already follow (both
start from "nothing shipped/pulled yet," never "replay all history"), generalized to any future
capture source that isn't itself a sync channel.

Rationale: a user enabling a new capture source is opting into observation from that point
forward, not retroactively. Silently ingesting months of pre-existing file/log history the moment
a watcher starts would be both a surprising privacy behavior and a redaction-and-distillation cost
spike with no corresponding "the user asked for this" signal — the daemon has no way to tell
"pre-existing content the user never intended to capture" apart from "content generated after
they opted in" except by the enable-time boundary itself.
