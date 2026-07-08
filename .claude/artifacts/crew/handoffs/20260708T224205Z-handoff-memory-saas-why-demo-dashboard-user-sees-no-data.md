# Task Handoff: memory SaaS: why demo dashboard user sees no data

- Created: 2026-07-08T22:42:05.751Z
- From: researcher
- To: dispatcher
- Objective: Dashboard Clerk JWT resolves tenant via users.clerk_sub->tenant_id lookup, entirely independent of the device ApiKey's fixed tenant_id — the demo user almost certainly has a users row pointing at a different (or no) tenant than 3e970d7f.
- Allowed Scope:
  - C:\work\mega\memory (AstraMemory.Api + Infrastructure)
  - read-only: auth model split
  - tenant resolution for ApiKey vs Clerk JWT
  - analytics/overview vs analytics/tenants authZ
  - and the non-AI search/list endpoints. ai/search 500 explicitly excluded per dispatcher scope update (expected: no AI key configured
  - not a bug).
- Forbidden Scope: -
- Deliverable: Findings report returned inline to dispatcher (see chat) covering Q1 auth split, Q2 tenant resolution (primary), Q4 analytics authZ diff, plus the dashboard's real list/search endpoints (GET /dashboard/memories, POST /memories/search) with file:line citations.
- Changed Files:
  - src/AstraMemory.Api/Middleware/AuthMiddleware.cs
  - src/AstraMemory.Api/Extensions/ServiceCollectionExtensions.cs
  - src/AstraMemory.Infrastructure/Tenancy/TenantResolver.cs
  - src/AstraMemory.Api/Controllers/AnalyticsController.cs
  - src/AstraMemory.Modules.Dashboard/Controllers/DashboardController.cs
  - src/AstraMemory.Modules.Search/Controllers/SearchController.cs
  - src/AstraMemory.Modules.Memories/Controllers/MemoriesController.cs
- Confidence: high
- Risks: Did not query the live users table to confirm the demo Clerk sub's actual tenant_id row (no DB access in this read-only pass) — the verdict that it maps to a different/no tenant is the leading code-supported hypothesis, not a confirmed DB fact. Did not trace exactly how the dashboard frontend obtains/attaches the Clerk session token to requests (frontend repo out of scope).
- Suggested Next Handoff: Query astramemory.users WHERE clerk_sub = '<demo user's Clerk sub>' to confirm its tenant_id != 3e970d7f (or the row is missing entirely, which 401s via 'JWT sub {Sub} has no provisioned tenant row'). If confirmed, either re-associate the demo user's row to tenant 3e970d7f, or pair the demo user's own device/tenant with real data.

