---
id: FEAT-410
status: triaged
priority: P2
category: observability
target_release: null
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: null
github_issue: null
github_milestone: null
github_url: null
pm_customer_impact: 0.40
pm_effort_estimate: 0.45
pm_strategic_alignment: 0.55
pm_technical_risk: 0.30
pm_dependency_depth: 0.05
pm_effort_points: 20
composite_score: 0.5675
composite_priority: P2
autonomous_safe: true
pm_demand_evidence: "Real, current friction with concrete evidence: two duplicate job-count implementations flagged as reuse-hierarchy violation; zero consolidation-proposal visibility despite live endpoints; documented CLI-shellout workaround for reading job errors. Capped by single-operator local-tool scope."
pm_scope_notes: "Design doc independently approved (.claude/artifacts/crew/runs/2026-07-04-dashboard-redesign-design.md). 6 slices / 2 waves for max worktree parallelism; file sets disjoint per wave. PM verification: (1) queryPendingDir confirmed dead code — grep of src/ shows nothing writes %APPDATA%/Astramem/pending; deletion is a hard assertion. (2) Real bug folded into S1: app.ts:103 exempts dashboard cookie-auth with EXACT match `path === '/dashboard'` — all new /dashboard/* sub-pages 401 without widening to prefix match (S1 AC-8). Helper coupling ruling: dashboard-html.ts helpers are module-private; each new page file duplicates its ~3-4 one-line helpers locally (esc/truncate/fmtTime) — shared extraction deferred to post-wave-2 cleanup slice because same-wave worktrees cannot see each other's exports pre-merge. Composite formula reverse-engineered from FEAT-401/406/409 pairs (0.30*impact + 0.25*alignment + 0.20*(1-effort) + 0.15*(1-risk) + 0.10*(1-deps), fit ~0.02) — directional, not canonical."
proposed_slices:
  - id_suffix: -SLICE-1
    title: Backend queries + health consolidation + auth-prefix fix (wave 1)
    points: 5
  - id_suffix: -SLICE-2
    title: Consolidation page — list + accept/reject via existing endpoints (wave 1)
    points: 3
  - id_suffix: -SLICE-3
    title: Search debug backend — debug:true fusion intermediates (wave 1)
    points: 2
  - id_suffix: -SLICE-4
    title: Mission Control render rewrite (wave 2)
    points: 5
  - id_suffix: -SLICE-5
    title: Jobs page — kind×state matrix + failed/poison detail (wave 2)
    points: 3
  - id_suffix: -SLICE-6
    title: Search debug page — GET form + score table (wave 2)
    points: 2
pm_risks:
  - "app.ts contention: S1 edits preHandler exemption + dashboardRoute call; S2 (wave 1) and S5/S6 (wave 2) each add one registration line. Trivial line-adjacent merge conflicts — merge PASS branches sequentially, never blind auto-merge."
  - "Wave-2 hard dependency: S5/S6 401 on every request unless S1 AC-8 (auth prefix exemption) is already merged to main. Wave gate must verify S1 landed before wave 2 dispatch."
  - "S4 consumes 5 new DTO shapes from S1 in one rewrite — must code against S1's actual merged exports post-wave-1, not the design doc mockup. TS compiler + snapshot tests catch shape mismatch."
  - "Deliberate duplication debt: render helpers (esc/truncate/etc.) and cookie/bearer check duplicated ~4x across page files by design. Follow-up cleanup slice after wave 2 merges to extract the real shared surface — do NOT extract earlier, it costs the parallelism."
reasoning: "technical_risk 0.30 — no schema change, no new auth surface (copies proven cookie/bearer pattern), no new mutation endpoints (reuses existing accept/reject), no breaking wire change; risk is coordination, not correctness/security. Well under the ~0.6 band where FEAT-406/409 flipped autonomous_safe to false. effort_points=20 across 6 pre-decomposed slices satisfies the decomposition gate."
---
# FEAT-410: Operations Dashboard redesign — Mission Control

## Description

Evolve the existing zero-JS `/dashboard` into an operational console
("Mission Control") that answers, within 5 seconds: is the daemon healthy,
is the memory pipeline flowing (and which stage is stuck), are jobs
failing and why, are consolidation proposals piling up, what is today's
budget spend. Adds a Consolidation page (act on proposals via existing
endpoints), a Jobs page (kind×state + last_error), and a Search-debug
page (fusion score breakdown). Deletes/demotes five of eight current
dashboard sections first. Design doc (approved):
`.claude/artifacts/crew/runs/2026-07-04-dashboard-redesign-design.md`.

Tech: keep zero-JS, multi-page, server-rendered HTML. No new dependency,
no SPA, no SSE. Plain `<nav>` tabs + full navigation.

## Wave plan (max worktree parallelism — REVISED 2026-07-04)

Revision: original plan had S2/S5/S6 each adding a registration line to
app.ts — the wave planner treats overlapping touches_files as conflicts,
which would have serialized those slices into separate waves. Fix: SLICE-1
creates STUB modules for all three sub-pages and registers them in app.ts
up front; S2/S5/S6 then own exactly one file each (replace stub render
internals only) and never touch app.ts. Zero contention, bigger wave 2.

Wave 1 — 2 parallel worktrees: SLICE-410-1, SLICE-410-3 (disjoint files).

Wave gate: SLICE-410-1 merged to main (auth-prefix exemption AC-8 + stubs +
registrations) before wave 2 dispatch.

Wave 2 — 4 parallel worktrees: SLICE-410-2, SLICE-410-4, SLICE-410-5,
SLICE-410-6 (fully disjoint — one file each).

Post-wave-2 follow-up (separate, do not fold in): cleanup slice extracting
the ~4x-duplicated render helpers + per-page cookie/bearer check into
shared modules once the real common surface is visible.

## Slices & acceptance criteria

### SLICE-1 — backend-queries (wave 1, 5 pts)

Files: `src/server/queries/dashboard.ts`, `src/server/routes/health.ts`,
`src/server/routes/dashboard.ts`, `src/server/app.ts`. Tests included.

- AC-1 Given a DB with jobs of multiple kinds and states, When
  `queryJobStatesByKind` runs, Then it returns counts grouped by
  (kind, state) — e.g. distinguishing distill:poison=2 from
  reembed:poison=1.
- AC-2 Given health.ts's `queueCounts()` and dashboard.ts's
  `queryJobStates()`, When the consolidation lands, Then only one shared
  function computes job-state counts, called by both `/health` and
  `/dashboard`, and `/health`'s existing response shape/tests are
  unchanged.
- AC-3 Given zero pending consolidation proposals, When
  `queryConsolidationSummary` runs, Then it returns count=0, oldest=null
  (not a throw) — the empty state Mission Control must render.
- AC-4 Given pending proposals with known created_at, When
  `queryConsolidationSummary` runs, Then count matches
  `ProposalRepo.list('pending').length` and oldest is the earliest
  created_at (reuses ProposalRepo, no new table scan).
- AC-5 Given jobs in failed/poison states with distinct last_error, When
  `queryRecentFailedJobs` runs, Then rows are ordered updated_at DESC,
  each including id/kind/state/last_error/updated_at, limited to N.
- AC-6 Given the embed provider down or Ollama degraded, When
  `queryDashboard(db, healthState)` runs, Then it still returns a
  complete DashboardData (embed.ok=false, no throw).
- AC-7 Given a grep for queryPendingDir call sites across src/
  post-deletion, Then zero references remain (pre-verified: only
  queries/dashboard.ts referenced it; ingest.ts's "pending" hits are
  job-state/idempotency strings, unrelated) and no test asserts the old
  pendingDir field.
- AC-8 Given a request to /dashboard/consolidation (or /jobs, /search)
  with a valid dashboard cookie and no Authorization header, When the
  global preHandler runs, Then the request is NOT rejected by the Bearer
  check (exemption widened from exact-match '/dashboard' to a
  '/dashboard'-prefix match) — the fix every wave-2 sub-page depends on.

Risk: biggest/most load-bearing slice — touches four files including
app.ts (dashboardRoute call AND preHandler exemption). Land as one diff;
test each new query function in isolation.

### SLICE-2 — consolidation-page (wave 1, 3 pts)

Files: new `src/server/routes/dashboard-consolidation-html.ts`, one
registration line in `src/server/app.ts`.

- AC-1 Given a pending proposal (kind=merge, sim=0.94, known excerpts),
  When GET /dashboard/consolidation is requested with a valid cookie,
  Then the row renders id/kind/sim/both excerpts, HTML-escaped via a
  locally duplicated `esc()` (not imported from dashboard-html.ts — its
  helpers are module-private).
- AC-2 Given zero pending proposals, When rendered, Then an explicit
  "No pending proposals" state shows, not an empty table.
- AC-3 Given a rendered row, When its accept/reject form posts, Then it
  targets the existing `/consolidation/proposals/:id/accept|reject`
  verbatim (no new mutation route), and a subsequent GET reflects the
  new status.
- AC-4 Given a request with no Authorization header and no dashboard
  cookie, Then it returns 401 — must not accidentally inherit a
  too-broad exemption.
- AC-5 Given a request with a valid dashboard cookie only (no Bearer
  header — the normal nav-link case), Then it returns 200 — confirms
  SLICE-1 AC-8's prefix exemption covers this path end-to-end.
- AC-6 Given an accept/reject race (already-resolved proposal → 409, or
  a memory conflict), When posted, Then the page shows a clear error
  state, not a raw 409/500 body.

Risk: no import from dashboard-html.ts (deliberate duplication); same-file
same-wave app.ts touch as SLICE-1 — sequence the merge.

### SLICE-3 — search-debug-backend (wave 1, 2 pts)

Files: `src/search/search.ts` + unit test.

- AC-1 Given `search(query, filters, limit, { ...opts, debug: true })`
  against a query with both FTS and vector hits, Then the result includes
  per-candidate raw+normalized bm25, cosine, importance, freshness, and
  the final fused score/weights (α/β/γ/δ/ε/ζ) — not collapsed to
  SearchHit.
- AC-2 Given the same query with debug false/omitted, Then output is
  byte-identical to pre-change behavior.
- AC-3 Given the repo's deterministic fake embedder fixture, When a unit
  test runs the debug path, Then component values are asserted exactly,
  and the fused score is reproducible from its documented weights.
- AC-4 Given FTS hits but no vector hits (embed down), When debug mode
  runs, Then vector fields degrade to a documented sentinel (not a
  throw).
- AC-5 Given an empty query or zero candidates, Then debug mode returns
  [], not an error.

Risk: isolated, single-file, lowest risk. Export the debug result type
explicitly — SLICE-6's only upstream contract.

### SLICE-4 — mission-control-render (wave 2, 5 pts)

Files: `src/server/routes/dashboard-html.ts` rewrite. Depends: SLICE-1
merged.

- AC-1 Given a healthy HealthState (embed ok, worker alive, disk free,
  FTS reachable), When renderDashboard runs, Then the status banner shows
  OK and names each subsystem individually (design doc §4).
- AC-2 Given embed.ok=false or worker.alive=false, Then the banner shows
  DEGRADED and names the failing subsystem — page still renders fully.
- AC-3 Given zero pending proposals and zero failed/poison jobs, Then the
  strips show explicit "0"/empty states, not blank space or NaN.
- AC-4 Given queryJobStatesByKind for the six pipeline stages, Then the
  pipeline row shows per-stage pending/running counts, with entity-link
  showing linked/unlinked memory counts (not a job-kind count), per §4.
- AC-5 Given the demoted sections (memory-counts-by-type, per-type
  usefulness, full 25-row recent-captures, 4-decimal budget), Then none
  appear in their old form — budget is one collapsed tile, activity is
  the merged feed, per the §2 deletion-first audit.
- AC-6 Given the existing three-path auth (Bearer/cookie/bootstrap
  ?token=) on GET /dashboard, Then it is unchanged — this slice only
  rewrites rendering.

Risk: largest render surface, consumes 5 new DTO shapes from SLICE-1 in
one rewrite — code against SLICE-1's actual merged types, not the design
doc mockup. TS compiler + snapshot tests catch shape mismatch.

### SLICE-5 — jobs-page (wave 2, 3 pts)

Files: new `src/server/routes/dashboard-jobs-html.ts`, one registration
line in `src/server/app.ts`. Depends: SLICE-1 merged (queries + AC-8).

- AC-1 Given jobs across 4+ kinds/states, When GET /dashboard/jobs
  renders, Then the kind × state matrix shows pending/running/
  completed(24h)/failed/poison per kind (§5 wireframe).
- AC-2 Given a poison job with last_error, Then the detail table shows
  id/kind/state/attempts/last_error (untruncated)/age.
- AC-3 Given zero failed/poison jobs, Then an explicit "No failed or
  poison jobs" empty state shows.
- AC-4 Given no Authorization header and no cookie, Then 401.
- AC-5 Given a valid cookie only, Then 200 (same auth-prefix dependency
  as SLICE-2 AC-5 / SLICE-1 AC-8).
- AC-6 Given "stuck" jobs, Then age is computed from updated_at only —
  no attempt at created→completed duration (explicitly out of scope,
  §6 gap table).

### SLICE-6 — search-debug-page (wave 2, 2 pts)

Files: new `src/server/routes/dashboard-search-html.ts`, one registration
line in `src/server/app.ts`. Depends: SLICE-3 merged (debug type),
SLICE-1 AC-8 on main.

- AC-1 Given GET /dashboard/search?query=... non-empty, Then the table
  shows id/source/bm25(norm)/cosine(norm)/importance/freshness/fused/rank
  from SLICE-3's debug:true output.
- AC-2 Given no query param (initial load), Then the form + current
  fuse.ts weights show with no results table (not an error).
- AC-3 Given a query with zero candidates, Then an explicit "no results"
  state shows.
- AC-4 Given the embed provider down, Then the page renders FTS-only rows
  (cosine at SLICE-3 AC-4's sentinel), not a 500.
- AC-5 Given no Authorization header and no cookie, Then 401.
- AC-6 Given a valid cookie only, Then 200 (same auth-prefix dependency
  as SLICE-2/SLICE-5).

## Deferred / out of scope

- Memories browse/detail page (design Phase 3) — build only if Phase 1/2
  usage shows operators still shelling to CLI `search`/`why`.
- System/config page — cut; version/schema fold into page footer.
- Job created→completed duration — schema gap (`updated_at` overwritten
  per transition); backlog item if operators ask.
- Helper/auth-check extraction — post-wave-2 cleanup slice.

## Notes

2026-07-04: Created from approved design doc + PM pass (scope challenge,
scoring, ACs, risks). PM verified queryPendingDir dead and found the
app.ts:103 exact-match auth exemption bug (folded into SLICE-1 AC-8).
