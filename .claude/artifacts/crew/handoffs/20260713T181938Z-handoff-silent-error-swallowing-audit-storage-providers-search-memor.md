# Task Handoff: Silent-error swallowing audit — storage/providers/search/memory-tool/mcp/cli/service/server/backup/config/vector

- Created: 2026-07-13T18:19:38.494Z
- From: researcher
- To: dispatcher
- Objective: Two DANGEROUS sites found (POST /remember REST route and MCP remember tool both return ok:true after a swallowed vec-upsert failure, silently degrading to FTS-only with no caller-visible signal); everything else in scope is either properly surfaced (warn+degraded status, exit codes, structured error returns) or genuinely non-critical cleanup/telemetry.
- Allowed Scope:
  - src/storage(except migrate*.ts)/providers/search/memory-tool/mcp/cli/service/server(routes+app+health-state)/backup/config/vector — every catch
  - .catch()
  - and fail-open/best-effort/silently/non-fatal comment
- Forbidden Scope: -
- Deliverable: Full findings table returned inline to dispatcher (grouped by directory, DANGEROUS first); 2 DANGEROUS, 2 UNCLEAR, remainder LEGITIMATE (grouped)
- Changed Files:
  - src/server/routes/search.ts:306
  - src/mcp/server.ts:440
  - src/cli/reinstall.ts:357
  - src/backup/retention.ts:32
- Confidence: high
- Risks: src/vector/** had zero matches (dir may not exist or has no catches — confirm with the migrate.ts-focused agent); did not exhaustively read every LEGITIMATE-bucketed line byte-for-byte once pattern was established after ~15 files, relying on consistent style within a file
- Suggested Next Handoff: triage agent should decide whether the /remember + MCP-remember vec-upsert-failure gap warrants a response field (e.g. vec_indexed:false) or a reembed-queue enqueue on failure, since today nothing ever retries or surfaces it beyond a log line

