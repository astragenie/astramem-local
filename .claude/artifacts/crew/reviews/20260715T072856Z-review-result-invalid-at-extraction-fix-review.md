---
findings: "🔴:0,🟡:0,❓:0"
status: completed
decision: approved
---
# Review Result: Review Result

- Created: 2026-07-15T07:32:08.624Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: Approach B (text-encoding only, no bound-emission) closes the invalid_at extraction gap without adding any new invalid_at/valid_to emission path; the one touched hard-rule sentence is tightened (requires a stated date) not loosened, and the new guidance explicitly forbids the capture-date-anchoring hallucination shortcut by name.
- Evidence Checked:
  - All changed lines (extract.ts ~372-480) verified via grep boundaries to sit strictly inside EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL (308-482)
  - ending before V2 (483) and V3/engineering (646) -- engineering profile untouched as claimed. Pre-existing hard rule "Never guess a bound from silence: a hallucinated invalid_at is worse than none" (extract.ts:372-373) is intact verbatim. The one sentence the diff edits (374-376
  - "prefer emitting the OLD fact with invalid_at set") now requires "AND the source states a date for the change" -- a tightening. New dateless-full-stop guidance explicitly forbids anchoring invalid_at to the capture/observation date
  - naming it "its own kind of hallucination
  - just a subtler one." git diff --stat confirms only extract.ts and extract.test.ts changed; src/distill/stages/08-embed-index.ts (guardValidTo/decideValidTo) has a verified 0-line diff against origin/main. Examples 10-12 (drums/dog cessation
  - hiking WRONG/RIGHT counter-example) checked against the literal JSON -- neither cessation atom's JSON contains "invalid_at"; example numbering 1-12 is sequential
  - no collisions. Ran bun vitest run tests/distill/prompts/extract.test.ts with the branch's files in place: 61/61 passed including 6 new tests asserting rule text
  - the anti-capture-date guardrail text
  - both few-shot pairs
  - the WRONG/RIGHT counter-example
  - and an AtomSchema.safeParse round-trip proving a text-only cessation atom parses with valid_at and invalid_at both undefined.
- Files Reviewed:
  - src/distill/prompts/extract.ts
  - tests/distill/prompts/extract.test.ts
- Test Adequacy: 6 new tests added covering rule-text presence, the anti-capture-date-anchor guardrail, the partial-continuation distinction, both unambiguous-cessation few-shots (with explicit negative assertions that no invalid_at appears in their JSON), the WRONG/RIGHT hiking counter-example, and an AtomSchema round-trip for a text-only cessation atom; all 61 tests in the file pass against the branch's actual prompt string and schema, not restated as prose.
- Risks: None in the reviewed diff. Process note (self-reported, not a defect in the reviewed change): mid-review a `git checkout fix/invalid-at-extraction-gap -- .` command was mistakenly run with a bare "." pathspec, which checked out the entire branch tree (29 files) into the working directory instead of just the 2 reviewed files. This was reverted immediately with `git checkout HEAD -- .` plus manual removal of one leftover staged file. Net unrecoverable side effect: a pre-existing uncommitted change to .claude/state/crew/workflow-state.json (a rotated crew-orchestration state file, not source code, not part of this diff) was reverted to its last-committed value; no stash or commit of its prior content existed to restore it. No reviewed source or test file was left mutated -- git status is clean of any diff against HEAD besides untracked review artifacts.
- Required Follow-up: None required for merge. Optional follow-up: the fix is prompt-only for the conversational profile; if the engineering profile is ever found to have the same dateless-cessation gap, treat it as a separate, deliberately scoped follow-up rather than silently extending this diff's rules to V3.

