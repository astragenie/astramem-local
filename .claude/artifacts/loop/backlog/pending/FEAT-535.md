---
id: FEAT-535
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-16
updated: 2026-07-16
depends_on: []
slices: []
derived_from: null
github_issue: null
github_milestone: null
github_url: null
---
# FEAT-535: Dashboard "Ingestions" page — browse every ingestion, view source, re-extract

## Description

A new dashboard page under the ingest section listing every ingestion, with:
- source navigation (open the saved transcript text / document / audio file the ingestion came from),
- a re-extract action (re-run distill on the retained source → fresh atoms),
- project + time-range filters,
- reusing the existing jobs table + jobs dashboard page rather than new infra.

## Feasibility (scanned 2026-07-16 — the data + infra already exist)

- **Source IS retained**: `transcripts` table (migration 001) stores ingested
  transcript text keyed by `session_id`, with `event`/`captured_at`. Audio &
  document artifacts live on disk at `<dataDir>/artifacts/<kind>/<file>` (see
  src/storage/retention.ts — a plain directory layout, not a DB registry).
- **Ingestion TYPE is known**: `capture_source` enum on the distill path
  (`auto_capture | hook_close | proxy | audio_transcribe | meeting_captions`)
  — drives the "document vs text chunk vs audio" navigation.
- **Project + time already present**: `sessions.project` + `captured_at` →
  the requested project/time controls come free.
- **Jobs page exists to extend**: `src/server/routes/dashboard-jobs-html.ts`
  + `dashboard-nav.ts` + the `dashboard-*-html.ts` page pattern. Add an
  `dashboard-ingestions-html.ts` + a nav entry.
- **Re-extract path exists to reuse**: `cli/rebuild.ts` / `reembed-dim.ts`
  already enqueue jobs; re-extract = enqueue a fresh `distill` job pointing
  at the retained transcript/artifact (same jobs table + distillHandler).

## Requested capability

1. `GET /dashboard/ingestions` — paginated list of ingestions (one row per
   `transcripts` record / distill job), columns: time (captured_at),
   project, agent, source type (capture_source), atom yield (# memories from
   that session_id), source-availability status.
2. Filters: project dropdown, agent, time-range (reuse the search dashboard's
   date-range control), source-type.
3. Row → source view: text ingestions render the stored transcript; audio →
   link/serve the `<dataDir>/artifacts/audio/<file>`; document → its path.
   Gate on source-availability (see risk below).
4. Row → "Re-extract": enqueues a fresh distill job on the retained source
   (reuse the jobs table; surface the new job on the existing jobs page).
   Idempotency: a re-extract should supersede/dedupe against prior atoms from
   that session, not duplicate them (check consolidation/idempotency path).
5. Pagination + bounded queries (the transcripts table grows unbounded —
   index-backed, LIMIT/OFFSET like the #372 consolidation-proposals pattern).

## Risks / open questions

- **Source availability**: does retention (`src/storage/retention.ts`,
  FEAT-489/493 tiered retention) PRUNE old transcripts/artifacts? If yes,
  re-extract is impossible for pruned ingestions — the page MUST show
  source-available vs source-pruned per row and disable re-extract when gone.
  Confirm the transcripts retention policy before building.
- **Re-extract dedup**: re-running distill on the same source must not
  double-store atoms — needs the supersede/consolidation path, or an explicit
  "replace prior atoms from this session" semantics. Design decision.
- **Audio/document serving**: serving a file from `<dataDir>/artifacts/`
  through the dashboard needs a safe path-scoped file route (no traversal).
- **Auth**: dashboard-auth already gates the dashboard; the new route inherits
  it. A file-serve route for artifacts needs the same gate.

## Out of scope (v1)

- Editing/annotating ingested source.
- Bulk re-extract (single-row v1; bulk is a follow-up like #372's batch tool).

## Notes

Filed 2026-07-16 during the boot-race incident — NOT built; queued behind the
#396/#397 fix + v0.19.0 release. Scoped from a live feasibility scan.
