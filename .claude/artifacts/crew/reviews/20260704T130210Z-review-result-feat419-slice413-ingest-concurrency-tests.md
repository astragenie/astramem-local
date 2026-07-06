---
status: PASS
---
# Review Result: FEAT419 SLICE413: ingest concurrency tests

- Created: 2026-07-04T13:02:10.031Z
- Reviewer: inspector
- Decision: approved_with_notes
- Status: PASS
- Summary: No-race claim verified by direct code read: both transcript-kind (ingest.ts:412-492) and events-kind (via claimIdempotencySlot/finalizeIdempotencySlot, ingest.ts:296-332) paths run the full claim-insert-finalize sequence inside one better-sqlite3-multiple-ciphers db.transaction() closure with zero await statements; better-sqlite3 is synchronous/blocking and Node run-to-completion semantics mean no interleaving is possible regardless of transport (real socket or inject()). Idempotency insert (stmtInsertIdempotency/ON CONFLICT DO NOTHING) is inside the transaction on both paths. No CRITICAL race found. Test strength verified: AC-1 asserts creators.length===1, replays.length===4, ids.size===1 (catches __pending__ leak or divergent replay ids), and distill job delta===1 (catches double-enqueue) -- would fail if the hypothesized race existed. AC-3 asserts exactly one 200 + one 409 via sorted status codes plus DB-row counts (transcripts=1, ingest_idempotency=1) -- catches partial/duplicate writes. Concurrency is realistic: real app.listen() on an ephemeral port + native fetch() over OS sockets (not .inject(), which serializes at Fastify's dispatch layer), confirmed via grep of app.ts hooks (onRequest/onResponse/preHandler/error-handler) -- none add locking, queuing, or rate-limiting that would serialize concurrent requests. Flake resistance: waitFor() is a bounded deterministic poll (20ms interval, explicit timeoutMs deadline, throws on deadline) -- no blind sleeps. Reran the full concurrency suite twice independently: 3/3 pass both times, ~3s each, no flakiness observed. bun run build (tsc -p .) is clean. AC-1 interpretation (one idempotent:false creator + k-1 idempotent:true replays sharing one non-placeholder summary_memory_id, rather than literal byte-identical response bodies) matches the existing sequential contract verified in tests/server/ingest.test.ts:332-358 and :458-504, which uses the identical idempotent:false/true + summary_memory_id-equality pattern -- consistent, not a novel interpretation. Diff is test-only (285 lines, one new file), zero production changes, matching the AC-4 'all green, no fix needed' branch.
- Evidence Checked: -
- Files Reviewed: -
- Test Adequacy: -
- Risks: -
- Required Follow-up: -

