---
findings: "🔴:0,🟡:1,❓:0"
status: completed
decision: approved_with_notes
author_id: crew:fullstack-dev
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-18T07:57:48.556Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Round 2 (tip a75a7082, fix 56116f75): HIGH resolved. COMMAND_LEAD_RE is now case-insensitive; my exact original repro against the rebuilt dist now returns typeHintApplied={from:fact,to:command,matchedPattern:leading-shell-token} for a bun-led atom. 'make' was correctly dropped from COMMAND_TOKENS to avoid a real collision with the decision-imperative gate (verified: the only 'Make ...' gold atom is fx21's decision, not a command fixture). New regression tests exercise the REAL call sites (memoryNormalize, runTypeBackfillBatch via a normalizeText()-derived normalized_text seed) and assert the intermediate capitalized state, so they would fail without the fix. AC-B1 census now runs normalizeText() before getTypeHint(), matching production order; numbers unchanged (10/13/1 fires, 100% precision each, 0 ambiguous) as expected since the fix only restores previously-dropped fires. Full re-run: bun run build clean, 66 files / 1210 tests green. Approving with notes: the MEDIUM checkpoint-atomicity finding from round 1 remains open, explicitly deferred as a non-blocking follow-up in the fix commit message.
- Evidence Checked:
  - Live repro re-run against rebuilt dist/distill/stages/07-memory-normalize.js: normalizeText('bun run test')==='Bun run test'; memoryNormalize([{type:fact
  - text:'bun run test'
  - ...}]) now returns type='command'
  - typeHintApplied={from:fact
  - to:command
  - matchedPattern:leading-shell-token} (previously undefined). git show 56116f75 -- src/distill/type-hints.ts: COMMAND_LEAD_RE gained 'i' flag; 'make' removed from COMMAND_TOKENS with inline rationale citing the real fx21 decision-atom collision. Verified via grep of scripts/eval/extraction-bench/fixtures/*.json: zero gold atoms have type=command with 'make'-led text; the sole 'Make ...' atom (fx21-deploy-incident-rollback.json:22) is type=decision. tests/distill/07-memory-normalize.test.ts gained 2 new tests asserting normalizedText==='Bun run test'/'Vitest run tests/foo.test.ts' THEN type==='command' via the real memoryNormalize() call. tests/storage/backfill-types.test.ts gained seedNormalized() (uses real normalizeText()) + a test asserting stored normalized_text==='Bun run test' THEN runTypeBackfillBatch --apply retypes to 'command'. tests/distill/type-hints.test.ts's AC-B1 census loop now calls normalizeText(atom.text) before getTypeHint(); re-ran via vitest --reporter=verbose: command fires=10/10 correct
  - decision fires=13/13
  - lesson fires=1/1
  - event 0 fires
  - 0 ambiguous - identical to round-1 numbers. unset ASTRA_SKIP_CONSOLIDATE; bun run build -> clean; npx vitest run tests/distill/ tests/storage/ tests/config/ -> 66 files / 1210 tests passed (exact expected count).
- Files Reviewed:
  - src/distill/type-hints.ts
  - tests/distill/type-hints.test.ts
  - tests/distill/07-memory-normalize.test.ts
  - tests/storage/backfill-types.test.ts
- Test Adequacy: 1210/1210 targeted tests green (independently re-run), including 3 new end-to-end regression tests that route through the real memoryNormalize()/runTypeBackfillBatch() call sites with asserted intermediate ENTITY_DICT-transformed state, closing exactly the coverage gap that let round-1's HIGH finding ship green. AC-B1 census methodology corrected to match production normalize-then-hint order.
- Author: crew:fullstack-dev
- Judge: crew:reviewer
- Risks: MEDIUM (carried over from round 1, explicitly deferred, non-blocking): backfill-types.ts's checkpoint write (writeCheckpoint, non-atomic writeFileSync) still doesn't match writeConfig()'s tmp+rename pattern - self-heals via malformed-JSON-to-rowid-0 fallback, worst case is a full-corpus rescan after a crash mid-write, never data loss or a double-apply.
- Required Follow-up: Optional follow-up: make backfill-types.ts's checkpoint write atomic (tmp+rename) to match writeConfig()'s established pattern for the identical hazard class. Not required before merge.

