# astramem-local Operations Dashboard — Redesign (Design Only)

Date: 2026-07-04
Scope: `/dashboard` and successors. No implementation in this pass.
Ground truth read: `src/server/routes/dashboard.ts`, `dashboard-html.ts`,
`src/server/queries/dashboard.ts`, `src/server/routes/{health,consolidation,
entities,lifecycle,search,why,digest}.ts`, `src/storage/*`, `src/search/{search,
fuse}.ts`, `src/contracts/job.ts`, `src/pipeline/job-repo.ts`, migrations
001/008/012/013.

---

## 1. Current-state review

The existing `/dashboard` (zero-JS, `<meta refresh content="5">`, Bearer/cookie
auth) is well-built as *infrastructure* — the query layer is already split
from rendering, auth bootstrap is careful about not leaking the bearer token,
and the HTML is genuinely under 20 KB with no external assets. The problem is
what it chooses to show, not how it renders it.

`queryDashboard` currently surfaces: memory counts by type, last 25 memories,
job counts by **state only** (no kind), last-24h memory-creation histogram,
embed provider health row, today/MTD budget spend, a legacy pending-directory
scan, and 7-day usefulness (overall + per-type).

Measured against the 5-second criterion:

- **Health rollup — missing.** There is no top-level OK/DEGRADED banner. The
  richer subsystem-health object (embed provider ok/attempts, worker
  alive/last-tick, disk-free bytes, queue counts, pending-proposal count)
  already exists in `HealthState` and is computed for `GET /health`, but
  `queryDashboard` never reuses it. The operator must mentally fuse eight
  sections to answer "is the daemon healthy" — the page fails its own goal.
- **Pipeline visibility — missing.** `queryJobStates` groups only by `state`,
  not `kind`. A "pending: 6" badge could mean six stuck `distill` jobs or six
  stuck `reembed` jobs — indistinguishable from the dashboard. Entity
  linking, one of the six named pipeline stages, has zero representation
  anywhere on the page (no entity count, no unlinked-memory gauge).
- **Consolidation proposals piling up — absent entirely.** `pending_proposals`
  is computed for `/health` but never wired into `queryDashboard`. There is no
  section, no count, no link. This is a named acceptance criterion with zero
  current coverage.
- **"What failed and why" — half-answered.** The job-state badges show a
  poison/failed *count* but never the job's `last_error` text or which kind
  failed. An operator still has to shell out to the `queue` CLI to read the
  actual error.
- **No drill-down anywhere.** Every section is a dead-end display; nothing
  links to `/consolidation/proposals`, `/memory/:id/why`, or
  `/entities/:id/memories`, even though those endpoints already exist.
- **Duplicate implementation.** Job-state counts are computed twice —
  `queryJobStates` in `queries/dashboard.ts` and an inline `queueCounts()` in
  `routes/health.ts` — with slightly different call sites and no shared
  source of truth. This is exactly the reuse-hierarchy violation the mission
  brief warns against.

## 2. Deletion-first audit

Before adding anything, cut or demote:

| Item | Verdict | Why |
|---|---|---|
| "Pending queue" section (`queryPendingDir`, `%APPDATA%\Astramem\pending` dir scan) | **Delete, pending one verification** | Predates the jobs-table worker model. Confirm nothing in `ingest.ts` still writes there; if dead, remove the query and section outright — it currently competes with job-state "pending" for the same word and adds confusion, not clarity. |
| Usefulness per-type breakdown table | **Demote** | Real product-quality signal, but not an operational health signal glanced at 30x/day. Keep one overall 7-day rate number as a Mission Control stat tile; drop the per-type table from the primary view (candidate for a future insights surface, out of scope here). |
| Memory-counts-by-type bar chart | **Demote** | Pure inventory metric, not health. Belongs on a future Memories page as a sidebar filter, not a Mission Control headline. |
| "Recent captures" full 25-row table | **Shrink / replace** | Useful but verbose for a glance screen. Replace with a compact merged activity feed (failures + proposals + a handful of new memories) that answers "what just happened," not "list everything." |
| Budget section at full precision (4 decimals, Today+MTD side by side) | **Collapse** | For the documented Ollama-only default this is permanently `$0.0000` and burns visual space for zero information 30x/day. Collapse to one compact tile; only worth expanding when a paid provider (Azure OpenAI) is actually configured. |
| Duplicate job-count queries (`queryJobStates` vs `health.ts` `queueCounts()`) | **Consolidate** | One shared query function, called by both `/health` and the dashboard. Backend cleanup, not a UI change. |

Net effect: five of eight current sections are cut or shrunk before a single
new element is added.

## 3. Recommended scope (the 80/20 cut)

**Survives:**
- **Mission Control** — the one screen a developer actually needs 30x/day.
  Subsystem status, pipeline-stage job flow, consolidation-proposal count
  with drill-down, provider/storage state, budget (collapsed), one
  usefulness stat, and a merged recent-activity/errors feed.
- **Consolidation** (list + accept/reject) — explicitly named acceptance
  criterion #4 ("are proposals piling up"), and it is nearly free: the list
  and resolve endpoints already exist (`GET /consolidation/proposals`,
  `POST .../accept`, `POST .../reject`). A Mission Control count with no way
  to act on it would be a half-measure, so this ships in Phase 1 alongside
  Mission Control as a drill-down target, not deferred to Phase 2.
- **Jobs** (Phase 2) — per-kind state breakdown plus a failed/poison list
  with actual `last_error` text. This is where criteria #3 and #5 get their
  full answer; Mission Control can only summarize.
- **Search debug** (Phase 2) — genuinely useful for trusting the hybrid
  BM25+vector+fuse ranking (`fuse.ts`'s α/β/γ/δ/ε/ζ weights are otherwise a
  black box), but it is a deliberate-open debugging surface, not a glance
  page. Correctly a Phase 2, not Phase 1, citizen.

**Cut or deferred:**
- **Memories browse/detail page** — deferred to Phase 3, built only if
  Phase 1/2 usage shows operators still shelling out to `search`/`why` CLI
  for memory archaeology. `GET /search`, `GET /memory/:id/why`, and
  `GET /entities/:id/memories` already cover this need as APIs; a dedicated
  page is meaningful LOC for uncertain daily value.
- **System/config page** — cut entirely. Paths, versions, DB size, and
  provider/model are almost entirely static or already owned by `doctor`.
  Fold version/schema/wire-version into the one-line footer every page
  already has (as today's header does), and stop there.

## 4. Mission Control mockup

```
┌──────────────────────────────────────────────────────────────────────────┐
│ AstraMemory Local                              v0.4.1 · schema 13 · OK ● │
│ [Mission Control] Jobs  Consolidation  Search                 as of 14:32 │
├──────────────────────────────────────────────────────────────────────────┤
│  ● DAEMON OK   embed:ok  worker:alive(3s ago)  sqlite:ok  disk:42GB free │
├──────────────────────────────────────────────────────────────────────────┤
│  PIPELINE                                                                │
│  ingest → distill → entity-link → embed → consolidate → index           │
│    12       3●p 1●r      248/2 unlinked    0        2 pending    ok      │
│  (numbers under each stage = pending/running for that job kind;         │
│   entity-link shows linked/unlinked memory counts, not a job kind)      │
├───────────────────────────┬────────────────────────┬─────────────────────┤
│ JOBS                      │ CONSOLIDATION           │ PROVIDERS/STORAGE   │
│ pending 4  running 1      │ ● 7 pending proposals    │ ollama/mxbai-large │
│ failed  0  poison 2 ⚠     │   oldest: 3h 12m         │  1024-dim · OK     │
│ [view jobs →]             │ [resolve →]              │ sqlite 84MB · FTS ok│
├───────────────────────────┼────────────────────────┼─────────────────────┤
│ BUDGET                    │ USEFULNESS (7d)                                │
│ today $0.0000 / cap $2.00 │ 71.4% of served recalls marked used            │
├───────────────────────────┴─────────────────────────────────────────────┤
│ RECENT ACTIVITY / ERRORS                                                  │
│ 14:31  poison   distill    job 8f2a…  "ollama embed timeout after 3 tries"│
│ 14:20  proposal created   merge  sim=0.94  atoms a1b2…/c3d4…              │
│ 14:12  memory   fact       "prod deploy uses blue/green"                  │
│ 13:58  failed→retry reembed job 55c1… attempt 2/3  "connection refused"   │
└──────────────────────────────────────────────────────────────────────────┘
```

Every element justifies itself against the 30-opens-a-day test: the status
banner and pipeline row answer "is it healthy / is it flowing" in the first
two lines; the three-column strip answers "are jobs/proposals/providers
fine" without reading prose; the activity feed is the only place text is
read, and only for things that need explaining (errors, proposals, and a
trickle of new memories for context).

## 5. Wireframes — surviving pages

### Consolidation (`/dashboard/consolidation`)

```
┌ Consolidation proposals ──────────────────────────────────────────────┐
│ [pending: 7] accepted  rejected     filter: (pending ▾)               │
│ id      kind         sim   winner (excerpt)      loser (excerpt)  age │
│ a1b2…   merge        0.94  "uses blue/green..."  "prod deploy..." 3h  │
│         [accept] [reject]                                             │
│ c3d4…   contradiction 0.81 "...timeout 30s"       "...timeout 60s" 1h │
│         [accept] [reject]                                             │
└─────────────────────────────────────────────────────────────────────┘
```
Plain `<form method="post">` per row targeting the existing
`/consolidation/proposals/:id/accept|reject` endpoints — no new mutation
surface, zero JS.

### Jobs (`/dashboard/jobs`, Phase 2)

```
┌ Jobs ─────────────────────────────────────────────────────────────────┐
│ kind          pending running completed(24h) failed poison            │
│ distill          3       1        142           0      1              │
│ reembed          1       0         12           0      1              │
│ consolidate      0       0          4           0      0              │
│ cleanup          0       0          1           0      0              │
├─────────────────────────────────────────────────────────────────────┤
│ Failed / poison detail                                                │
│ id      kind     state   attempts  last_error              age       │
│ 8f2a…   distill  poison  3         "ollama embed timeout"   2h 4m     │
│ 55c1…   reembed  poison  3         "connection refused"     40m       │
└─────────────────────────────────────────────────────────────────────┘
```

### Search debug (`/dashboard/search`, Phase 2)

```
┌ Search debug ──────────────────────────────────────────────────────────┐
│ query: [________________________]  [run]   weights: α.4 β.4 γ.1 δ.1 ε.1│
├─────────────────────────────────────────────────────────────────────┤
│ id     source  bm25(norm) cosine(norm) importance freshness fused rank │
│ a1b2…  both    0.91       0.77          0.60       0.95      0.812  1 │
│ c3d4…  fts     0.60       0.00          0.50       0.40      0.360  2 │
└─────────────────────────────────────────────────────────────────────┘
```
A plain GET `<form>` (query in the URL) so results are a normal server-
rendered page — no JS needed for the interaction.

## 6. Backend gap analysis

| Gap | Needed for | Reuse level | Proposed minimal addition |
|---|---|---|---|
| Job counts grouped by `kind` + `state`, not state alone | Mission Control pipeline row, Jobs page | 2 — extend `queryJobStates` | `GROUP BY kind, state` variant in `queries/dashboard.ts`; also replaces the duplicate `queueCounts()` in `health.ts` |
| Consolidation summary (pending count + oldest `created_at`) | Mission Control tile | 2 — extend `queryDashboard` | Call `ProposalRepo.list('pending')` (already exists) inside `queryDashboard` and derive count/oldest; no new table scan |
| Recent failed/poison jobs with `last_error` text | Mission Control activity feed, Jobs page | 2 — new function alongside existing dashboard queries | `queryRecentFailedJobs(db)`: `SELECT id, kind, state, last_error, updated_at FROM jobs WHERE state IN ('failed','poison') ORDER BY updated_at DESC LIMIT N` |
| Unified subsystem health rollup (embed ok, worker alive, disk free, queue/proposal counts) | Mission Control status banner | 3 — small addition, high value | Pass the existing `HealthState` instance (already built at boot for `/health`) into `dashboardRoute`/`queryDashboard`; merge fields instead of recomputing. This is the single highest-value gap to close. |
| Entity-linking visibility (entity count, unlinked-memory count) | Mission Control pipeline row (entity-link stage) | 4 — new query, justified | `entities` count is a one-liner; unlinked = `SELECT COUNT(*) FROM memories m WHERE valid_to IS NULL AND NOT EXISTS (SELECT 1 FROM memory_entities me WHERE me.memory_id = m.id)`. No existing query touches this at all today. |
| Job age-in-current-state ("stuck" detection) | Jobs page | 2 — no schema change | `now - updated_at` per job is already correct for *time in current state* since `claimPending`/`_transition` both stamp `updated_at`. Sufficient for Phase 2; do not build duration histograms on top of it. |
| Total job processing duration (created→completed) | Jobs page detail (nice-to-have) | 4 — schema gap, **defer** | `updated_at` is overwritten at every transition, so total duration can't be reconstructed today. Would need a `started_at`/`claimed_at` column — out of scope for this design pass, flag as a backlog item if operators ask for it. |
| Search score breakdown (raw/normalized bm25, cosine, fused, per-weight contribution) | Search debug page | 3 — new read-only endpoint reusing existing logic | `search.ts`/`fuse.ts` already compute every one of these values internally and discard them before returning `SearchHit`. Add a debug-mode path (e.g. `search(..., { debug: true })`) that returns the intermediate `FusedHit`-plus-components instead of collapsing to score+source. |
| Synthetic "is FTS5 / SQLite reachable" checks | Mission Control status banner | 2/3 — cheap addition | Wrap a trivial `SELECT 1 FROM memories_fts LIMIT 1` in the same health-rollup merge from gap #4; today these are only implicitly true (page rendered at all), never explicitly checked. |

## 7. Tech recommendation

**Pick: keep zero-JS, multi-page, server-rendered HTML — no new dependency.**

- **Meta-refresh vs htmx vs SPA vs SSE:** Meta-refresh's only real cost is a
  full-page reload every 5s (lost scroll position, no in-place expand/
  collapse). For a local, single-operator tool glanced at repeatedly, that
  cost is tolerable and the constraint document explicitly allows "keep
  zero-JS" as a legitimate answer. htmx (a single vendored ~14 KB file, no
  CDN, no build step) would fix the reload-flicker and enable in-place
  drill-down panels, and remains consistent with "thin frontend" since it
  does no business logic of its own — but it is a real dependency add for a
  problem plain navigation already solves. An SPA (React/Vite) is
  categorically wrong here: it requires a build pipeline and a dependency
  surface the constraints explicitly ask to argue against, and buys nothing
  a request/response console needs. SSE solves a latency problem (sub-second
  push) that doesn't exist for a human eyeballing a screen every few
  seconds — added connection-lifecycle complexity for no perceptible gain.
- **Drill-down without JS:** achieved with ordinary `<a href="/dashboard/
  jobs">` navigation between distinct server-rendered routes and a small
  `<nav>` of tabs at the top (Mission Control / Jobs / Consolidation /
  Search) — the same tab-not-modal pattern as Docker Desktop/Grafana, and
  zero-JS by construction.
- **Revisit condition:** if operators report the full-page reload as
  actually disruptive (e.g. losing an expanded jobs-detail row mid-glance),
  htmx is the correct next step — not before.

## 8. Phased plan

**Phase 1 — Mission Control + Consolidation (shippable standalone)**
- `src/server/queries/dashboard.ts`: extend `queryDashboard` to accept the
  existing `HealthState`; add `queryJobStatesByKind`, `queryConsolidationSummary`,
  `queryRecentFailedJobs`, `queryEntityLinkage`; remove `queryPendingDir` (after
  verifying it's dead) and the per-type usefulness call from the primary path.
- `src/server/routes/dashboard.ts`: wire the already-constructed `HealthState`
  instance into `dashboardRoute`.
- `src/server/routes/dashboard-html.ts`: rewrite `renderDashboard` as the
  Mission Control layout above; most existing helpers (`esc`, `fmtTime`,
  `truncate`, color helpers) carry over unchanged.
- New `src/server/routes/dashboard-consolidation-html.ts` + `GET /dashboard/
  consolidation` route, rendering the proposal list with plain `<form>`
  posts to the existing accept/reject endpoints.
- Rough LOC: ~350–450 (mostly HTML templates; ~80 LOC of new query functions).

**Phase 2 — Debugging (Jobs detail, Search debug)**
- New `src/server/routes/dashboard-jobs-html.ts` + `GET /dashboard/jobs`,
  backed by the kind+state and failed/poison queries from Phase 1.
- `src/search/search.ts`: add a `debug` option that returns intermediate
  bm25/cosine/normalized/fused values instead of collapsing to `SearchHit`.
- New `src/server/routes/dashboard-search-html.ts` + `GET /dashboard/search`
  (plain GET form).
- Rough LOC: ~300–400.

**Phase 3 — Memories browse/detail (only if justified)**
- Build only if Phase 1/2 usage shows operators still relying on CLI
  `search`/`why` for memory archaeology instead of the dashboard. Reuses
  `GET /search`, `GET /memory/:id/why`, `GET /entities/:id/memories` as-is —
  zero new backend surface. Rough LOC: ~250–300.
