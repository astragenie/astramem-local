---
status: needs_fix
---
# Review Result: FEAT420 SLICE414: upgrade-path e2e + corrupt-datadir guards

- Created: 2026-07-04T13:10:57.452Z
- Reviewer: inspector
- Decision: approved_with_notes
- Status: needs_fix
- Summary: CRITICAL: openDb()'s new CorruptDatadirError wrapping (src/storage/db.ts:47-72) is a blanket catch-all around the try block that also contains PRAGMA key application (line 50) and all subsequent pragmas/vec-load. Verified by direct reproduction against better-sqlite3-multiple-ciphers: opening an encrypted DB with a WRONG key or NO key throws the identical SqliteError SQLITE_NOTADB 'file is not a database' as genuine corruption/garbage bytes. openDb wraps this into CorruptDatadirError telling the operator 'This looks like a corrupted or truncated SQLite datadir... if you are certain there is no data to lose, delete the file... and restart to create a fresh one.' This is exactly the documented failure class in this repo's CLAUDE.md (stale v0.3.4 global shadow install throws SQLITE_NOTADB against the encrypted DB) plus any keystore/key-resolution bug -- an operator hitting a recoverable auth problem is now told their data is corrupted and steered toward deleting a healthy encrypted database. Recommend: special-case SQLITE_NOTADB/'file is not a database' when opts.key was supplied (or file is known-encrypted) to mention the wrong/missing-key possibility instead of asserting corruption, before offering deletion as a resolution path. LOW: src/backup/verify.ts:57, src/cli/restore.ts:56, src/doctor/checks.ts:110/172/197 construct Database directly, bypassing openDb's new guards entirely (read-only snapshot/backup probes, defensible scope, but the 'every caller gets an actionable error' framing doesn't fully hold). VERIFIED CLEAN: 0-byte rejection is legitimate (grepped src/ -- nothing pre-creates an empty file at the datadir path; doctor probe uses a separate randomized filename); migrate.ts change is a pure try/catch wrap around the existing tx() call, zero changes to migration order/content/skip logic; fixture generator is deterministic (fixed BASE_TS epoch, no Date.now/Math.random); .gitignore exception verified scoped via git check-ignore (real datadir paths and secrets.env remain ignored, only tests/storage/fixtures/**/*.sqlite un-ignored). Reran independently on Windows: bunx vitest run tests/storage/upgrade-path.test.ts tests/storage/ -> 10 files/143 tests passed (6 new); bun run build -> clean; bunx vitest run tests/smoke/ -> 7/7 passed confirming openDb changes don't break daemon boot.
- Evidence Checked: -
- Files Reviewed: -
- Test Adequacy: -
- Risks: -
- Required Follow-up: -

