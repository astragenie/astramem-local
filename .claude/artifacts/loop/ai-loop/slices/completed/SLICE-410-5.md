---
id: SLICE-410-5
feature: FEAT-410
status: completed
priority: P2
wave: 2
wave_attempts: 0
pending_fix: false
touches_files:
  - src/server/routes/dashboard-jobs-html.ts
---
# SLICE-410-5: Jobs page — kind×state matrix + failed/poison detail (wave 2, 3 pts)

Design doc: `.claude/artifacts/crew/runs/2026-07-04-dashboard-redesign-design.md` (§5 wireframe)
Parent: `.claude/artifacts/loop/backlog/triaged/FEAT-410.md`
Depends: SLICE-410-1 merged (stub + registration + queryJobStatesByKind +
queryRecentFailedJobs on main — this slice replaces the stub's render
internals ONLY).

## Objective

Fill in `src/server/routes/dashboard-jobs-html.ts`: kind × state matrix
(pending/running/completed-24h/failed/poison per kind) + failed/poison
detail table with full last_error text. Zero JS.

## Scope

Allowed: `src/server/routes/dashboard-jobs-html.ts` + its tests.
Forbidden: app.ts; queries (SLICE-410-1's exports are the contract);
importing dashboard-html.ts helpers (duplicate ~3-4 one-liners locally).

## Acceptance criteria

- AC-1 Given jobs across 4+ kinds/states, When GET /dashboard/jobs renders,
  Then the kind × state matrix shows pending/running/completed(24h)/failed/
  poison per kind.
- AC-2 Given a poison job with last_error, Then the detail table shows
  id/kind/state/attempts/last_error (untruncated)/age.
- AC-3 Given zero failed/poison jobs, Then an explicit "No failed or poison
  jobs" empty state shows.
- AC-4 Given no Authorization header and no cookie, Then 401.
- AC-5 Given a valid cookie only, Then 200.
- AC-6 Given "stuck" jobs, Then age is computed from updated_at only — no
  created→completed duration (explicitly out of scope).

## Done when

All ACs pass with test evidence; `bun run build` + `vitest run` green.
