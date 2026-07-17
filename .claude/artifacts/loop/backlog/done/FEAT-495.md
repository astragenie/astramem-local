---
id: FEAT-495
status: done
priority: null
category: platform
target_release: null
created: 2026-07-14
updated: 2026-07-14
depends_on: []
slices: []
derived_from: memory repo docs/research/2026-07-14-screenpipe-deep-dive.md
---
# FEAT-495: Beta-hardening bundle — migration self-heal, cursor-to-now audit, json_valid guards, handler run-log

## Description

Four small, independent hardening items from the 2026-07-14 research (Screenpipe patterns studied
+ own dormant-seams lesson), bundled for one slice:

1. **Migration self-heal check**: after migrations run on boot, verify expected columns exist
   (pragma_table_info) and `ALTER TABLE ADD COLUMN` any a partially-applied earlier migration
   missed — SQLite has no ADD COLUMN IF NOT EXISTS; a partially-applied migration in the field is
   otherwise unrecoverable without support intervention.
2. **Cursor-inits-to-now CONVENTION** (reworded per arch review 2026-07-14: existing sources
   claude/codex/proxy have NO cursor concept — they are hook-fired synchronous reads; audit
   outcome for them is N/A by construction). The item's real value: document the convention —
   any future watched-directory or event-stream capture mode (FEAT-489's possible watched-folder
   mode, FEAT-491) initializes its watermark to "now" on first sight, never to "beginning";
   enabling a source must never replay historical backlog.
3. **json_valid guards**: enumerate the JSON columns read by shared query paths and fed by
   BOTH local writes and the sync path FIRST (arch review: the enumeration is real scoping work,
   the FEAT names none today), then guard each with a `json_valid(...) ELSE '[]'` style read so
   one malformed row cannot break a shared endpoint.
4a. **Per-run observability for pipeline handlers** (schema+code): a run-log (handler, status,
   duration, error_type/message) queryable by doctor — makes "built, wired, never invoked" and
   "silently failing every run" both visible.
4b. **Dormant-seams sweep** (one-time manual audit, SEPARATE deliverable per arch review — its
   output is a disposition list someone must actually read, not an absorbed "done"): grep
   `enabled:` flags and stub branches, disposition each (sibling of cloud FEAT-523).

## Acceptance hints

- Each item independently testable; bundle may split into slices if any grows.
- Doctor surfaces: self-heal actions taken, per-handler last-run status.
- No behavior change for healthy state — pure hardening.

## Notes

All S-effort items; none block each other or anything else.

> **Closed 2026-07-17 — reconciled shipped-but-open.** shipped 96bdad20 (#322)
