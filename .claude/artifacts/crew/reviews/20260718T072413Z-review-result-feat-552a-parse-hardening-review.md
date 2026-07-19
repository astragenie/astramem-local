---
findings: "🔴:0,🟡:0,❓:0"
status: completed
decision: approved
author_id: crew:fullstack-dev
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-18T07:27:41.455Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: AC-A1/A2/A3 all verified correct by hand-trace + hostile-fixture tests + full 556/556 green re-run; salvage runs strictly after parse+dup-key fail and reuses the same validation pipeline; dup-key lexer's per-scope Set provably cannot false-positive on sibling atom objects; all 5 sweeper few-shot evidence quotes verified verbatim substrings of their own inputs; ExtractResult.salvage is additive with no breaking consumers.
- Evidence Checked:
  - FEAT-552A (extraction parse hardening) — independent review
  - worktree astramemory-local-wtA
  - branch feat/552a-parse-hardening
  - base 98515925
  - tip 362f0ee3.

Files reviewed in full: src/distill/stages/parse-salvage.ts (new)
  - src/distill/stages/05-extract.ts (tryParseAtoms/ExtractResult diff)
  - src/distill/prompts/extract.ts (sweeper-prompt diff only)
  - tests/distill/stages/parse-salvage.test.ts
  - tests/distill/05-extract.test.ts (FEAT-552 block + surrounding invariant tests)
  - tests/distill/prompts/extract.test.ts (not separately re-read verbatim but its assertions cross-checked against the actual prompt diff).

AC-A1 (truncation salvage): traced tryParseAtoms — dup-key check runs first
  - then JSON.parse+Zod
  - and salvageTruncatedAtoms is only reached in the fallthrough after both have failed (line ~640-699 of 05-extract.ts). Recovered raw atom objects are passed through the SAME runAtomFilterPipeline (coerceEntityKinds -> filterAtomEntities -> filterAtomRelations -> AtomSchema.safeParse -> requireEvidenceForRichTypes) as a clean parse — no bypass of validation. lostCount composition verified by hand-trace: objTexts.length complete candidates + at most 1 for a genuinely truncated tail (bounded because only one incomplete `{` can exist at end of input); cannot overcount since it's exactly "number of complete candidates found" + "0 or 1 for an unclosed tail"
  - never inferred from a guessed total. recoveredCount===0 forces salvageTruncatedAtoms to return null
  - so a totally-unsalvageable response still throws TransientError exactly as before (verified by its own test + full-suite green).

AC-A2 (dup-key lexer): hand-traced the stack-based scoping in detectDuplicateKey — each `{` pushes a FRESH Set
  - each `}` pops it
  - so sibling objects (e.g. N atoms in the atoms[] array
  - each with "text"/"type"/etc.) never share a keys-Set instance and cannot false-positive against each other. This is the exact classic trap named in the review brief
  - and it does NOT trip: confirmed by (a) explicit unit tests (nested-different-scope
  - value-vs-key-position
  - escaped-quotes) and (b) far stronger evidence — the dup-key check now runs on literally EVERY real extraction call before JSON.parse
  - and the full pre-existing 556-test suite (multi-atom fixtures
  - multi-entity arrays sharing "name"/"kind" keys
  - multi-relation arrays sharing "subject"/"predicate"/"object") stays 100% green
  - which would not be possible if the lexer flagged legitimate sibling-object key reuse.

AC-A3 (sweeper prompt): git diff confirms ONLY EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER changed; passA prompts (V1/V2/V3/CONVERSATIONAL) untouched. Evidence-first field ordering present in both the illustrated schema and all 5 non-empty few-shot examples. "ATOMS WITHOUT A VERBATIM EVIDENCE QUOTE ARE DISCARDED" warning added. Manually verified all 5 evidence quotes are exact verbatim substrings of their own example's Input string (example 2's evidence intentionally keeps the pre-resolution "last week" phrase
  - not the resolved date in "text" — correct per the date-grounding rule elsewhere in this prompt). Example 6 (small talk) correctly has no evidence field since atoms:[].

Additive shape: ExtractResult.salvage is optional; grepped src/ for ExtractResult/.salvage consumers — only 05-extract.ts itself sets/reads it; pipeline.ts destructures relationDropCounts/evidenceDropCounts by name only
  - so the added field is inert there. No consumer breaks.

Gates re-run in worktree (unset ASTRA_SKIP_CONSOLIDATE):
- bun run build -> clean
- bun run typecheck:tests (tsc -p tsconfig.tests.json) -> clean
- bun run typecheck:eval (tsc -p tsconfig.eval.json) -> clean
- npx vitest run tests/distill/ -> 24 files
  - 556/556 passed (matches handoff claim
  - re-verified fresh
  - not reused from a stale run)

No CRITICAL/HIGH/MEDIUM findings. Two pre-flagged-by-builder
  - non-blocking follow-ups (already named in the handoff
  - not new findings): (1) ExtractResult.salvage is log-only
  - not yet persisted to a DB counter/doctor canary — explicitly a scope call
  - not a bug; (2) AC-A3's live gate-drop-rate re-measurement is deferred pending GPU availability — the string-level prompt contract is what this slice promised and it is proven.

Decision: approved.
- Files Reviewed:
  - src/distill/stages/parse-salvage.ts
  - src/distill/stages/05-extract.ts
  - src/distill/prompts/extract.ts
  - tests/distill/stages/parse-salvage.test.ts
  - tests/distill/05-extract.test.ts
  - tests/distill/prompts/extract.test.ts
- Test Adequacy: 556/556 tests green across 24 files (tests/distill/), re-run fresh in-worktree; dedicated FEAT-552 describe block covers salvage recovery, byte-identical healthy path, severe-truncation-still-throws, dup-key detection, and the A1/A2 interplay case; sibling-object false-positive risk is covered both by explicit unit tests and by every pre-existing multi-atom/multi-entity/multi-relation fixture staying green with the dup-key check now wired into every real call.
- Author: crew:fullstack-dev
- Judge: crew:reviewer
- Risks: none blocking — two pre-named-by-builder non-blocking follow-ups: salvage counts are log-only (not yet a persisted DB counter/doctor canary), and AC-A3's live gate-drop-rate re-measurement is deferred pending GPU availability (string-level prompt contract is proven; live re-measure is out of this slice's scope).
- Required Follow-up: none required to merge this sub-scope; optional follow-up FEATs: (1) persist salvage recovered/lost as a counter + doctor canary mirroring relationDropCounts/evidenceDropCounts, (2) live 5-fixture mock-bench re-measurement of AC-A3's evidence gate-drop rate once GPU lane frees up.

