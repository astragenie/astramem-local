# Task Handoff: Search debug param + worker-disable config for A/B recall test

- Created: 2026-07-19T15:28:19.513Z
- From: researcher
- To: dispatcher
- Objective: No HTTP debug query param exists on GET /search or POST /recall; disabling the metered LLM drain is a config-only change (contradictionDetection.mode + dupJudge.mode = off), workers themselves always start.
- Allowed Scope:
  - Read-only: src/server/routes/search.ts
  - src/search/search.ts
  - src/config/config.ts
  - src/cli/serve.ts
  - src/pipeline/handlers/consolidate.ts
  - src/config/isolated-mode.ts
  - src/server/routes/dashboard-search-html.ts
- Forbidden Scope: -
- Deliverable: Two findings reported inline to dispatcher: (1) no debug/source/bm25 param on public HTTP endpoints — that shape only exists internally via search()'s debug:true option, consumed today only by GET /dashboard/search (HTML page, not JSON API, no client-facing debug toggle). (2) background workers (distill/consolidate/reembed/etc) always start in serve.ts regardless of config — the LLM-driving gate is per-job-run inside consolidateHandler reading config.consolidation.contradictionDetection.mode and config.consolidation.dupJudge.mode; setting both to 'off' in the copy's config.yaml prevents the judge from calling the LLM on the 792 pending proposals without needing to stop workers or fake the LLM provider.
- Changed Files:
  - src/server/routes/search.ts
  - src/search/search.ts
  - src/config/config.ts
  - src/cli/serve.ts
  - src/pipeline/handlers/consolidate.ts
  - src/config/isolated-mode.ts
  - src/server/routes/dashboard-search-html.ts
- Confidence: high
- Risks: Did not verify whether any OTHER job type (e.g. distillHandler, gatekeeper, atomTriage) also drains the same 792-proposal backlog via a separate LLM call path — only consolidateHandler was checked. Did not check whether ASTRA_MEMORY_ISOLATED=1 or a mock LLM provider swap is a cleaner alternative for a copy-store test than editing config.yaml mode keys.
- Suggested Next Handoff: If dispatcher wants a client-facing debug param on GET/POST /search or /recall (not just the internal dashboard), that is new feature work, not a research question — route to crew:architect-feature or crew:fullstack-dev.

