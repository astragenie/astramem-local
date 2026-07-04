---
id: SLICE-410-2
feature: FEAT-410
status: pending
priority: P2
wave: 2
wave_attempts: 0
pending_fix: false
touches_files:
  - src/server/routes/dashboard-consolidation-html.ts
---
# SLICE-410-2: Consolidation page — list + accept/reject (wave 2, 3 pts)

Design doc: `.claude/artifacts/crew/runs/2026-07-04-dashboard-redesign-design.md` (§5 wireframe)
Parent: `.claude/artifacts/loop/backlog/triaged/FEAT-410.md`
Depends: SLICE-410-1 merged (stub module + route registration + auth-prefix
fix already on main — this slice replaces the stub's render internals ONLY).

## Objective

Fill in `src/server/routes/dashboard-consolidation-html.ts` (stubbed by
SLICE-410-1): render the pending-proposal list per the §5 wireframe with
plain per-row `<form method="post">` accept/reject targeting the EXISTING
`/consolidation/proposals/:id/accept|reject` endpoints.

## Scope

Allowed: `src/server/routes/dashboard-consolidation-html.ts` + its tests.
Forbidden: app.ts (registration already landed in SLICE-410-1); new
mutation endpoints; importing helpers from dashboard-html.ts (module-
private — duplicate the ~3-4 one-liners you need locally, e.g. esc/
truncate); any JS on the page.

## Acceptance criteria

- AC-1 Given a pending proposal (kind=merge, sim=0.94, known excerpts), When
  GET /dashboard/consolidation is requested with a valid cookie, Then the
  row renders id/kind/sim/both excerpts, HTML-escaped via a locally
  duplicated esc().
- AC-2 Given zero pending proposals, When rendered, Then an explicit "No
  pending proposals" state shows, not an empty table.
- AC-3 Given a rendered row, When its accept/reject form posts, Then it
  targets the existing /consolidation/proposals/:id/accept|reject verbatim
  (no new mutation route), and a subsequent GET reflects the new status.
- AC-4 Given a request with no Authorization header and no dashboard cookie,
  Then 401.
- AC-5 Given a request with a valid dashboard cookie only (no Bearer — the
  normal nav-link case), Then 200.
- AC-6 Given an accept/reject race (already-resolved proposal → 409, or a
  memory conflict), When posted, Then the page shows a clear error state,
  not a raw 409/500 body.

## Done when

All ACs pass with test evidence; `bun run build` + `vitest run` green.
