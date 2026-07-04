---
status: PASS
---
# Review Result: FEAT420 SLICE414: upgrade-path e2e + corrupt-datadir guards (delta re-review, commit de949cc)

- Created: 2026-07-04T13:20:25.136Z
- Reviewer: inspector
- Decision: approved_with_notes
- Status: PASS
- Summary: Delta re-review of commit de949cc274d29606d0bbb035ba01eb81fd1519f1 (stacked on 8dd08ae), addressing the prior CRITICAL finding. FIX CONFIRMED: openDb() (src/storage/db.ts) now branches its catch block on opts.key -- keyed opens that fail get a new EncryptionKeyError (explicitly non-destructive: checks secrets.env key material, stale-global-v0.3.4-install shadowing per this repo's own CLAUDE.md, and key rotation; explicitly says 'Leave this file untouched' and contains no 'delete' anywhere in the message); non-keyed opens keep the original CorruptDatadirError with its restore-or-delete guidance, unchanged. Independently reproduced beyond the builder's own new test: built an actually-encrypted DB via openDb() itself, then (A) wrong key -> EncryptionKeyError, not CorruptDatadirError, message contains 'key' and no 'delete'; (B) real encrypted DB opened with no key -> CorruptDatadirError (acceptable -- caller-side omission of a key it should have resolved, not an ambiguous driver signal); (C) garbage bytes with no key -> CorruptDatadirError; (D) garbage bytes WITH a key supplied -> EncryptionKeyError (appropriately hedged 'not necessarily corruption', still non-destructive); (E) 0-byte file WITH a key supplied -> CorruptDatadirError, confirming the 0-byte guard correctly fires before the try block regardless of key presence since 0-byte truncation is unambiguous independent of key material. No path found where a keyed-open decryption failure lands in CorruptDatadirError, and no path where a non-keyed corruption case lands in EncryptionKeyError. Reran full verification independently on Windows: bunx vitest run tests/storage/ -> 10 files/144 tests passed (was 143; +1 new EncryptionKeyError test with explicit assertions for error type, 'key' in message, and absence of 'delete'); bunx vitest run tests/smoke/ -> 7/7 passed; bun run build -> clean tsc; bunx vitest run (full suite) -> 124 files/1234 passed/4 skipped, matching the builder's reported evidence exactly. Prior LOW finding (src/backup/verify.ts:57, src/cli/restore.ts:56, src/doctor/checks.ts:110/172/197 bypass openDb's guards entirely) is unchanged/out of scope for this fix and remains acceptable given those are read-only snapshot/backup probes, not the live-datadir open path. CRITICAL finding is resolved. Recommend PASS -- ready to merge.
- Evidence Checked: -
- Files Reviewed: -
- Test Adequacy: -
- Risks: -
- Required Follow-up: -

