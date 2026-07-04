---
id: SLICE-410-1
feature: FEAT-410
status: completed
priority: P2
wave: 1
wave_attempts: 0
pending_fix: false
touches_files:
  - src/server/queries/dashboard.ts
  - src/server/routes/health.ts
  - src/server/routes/dashboard.ts
  - src/server/routes/dashboard-consolidation-html.ts
  - src/server/routes/dashboard-jobs-html.ts
  - src/server/routes/dashboard-search-html.ts
  - src/server/app.ts
---
# SLICE-410-1: Backend queries + health consolidation + auth-prefix fix + page stubs (wave 1, 5 pts)

Design doc (read first): `.claude/artifacts/crew/runs/2026-07-04-dashboard-redesign-design.md`
Parent: `.claude/artifacts/loop/backlog/triaged/FEAT-410.md`

## Objective

All backend/query work for the dashboard redesign, the app.ts auth-prefix
fix, and STUB modules for the three future sub-pages so no later slice ever
touches app.ts.

## Scope

Allowed: the seven files in touches_files + their tests.
Forbidden: any render-layout work beyond minimal stubs; new mutation
endpoints; schema migrations; touching search/fuse (SLICE-410-3 owns that).

1. `src/server/queries/dashboard.ts`: extend `queryDashboard` to accept the
   existing `HealthState` (built at boot for `/health`) and merge its fields
   into DashboardData; add `queryJobStatesByKind` (GROUP BY kind, state),
   `queryConsolidationSummary` (via existing `ProposalRepo.list('pending')`),
   `queryRecentFailedJobs` (failed/poison, last_error, updated_at DESC,
   LIMIT N), `queryEntityLinkage` (entity count + unlinked-memory count);
   DELETE `queryPendingDir` (pre-verified dead) and drop per-type usefulness
   from the primary path. Export all new DTO types.
2. `src/server/routes/health.ts`: replace inline `queueCounts()` with the
   shared job-state query — `/health` response shape unchanged.
3. `src/server/routes/dashboard.ts`: pass `HealthState` into
   `dashboardRoute`/`queryDashboard`.
4. `src/server/app.ts`: widen the preHandler auth exemption at ~line 103
   from `path === '/dashboard'` to a `/dashboard` prefix match (path ===
   '/dashboard' || path.startsWith('/dashboard/')); register the three new
   page routes.
5. Create three STUB page modules (`dashboard-consolidation-html.ts`,
   `dashboard-jobs-html.ts`, `dashboard-search-html.ts`): each exports a
   Fastify route plugin for `GET /dashboard/<page>` performing the same
   cookie/Bearer check as dashboard.ts (duplicated locally by design) and
   returning a minimal placeholder HTML page ("coming in wave 2"). Wave-2
   slices replace ONLY the render internals of these files.

## Acceptance criteria

- AC-1 Given a DB with jobs of multiple kinds and states, When
  queryJobStatesByKind runs, Then it returns counts grouped by (kind, state)
  — e.g. distinguishing distill:poison=2 from reembed:poison=1.
- AC-2 Given health.ts's queueCounts() and dashboard.ts's queryJobStates(),
  When the consolidation lands, Then only one shared function computes
  job-state counts, called by both /health and /dashboard, and /health's
  existing response shape/tests are unchanged.
- AC-3 Given zero pending consolidation proposals, When
  queryConsolidationSummary runs, Then it returns count=0, oldest=null (not
  a throw).
- AC-4 Given pending proposals with known created_at, When
  queryConsolidationSummary runs, Then count matches
  ProposalRepo.list('pending').length and oldest is the earliest created_at.
- AC-5 Given jobs in failed/poison states with distinct last_error, When
  queryRecentFailedJobs runs, Then rows are ordered updated_at DESC, each
  including id/kind/state/last_error/updated_at, limited to N.
- AC-6 Given the embed provider down or degraded, When
  queryDashboard(db, healthState) runs, Then it still returns a complete
  DashboardData (embed.ok=false, no throw).
- AC-7 Given a grep for queryPendingDir across src/ post-deletion, Then zero
  references remain and no test asserts the old pendingDir field.
- AC-8 Given a request to /dashboard/consolidation (or /jobs, /search) with
  a valid dashboard cookie and no Authorization header, When the global
  preHandler runs, Then the request is NOT rejected by the Bearer check.
- AC-9 Given the three stub routes registered, When each is requested with
  no auth at all, Then 401; with valid cookie, Then 200 placeholder page.

## Done when

All ACs pass with test evidence; `bun run build` green; `vitest run` green
(including existing /health tests unchanged).
