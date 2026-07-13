# Task Handoff: tests/distill/05-extract.test.ts: fix TS2532 noUncheckedIndexedAccess errors

- Created: 2026-07-13T22:42:30.628Z
- From: test-automator
- To: dispatcher
- Objective: Added ~39 non-null (!) assertions at indexed-access sites (result.atoms[i]!., results[i]!., entities?.[0]!.) each backed by a preceding expect(...atoms.length).toBe(N)/toHaveLength(N) in the same test. tsc -p tsconfig.tests.json for this file went from 48 TS2532 errors to 7, all deliberately left unfixed per the hard rule (see risks). vitest run: 57/57 passed, 3.13s, zero regressions.
- Allowed Scope:
  - tests/distill/05-extract.test.ts only
  - lines flagged by tsc TS2532 in the dispatch brief (original list of 48 occurrences
  - re-verified against current line numbers before editing). Did not touch lines 46-55 (makeMockLLM
  - already fixed by requester). Did not touch tsconfig
  - src/
  - or run tsc against the full repo.
- Forbidden Scope: -
- Deliverable: 37 edits across the file adding non-null assertions at: 74-75,121-122,191-192,228-229/238-239,264-265,289-290,340-341,368-370(x2 double-assert),399-400,411-413,442-444,469-470,494-495,523-524,550-551,584-585,670-671,704-705,726-727,748-749,770-771,795-796,815-816,838-839,863-864,894-895/900,1427-1429. Verification: 'bunx tsc -p tsconfig.tests.json 2>&1 | grep 05-extract' now shows exactly 7 remaining errors (all deliberately unfixed, see risks); 'bunx vitest run tests/distill/05-extract.test.ts' -> 57 passed, 0 failed.
- Changed Files:
  - tests/distill/05-extract.test.ts
- Confidence: high
- Risks: 7 TS2532 occurrences intentionally left UNFIXED because no preceding length assertion in the same test guarantees the array index exists, per the dispatch's hard rule (do not add ! without proof). All 7 are in the 'sessionDateIso temporal grounding' describe block (lines 1315, 1328, 1341, 1354, 1374, 1375) plus one in 'entityDropCounts tallies one entry per drop reason' (line 931) — none of these tests contain an expect(result.atoms.length)/toHaveLength assertion before indexing result.atoms[0], unlike every sibling test in the file. Runtime behavior is fine (mock LLMs always return exactly 1 atom in these cases, and vitest is green), but the type-level guarantee is genuinely absent — recommend adding an explicit 'expect(result.atoms.length).toBe(1);' (or toHaveLength) line before each flagged access in a follow-up, which would let the ! pattern apply cleanly. Full tsc run for the whole repo (tsconfig.tests.json across all test files) was NOT run — only this file was checked, per scope restriction.
- Suggested Next Handoff: Follow-up fix (same file, same pattern, needs one new line + one ! per occurrence): add explicit atoms.length/toHaveLength guard before lines 931, 1315, 1328, 1341, 1354, 1374-1375, then add ! at each. Separately, the repo's tsconfig.tests.json typecheck has never run in CI (per dispatch context) — other test files besides this one likely have their own TS2532/etc. backlog worth a follow-up dispatch.

