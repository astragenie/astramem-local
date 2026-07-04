---
id: SLICE-410-4
feature: FEAT-410
status: completed
priority: P2
wave: 2
wave_attempts: 0
pending_fix: false
touches_files:
  - src/server/routes/dashboard-html.ts
---
# SLICE-410-4: Mission Control render rewrite (wave 2, 5 pts)

Design doc: `.claude/artifacts/crew/runs/2026-07-04-dashboard-redesign-design.md` (§4 mockup — follow it)
Parent: `.claude/artifacts/loop/backlog/triaged/FEAT-410.md`
Depends: SLICE-410-1 merged — code against its ACTUAL exported DTO types in
src/server/queries/dashboard.ts, not the design-doc mockup shapes.

## Objective

Rewrite `renderDashboard` in `src/server/routes/dashboard-html.ts` as the
Mission Control layout: status banner (subsystem rollup), pipeline-stage
row (ingest → distill → entity-link → embed → consolidate → index),
jobs/consolidation/providers strip, collapsed budget tile + 7d usefulness
tile, merged recent-activity/errors feed. Zero JS, no external assets,
keep `<meta refresh=5>`. Add the `<nav>` tab row (Mission Control / Jobs /
Consolidation / Search).

## Scope

Allowed: `src/server/routes/dashboard-html.ts` + its tests.
Forbidden: dashboard.ts route/auth logic; queries; app.ts; other page files.
Existing helpers (esc, fmtTime, truncate, color helpers) carry over.

## Acceptance criteria

- AC-1 Given a healthy HealthState (embed ok, worker alive, disk free, FTS
  reachable), When renderDashboard runs, Then the status banner shows OK
  and names each subsystem individually.
- AC-2 Given embed.ok=false or worker.alive=false, Then the banner shows
  DEGRADED and names the failing subsystem — page still renders fully.
- AC-3 Given zero pending proposals and zero failed/poison jobs, Then the
  strips show explicit "0"/empty states, not blank space or NaN.
- AC-4 Given queryJobStatesByKind data, Then the pipeline row shows
  per-stage pending/running counts, with entity-link showing
  linked/unlinked memory counts (not a job-kind count).
- AC-5 Given the demoted sections (memory-counts-by-type, per-type
  usefulness, full 25-row recent-captures, 4-decimal budget), Then none
  appear in their old form — budget is one collapsed tile, activity is the
  merged feed.
- AC-6 Given the existing three-path auth (Bearer/cookie/bootstrap ?token=)
  on GET /dashboard, Then it is unchanged — this slice only rewrites
  rendering.

## Done when

All ACs pass with test evidence (snapshot or string-assert tests on
rendered HTML); `bun run build` + `vitest run` green.
