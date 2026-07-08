---
findings: "🔴:0,🟡:0,❓:0"
status: completed
decision: approved
---
# Review Result: Review Result

- Created: 2026-07-05T14:35:43.189Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: Migration 014 mirrors migration 010 exactly (single-row id=1, no destructive DDL); SCHEMA_VERSION 13->14 bump is consistent everywhere referenced, enforced further by a runtime drift-guard test; sanitizeShipError genuinely strips the real token via string split/join before persist and is verified end-to-end via HTTP; the ship POST/decision logic in shipOnce is byte-unchanged; last_ship shape is untouched; full suite is green at exactly 1297 passing.
- Evidence Checked:
  - migrations/014-sync-ship-state.sql: CREATE TABLE sync_ship_state (id INTEGER PRIMARY KEY CHECK (id=1)
  - ...) with no IF NOT EXISTS
  - matching migration 010 sync_pull_state verbatim (010 also lacks IF NOT EXISTS; safety comes from migrate.ts schema_version-tracked skip-if-applied logic
  - not per-file idempotency). wire-meta.ts SCHEMA_VERSION 13 to 14; grepped every file referencing schema_version/SCHEMA_VERSION in the repo (14 files) -- the 3 files not in the diff (memory-events.test.ts
  - health-hardening.test.ts
  - snapshot.test.ts) do not hardcode the count or version
  - so nothing was missed. migrate.ts has a boot-time drift guard (throws if DB max version != SCHEMA_VERSION) that independently enforces consistency at runtime
  - and its own test was updated for 14. shipper.ts diff shows shipOnce (the actual HTTP POST plus ack logic) is completely untouched; only round() gained recordShipSuccess/recordShipFailure calls plus a mechanical hoist of the delay variable with identical value semantics (intervalMs
  - or backoffDelay(intervalMs
  - failures) on error -- same as before). sync-status.ts adds last_attempt as a new sibling block; the last_ship block (at/status) is byte-identical to origin/main. sanitizeShipError uses message.split(token).join('[redacted]') -- a real substring replace
  - not a placeholder swap -- and both tests/sync/shipper.test.ts and tests/server/sync-status.test.ts seed a realistic embedded token (super-secret-device-token-abc123) inside a thrown Error and assert JSON.stringify(body) excludes it end-to-end through the actual HTTP route. upsertShipState uses INSERT ... ON CONFLICT(id) DO UPDATE -- single-row upsert
  - no accumulation
  - no race (JS single-threaded plus inFlight promise chaining in startShipper serializes rounds). Ran bun run build (tsc -p .) clean
  - and bun run test: Test Files 131 passed (131)
  - Tests 1297 passed
  - 4 skipped (1301) -- matches the expected 1297.
- Files Reviewed:
  - migrations/014-sync-ship-state.sql
  - src/server/lib/wire-meta.ts
  - src/server/routes/sync-status.ts
  - src/sync/shipper.ts
  - tests/sync/shipper.test.ts
  - tests/server/sync-status.test.ts
  - tests/server/version.test.ts
  - tests/storage/migrate.test.ts
  - tests/storage/atom-v3.test.ts
  - tests/storage/entities.test.ts
  - tests/storage/upgrade-path.test.ts
  - tests/integration/ingest-e2e.test.ts
  - .claude/artifacts/loop/backlog/pending/FEAT-434.md
- Test Adequacy: New unit coverage in tests/sync/shipper.test.ts (state persistence defaults, success/failure recording, overwrite-not-accumulate semantics, sanitizeShipError redaction including multi-occurrence and length cap, end-to-end failure-then-success via startShipper) plus tests/server/sync-status.test.ts extends the FEAT-427 secret-exclusion test with a realistic-shaped embedded token asserted absent from the full JSON response body; mechanical schema-version-count bumps verified complete via repo-wide grep. All 1297 tests pass.
- Risks: None material. Minor observation, not blocking: sanitizeShipError redaction is a plain string split/join scoped to the exact token string -- sufficient for today's failure paths (HTTP status text or transport errors, per the code's own comment) since the token is sent only as a header and never interpolated into thrown messages today, but is defense-in-depth rather than a structural guarantee against every conceivable future error source.
- Required Follow-up: none

