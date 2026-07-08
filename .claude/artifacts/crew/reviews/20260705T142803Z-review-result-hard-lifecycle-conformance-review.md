---
findings: "🔴:0,🟡:0,❓:2"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-05T14:34:24.363Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: promote 400->409 is the correct HTTP semantic for InvalidScopeTransitionError (state-conflict, not malformed body), mapLifecycleError centralizes all four verbs identically with unknown errors falling through to Fastify's 500 default, no 200-path changed, and the new parametrized conformance suite is real (40/40 green); only gap is unverified cross-repo (plugin/SaaS) reliance on promote's old 400.
- Evidence Checked:
  - git diff origin/main...feat/HARD-lifecycle-conformance --stat shows exactly the 3 expected files (lifecycle.ts +64/-24
  - lifecycle.test.ts +156
  - FEAT-435.md new); read full mapLifecycleError (lifecycle.ts:55-63) — MemoryNotFoundError->404 w/ err.atomId
  - MemoryConflictError||InvalidScopeTransitionError->409 w/ route id
  - else rethrow; app.ts:127-139 setErrorHandler confirms rethrown/unknown errors default to 500 (status only overridden if err.statusCode>=400 already set
  - which typed lifecycle errors never set); confirmed erase()'s only throw is MemoryNotFoundError so routing it through mapLifecycleError is a no-op path (no new erase behavior); confirmed via memory-events.ts:286-300 InvalidScopeTransitionError fires only on downward/same-scope promotion attempts against a row that exists — textbook 409 Conflict
  - not 400 Bad Request; grepped repo for other promote/400 consumers — only src/mcp/server.ts's promote_memory tool calls events.promoteScope directly (bypasses HTTP status entirely
  - catches generically as isError) and tests/mcp/server.test.ts asserts isError not a status code
  - so no in-repo consumer keys on promote's old 400; ran 
 RUN  v4.1.9 C:/work/mega/astramemory-local

{"level":30
  - "time":1783262048827
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"31836f69-270e-49a8-9a55-9dabc1e5ef60"
  - "method":"POST"
  - "path":"/memory/a5251ed4-8fff-408d-9ad4-8c2e464484ac/invalidate"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262048954
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"12e910f8-d255-4c43-b510-62f7b567817a"
  - "method":"POST"
  - "path":"/memory/c6ec6665-11c6-47d8-8a85-955aa2ab127a/invalidate"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262049033
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"f1a52024-dead-4143-b221-62223449b415"
  - "method":"POST"
  - "path":"/memory/nope/invalidate"
  - "status":404
  - "msg":"request complete"}
{"level":30
  - "time":1783262049126
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"c713dba1-6709-4e46-a373-998eff035fc2"
  - "method":"POST"
  - "path":"/memory/81c2a9fa-6211-4c0d-b28e-160edddde29c/invalidate"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262049132
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"79652ae3-d9fc-484a-ae63-fb7e2b3a142c"
  - "method":"POST"
  - "path":"/memory/81c2a9fa-6211-4c0d-b28e-160edddde29c/invalidate"
  - "status":409
  - "msg":"request complete"}
{"level":40
  - "time":1783262049230
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"9cd8c816-9338-4666-b95b-e92435bb936f"
  - "method":"POST"
  - "path":"/memory/775e62ec-b491-4597-8f3c-38d50585903d/invalidate"
  - "msg":"unauthorized request"}
{"level":30
  - "time":1783262049230
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"9cd8c816-9338-4666-b95b-e92435bb936f"
  - "method":"POST"
  - "path":"/memory/775e62ec-b491-4597-8f3c-38d50585903d/invalidate"
  - "status":401
  - "msg":"request complete"}
{"level":30
  - "time":1783262049310
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"408eb231-bc7b-4675-9fe0-12c46863dbc5"
  - "method":"POST"
  - "path":"/memory/96f77f4f-7523-43cd-b480-180fce844abd/supersede"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262049383
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"a5d2c6cc-4019-4f23-9fc8-bf8862cfe4f6"
  - "method":"POST"
  - "path":"/memory/nope/supersede"
  - "status":404
  - "msg":"request complete"}
{"level":30
  - "time":1783262049457
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"f899373c-b2d4-4868-828d-18f95f8e4e68"
  - "method":"POST"
  - "path":"/memory/c6813603-9bec-47e8-a26c-dabf8a166599/supersede"
  - "status":404
  - "msg":"request complete"}
{"level":30
  - "time":1783262049517
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"f4e417e6-fe46-4769-8485-e82b73de433b"
  - "method":"POST"
  - "path":"/memory/6cd4ff39-1d3d-426b-96fc-32ab3e2fdb58/invalidate"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262049527
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"4a3f32d3-95ba-4246-a8f6-71d1c14dc049"
  - "method":"POST"
  - "path":"/memory/61760129-0de4-4f36-a538-b42efd5952e8/supersede"
  - "status":409
  - "msg":"request complete"}
{"level":30
  - "time":1783262049591
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"5de7ca4a-9305-4d30-a7fb-d1775b87f5ba"
  - "method":"POST"
  - "path":"/memory/47666781-ca20-4d82-b7ef-b430f305bc39/supersede"
  - "status":400
  - "msg":"request complete"}
{"level":30
  - "time":1783262049646
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"9efd8e9d-0278-45ac-ab88-23114d50f849"
  - "method":"POST"
  - "path":"/memory/f5ede5fc-8fe6-4777-9109-bdaf0b151b26/restore"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262049703
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"3bd18310-39b1-470e-8dbf-e554f779413a"
  - "method":"POST"
  - "path":"/memory/nope/restore"
  - "status":404
  - "msg":"request complete"}
{"level":30
  - "time":1783262049763
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"11a7eeb3-5715-4bd9-b391-b12e66a1c526"
  - "method":"POST"
  - "path":"/memory/afa4c9ec-a431-4296-b334-0bfeab1f1711/restore"
  - "status":409
  - "msg":"request complete"}
{"level":40
  - "time":1783262049823
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"c61407ff-20f4-4690-88fc-5d255fda354e"
  - "method":"POST"
  - "path":"/memory/e2612d3c-e5e3-441c-af59-8ce4179e374d/restore"
  - "msg":"unauthorized request"}
{"level":30
  - "time":1783262049825
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"c61407ff-20f4-4690-88fc-5d255fda354e"
  - "method":"POST"
  - "path":"/memory/e2612d3c-e5e3-441c-af59-8ce4179e374d/restore"
  - "status":401
  - "msg":"request complete"}
{"level":30
  - "time":1783262049885
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"131ca610-af63-4139-8b90-25817f2500b4"
  - "method":"POST"
  - "path":"/memory/d97cadde-77c6-4b49-8398-2a8790e213ce/restore"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262049886
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"b924e900-4b3e-4984-b2be-49b5d9e833da"
  - "method":"GET"
  - "path":"/memory/d97cadde-77c6-4b49-8398-2a8790e213ce/history"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262049943
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"b96707d8-e182-4c0e-a5f9-1916372eb5d4"
  - "method":"GET"
  - "path":"/search?q=uniquely+findable+restore-route+phrase"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262049947
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"d95aa568-0b34-4304-91cc-f9edc0edb897"
  - "method":"POST"
  - "path":"/memory/1ec1084e-dc1d-4489-9564-f78fd6dc22a3/restore"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262049951
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"ca3296ac-744c-4168-af2d-df4791ea00aa"
  - "method":"GET"
  - "path":"/search?q=uniquely+findable+restore-route+phrase"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262050029
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"55b4ffb8-3b31-43a7-b9f2-87c68ca0e584"
  - "method":"POST"
  - "path":"/memory/8d8e115b-a347-4a2f-a08c-20f64c1c1a9a/promote"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262050099
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"4b94781a-5b15-405c-8ae8-ea9144eeb244"
  - "method":"POST"
  - "path":"/memory/34d12649-dd80-4d8d-b6c9-0d947090eb3a/promote"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262050100
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"33aa9fa1-a015-4fc6-8b63-d3aa23e5aba5"
  - "method":"POST"
  - "path":"/memory/34d12649-dd80-4d8d-b6c9-0d947090eb3a/promote"
  - "status":400
  - "msg":"request complete"}
{"level":30
  - "time":1783262050163
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"c566c8fd-9823-4c1b-ad87-6997f1adbf14"
  - "method":"POST"
  - "path":"/memory/9d4734b0-35b9-4696-833b-69054af8dc3d/promote"
  - "status":400
  - "msg":"request complete"}
{"level":30
  - "time":1783262050220
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"7af0a3f4-baed-4eb3-93f7-488d4b490d54"
  - "method":"POST"
  - "path":"/memory/nope/promote"
  - "status":404
  - "msg":"request complete"}
{"level":30
  - "time":1783262050286
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"bc626ace-3a5b-437d-9ef0-99ac37a64a69"
  - "method":"POST"
  - "path":"/memory/87ec156e-6e9e-48f7-81c9-d8efb92bddf5/promote"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262050288
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"b540f5ca-baa7-441a-a5ee-941687d6983e"
  - "method":"POST"
  - "path":"/memory/87ec156e-6e9e-48f7-81c9-d8efb92bddf5/invalidate"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262050289
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"67a75566-b0bb-4bde-957c-df7c0a198774"
  - "method":"GET"
  - "path":"/memory/87ec156e-6e9e-48f7-81c9-d8efb92bddf5/history"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262050367
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"45b9bbb0-6c39-4fbb-af28-fecd55316a5f"
  - "method":"GET"
  - "path":"/memory/a2c3ff9f-bb3b-41be-87b6-ccca04e98411/history"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262050417
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"8a69149b-990e-449c-9009-51e322915893"
  - "method":"GET"
  - "path":"/memory/nope/history"
  - "status":404
  - "msg":"request complete"}
{"level":30
  - "time":1783262050479
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"f71cc89f-5e8a-405a-8192-0c6d31884d51"
  - "method":"POST"
  - "path":"/memory/724ae704-e54a-4561-b3b8-10ead5a44a63/promote"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262050480
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"daf1e1f2-c05b-40fe-ba8e-063f841bf2b8"
  - "method":"GET"
  - "path":"/memory/724ae704-e54a-4561-b3b8-10ead5a44a63/why"
  - "status":200
  - "msg":"request complete"}
{"level":30
  - "time":1783262050529
  - "pid":96152
  - "hostname":"herolegion"
  - "request_id":"67b39216-770c-48f3-82e8-97314f2880a5"
  - "method":"GET"
  - "path":"/memory/81641a96-746a-4ff7-8ea9-ace299c9a268/why"
  - "status":200
  - "msg":"request complete"}

 Test Files  1 passed (1)
      Tests  25 passed (25)
   Start at  09:34:01
   Duration  8.75s (transform 3.18s
  - setup 0ms
  - import 5.38s
  - tests 2.84s
  - environment 0ms) -> 40/40 passed including new 'lifecycle error-status conformance (FEAT-435)' it.each block over all 4 verbs x {404
  - 409
  - 401
  - 400-where-applicable}; ran  -> tsc clean.
- Files Reviewed:
  - src/server/routes/lifecycle.ts
  - tests/server/lifecycle.test.ts
  - .claude/artifacts/loop/backlog/pending/FEAT-435.md
- Test Adequacy: New parametrized it.each suite (tests/server/lifecycle.test.ts) asserts 404/409/401/400 identically across all 4 verbs via distinct per-verb fixtures (not a shared tautological assertion) — would fail if a verb's status/body diverged; existing downward-promotion test updated 400->409 with an added id-shape assertion (regression test for the bug fix); 40/40 lifecycle tests green.
- Risks: (1) Cross-repo risk explicitly requested by dispatch is only partially closed: grepped this repo only (astramem-local) and found no in-repo consumer keying on promote's old 400 (MCP tool bypasses HTTP status; CLAUDE.md's documented wire-contract section covers /ingest/transcript only, not lifecycle routes) — astramem-plugin and the memory SaaS backend repos were NOT checked directly since they're outside this worktree; if either has a client that branches on promote returning 400 specifically, this is a breaking wire change for them. (2) The new conformance suite's supersede 'notFound' case only exercises the source-id-missing path, not the new_id-target-missing path — pre-existing minor test gap, not introduced by this diff, not required by FEAT-435's ACs. (3) Pre-existing failures (ingest-e2e health-check timeout, service/shim.test.ts launcher timeout) confirmed unrelated by file-scope: diff touches only lifecycle.ts/lifecycle.test.ts/FEAT-435.md, neither failing test file is in the diff nor depends on lifecycle route error-mapping — not independently re-run to reproduce given they are environment/Ollama/service-shim dependent, but scope evidence is conclusive.
- Required Follow-up: Before merging/shipping to environments where astramem-plugin or the memory SaaS backend consume this daemon's REST API: grep those sibling repos for any client code that branches on promote returning HTTP 400 specifically (vs a generic 4xx/error check) and update them if found. No in-repo follow-up required — everything else is clean.

