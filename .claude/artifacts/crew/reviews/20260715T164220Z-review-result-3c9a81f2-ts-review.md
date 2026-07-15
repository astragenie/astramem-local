---
findings: "🔴:0,🟡:2,❓:1"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-15T16:45:03.927Z
- Reviewer: typescript-reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Worker-offload + health-cache fix is sound TypeScript/async design (correct WAL read-isolation, correct fallback posture, matching score mapping, no floating promises); one real gap — shutdown never clears the module-level offload slot, and a multi-request worker crash can stampede several synchronous fallback scans onto the loop at once, undercutting the incident this commit fixes.
- Evidence Checked:
  - MEDIUM src/cli/serve.ts:611-631 shutdown() awaits vecSearchHost.stop() but never calls setVecSearchOffload(null) afterward — the module-level slot in vec-search-offload.ts keeps referencing a closure over the now-terminated host/closed db
  - a real half-configured state the module's own doc comment says must be impossible; low risk in the current single-serve()-per-process daemon
  - but a footgun for any future in-process restart/test harness that calls serve() twice. MEDIUM src/vector/vec-search-host.ts 'error'/'exit' handlers call failAll(err) which rejects every entry in the pending map at once when the worker crashes mid-flight — if N recalls were concurrently in-flight against the same worker
  - all N independently fall back to the synchronous main-thread KNN scan in the same event-loop tick
  - i.e. exactly the loop-stacking pattern this commit exists to prevent
  - just triggered by a worker crash instead of high query volume; worth a queued/coalesced fallback or a serialized retry in a follow-up. INFO (no action) verified as correct: worker connection is readonly+WAL so it never blocks the main writer
  - busy_timeout=5000 covers transient lock contention with the hourly wal_checkpoint(TRUNCATE) already wrapped in try/catch+warn in serve.ts (pre-existing
  - unchanged); WAL readonly connections take a fresh snapshot per statement in better-sqlite3 so no stale-read hazard across recall calls; ensureWorker()/searchOnWorker() have no double-spawn race under concurrent search() calls (readyPromise is checked-then-set synchronously
  - JS is single-threaded); PRAGMA key escaping in the worker matches the codebase's existing convention (backup/verify.ts
  - restore.ts
  - storage/db.ts); score mapping 1/(1+distance) is copy-pasted correctly from SqliteVecStore.search and covered by both the fake-worker unit tests and a real dist-worker integration test; healthRoute() is registered exactly once per app (server/app.ts:220)
  - so the TTL-cache closure is per-app-instance and existing tests that build a fresh app per test are unaffected by the 60s staleness; search.ts's offload consult point applies no filters either way so filter/entity paths downstream are unaffected
  - and dim mismatch is a non-issue since only serve.ts (one config) ever registers the slot.
- Files Reviewed:
  - src/vector/vec-search-host.ts
  - src/vector/vec-search-worker.ts
  - src/vector/vec-search-offload.ts
  - src/cli/serve.ts
  - src/search/search.ts
  - src/server/routes/health.ts
  - tests/vector/vec-search-host.test.ts
- Test Adequacy: Commit message reports: 9 host tests (fake-worker DI incl. score mapping, no-transfer copy, req-error/timeout/crash fallbacks, respawn, clean stop) + 1 real worker-thread integration test proving parity with the sync store; search/eval/mcp suites 331/331; tsc clean. Not independently re-run by this TS-stack review (scope is static/design review of the diff, not test execution).
- Risks: -
- Required Follow-up: -

