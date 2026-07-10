---
findings: "🔴:0,🟡:1,❓:0"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-09T11:03:35.434Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: HIGH classifier over-firing fix is correct and test-verified (6 junk atoms still gate, 5 rationale-bearing durable atoms now persist); revert of the out-of-scope table/schema-bump is clean; one new MEDIUM false-negative surface empirically confirmed and non-blocking.
- Evidence Checked:
  - Read src/distill/durability-gate.ts in full + tests/distill/durability-gate.test.ts (25 tests
  - all pass). Ran targeted suite: tests/distill/durability-gate.test.ts tests/distill/08-embed-index.test.ts tests/eval/durability-gate-eval.test.ts tests/server/search.test.ts tests/doctor/durability-gate-mode-check.test.ts tests/config/config.test.ts tests/config/loader.test.ts -> 7 files / 116 tests pass. bun run build exit 0. Empirically ran classifyDurability() from dist against 9 hand-built edge cases (script deleted after use): confirmed all 6 memory#659 junk atoms still gate with correct gatedReason and the 5 rationale-bearing durable atoms from the regression test file all classify null (persist) -- matches the fix's stated intent. BUT also confirmed a false-negative gaming surface: 'The build is currently green since 3pm.' -> null
  - 'Commit abc1234 merged since last week.' -> null
  - 'It is running because deploy.' -> null
  - 'Status is red because reasons.' -> null
  - 'Build is failing --verbose flag set.' -> null -- all 5 are short junk atoms that pre-fix would have correctly gated (ephemeral_state/git_derivable) but now escape via RATIONALE_MARKER_RE's bare keyword-presence match ('since' used temporally not causally
  - '--' as a CLI flag not an em-dash
  - 'because'/'reason' attached to a contentless clause). Control case 'Trunk status is green.' -> ephemeral_state (correctly still gated)
  - confirming the guard is content-blind
  - not a regression in the tested paths. Revert cleanliness: grep for durability_gate_log/recordDurabilityGateEvent/countDurabilityGateEvents across src+tests+migrations returns zero matches; SCHEMA_VERSION=21 confirmed at src/server/lib/wire-meta.ts:99; git diff HEAD -- src/server/queries/provenance.ts is empty (0 lines); no 022*durability* migration file found; AC-7 retention confirmed as redactIfEnabled -> childLogger.warn at src/distill/stages/08-embed-index.ts:136-139
  - no CREATE TABLE anywhere in the diff.
- Files Reviewed:
  - src/distill/durability-gate.ts
  - tests/distill/durability-gate.test.ts
  - src/distill/stages/08-embed-index.ts
  - src/config/config.ts
  - src/server/lib/wire-meta.ts
  - src/server/queries/provenance.ts (confirmed untouched)
- Test Adequacy: 25 dedicated durability-gate tests cover both directions convincingly: 6 memory#659 junk atoms (gate with correct gatedReason), 5 rationale-bearing durable atoms from the HIGH regression (persist as null), plus mode-semantics (off/strict/lenient) and prior edge cases (empty text, embedded path fragments, long bare-todo). 116 tests pass across the 7 slice-scoped files touched by this fix pass; no regression.
- Risks: MEDIUM (non-blocking): RATIONALE_MARKER_RE is a bare keyword-presence check with no semantic/proximity requirement, so a short junk atom can escape ephemeral_state/git_derivable/vacuous_negative/bare_todo gating just by containing 'since' (often used temporally, not causally), a literal '--' (CLI flag, not em-dash), or 'because'/'reason' attached to a contentless clause -- empirically confirmed, see Evidence. This is a NEW false-negative surface for the 3 categories the fix extended the guard to (bare_todo already had this exact gap pre-fix, out of scope of this HIGH). Mitigating factors: consistent with the PM pre-mortem's explicit bias toward under-gating over over-gating (gated atoms have no rollback path, PM review 20260709T095000Z), inert today since distill.durabilityGate defaults to 'off', and no AC claims to have closed this gap.
- Required Follow-up: Non-blocking follow-up before distill.durabilityGate is ever defaulted to lenient/strict in any environment: tighten RATIONALE_MARKER_RE to require the marker be causally connected to the trigger clause (e.g. reject bare 'since <time-expression>', require '--' to look like a real em-dash context not a CLI-flag-shaped token) so short junk atoms can't trivially game the exemption. Track as a fast-follow, not a blocker for this fix pass.

