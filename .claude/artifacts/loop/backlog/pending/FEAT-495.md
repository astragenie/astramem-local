---
id: FEAT-495
status: pending
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
2. **Cursor-inits-to-now audit**: verify every capture source's cursor initializes to "now" on
   first sight, never to "beginning" — enabling a new source must never replay historical backlog.
   Audit existing sources (claude/codex/proxy) + make it the documented convention for FEAT-489/491.
3. **json_valid guards**: any JSON column read by shared query paths and fed by BOTH local writes
   and the sync path gets a `json_valid(...) ELSE '[]'` style guard so one malformed row cannot
   break a shared endpoint for everything.
4. **Per-run observability for pipeline handlers**: a run-log (handler, status, duration,
   error_type/message) queryable by doctor — makes "built, wired, never invoked" and "silently
   failing every run" both visible. Include a local dormant-seams sweep: grep `enabled:` flags and
   stub branches, disposition each (sibling of cloud FEAT-523).

## Acceptance hints

- Each item independently testable; bundle may split into slices if any grows.
- Doctor surfaces: self-heal actions taken, per-handler last-run status.
- No behavior change for healthy state — pure hardening.

## Notes

All S-effort items; none block each other or anything else.
