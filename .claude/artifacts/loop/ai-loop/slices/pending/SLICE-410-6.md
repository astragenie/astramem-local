---
id: SLICE-410-6
feature: FEAT-410
status: pending
priority: P2
wave: 2
wave_attempts: 0
pending_fix: false
touches_files:
  - src/server/routes/dashboard-search-html.ts
---
# SLICE-410-6: Search debug page — GET form + score table (wave 2, 2 pts)

Design doc: `.claude/artifacts/crew/runs/2026-07-04-dashboard-redesign-design.md` (§5 wireframe)
Parent: `.claude/artifacts/loop/backlog/triaged/FEAT-410.md`
Depends: SLICE-410-1 merged (stub + registration) AND SLICE-410-3 merged
(search debug option + exported debug result type — that type is your
contract).

## Objective

Fill in `src/server/routes/dashboard-search-html.ts`: plain GET `<form>`
(query in URL) rendering the per-candidate fusion score table from
SLICE-410-3's `debug: true` search path, plus the current fuse.ts weights.
Zero JS.

## Scope

Allowed: `src/server/routes/dashboard-search-html.ts` + its tests.
Forbidden: app.ts; search.ts/fuse.ts (SLICE-410-3's export is the
contract); importing dashboard-html.ts helpers (duplicate locally).

## Acceptance criteria

- AC-1 Given GET /dashboard/search?query=... non-empty, Then the table shows
  id/source/bm25(norm)/cosine(norm)/importance/freshness/fused/rank from the
  debug:true output.
- AC-2 Given no query param (initial load), Then the form + current fuse.ts
  weights show with no results table (not an error).
- AC-3 Given a query with zero candidates, Then an explicit "no results"
  state shows.
- AC-4 Given the embed provider down, Then the page renders FTS-only rows
  (cosine at the documented sentinel), not a 500.
- AC-5 Given no Authorization header and no cookie, Then 401.
- AC-6 Given a valid cookie only, Then 200.

## Done when

All ACs pass with test evidence; `bun run build` + `vitest run` green.
