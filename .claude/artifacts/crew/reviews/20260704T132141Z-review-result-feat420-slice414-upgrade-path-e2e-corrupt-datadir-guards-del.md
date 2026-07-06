---
status: PASS
---
# Review Result: FEAT420 SLICE414: upgrade-path e2e + corrupt-datadir guards (delta)

- Created: 2026-07-04T13:21:41.078Z
- Reviewer: inspector
- Decision: approved_with_notes
- Status: PASS
- Summary: Delta review after de949cc (orchestrator inline — original reviewer stalled; verified diff, reran tests). CRITICAL resolved: openDb branches on opts.key — keyed opens throw new EncryptionKeyError (actionable: secrets.env key material, stale-global-install shadowing, key rotation; explicitly leaves file untouched, zero deletion language), keyless opens keep CorruptDatadirError unchanged; typed errors pass through. New regression test: plaintext fixture + bogus key -> instanceof EncryptionKeyError, not CorruptDatadirError, message has 'key', no 'delete'. Reran: build clean, tests/storage/+tests/smoke/ 151/151, full suite 1234 pass / 4 skip. LOW note (direct Database() constructions in backup/restore/doctor probes) stands as no-action-required.
- Evidence Checked: -
- Files Reviewed: -
- Test Adequacy: -
- Risks: -
- Required Follow-up: -

