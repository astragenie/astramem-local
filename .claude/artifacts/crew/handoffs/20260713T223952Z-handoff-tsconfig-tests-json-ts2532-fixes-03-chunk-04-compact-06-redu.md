# Task Handoff: tsconfig.tests.json TS2532 fixes (03-chunk, 04-compact, 06-reduce, contract-suite, fuse) — 9 occurrences flagged unfixed

- Created: 2026-07-13T22:39:52.978Z
- From: test-automator
- To: dispatcher
- Objective: Added 14 non-null assertions across 5 files where a preceding length/count assertion or loop-bound in the same test block provably guaranteed array occupancy. Left 9 TS2532 occurrences across 3 files unfixed (06-reduce.test.ts x2, 07-memory-normalize.test.ts x5, ollama-embed.test.ts x2) — no qualifying preceding assertion exists in-test; verified via source read that both underlying implementations (memoryNormalize's .map(), OllamaEmbedProvider.embed()'s per-text push loop) are strictly 1:1, so these are NOT product bugs, but the test itself proves nothing per the dispatch's hard rule. Full 6-file target vitest run: 80 passed, 1 skipped (pre-existing INTEGRATION_LIVE gate), 0 failed.
- Allowed Scope:
  - Mechanical ! fixes per dispatch brief across tests/distill/03-chunk.test.ts
  - 04-compact.test.ts
  - 06-reduce.test.ts
  - tests/providers/_contract-suite.ts
  - tests/search/fuse.test.ts. NOT touched: 07-memory-normalize.test.ts (0 of 5 fixed
  - all flagged)
  - ollama-embed.test.ts (0 of 2 fixed
  - both flagged) — no product code touched
  - no tsconfig touched.
- Forbidden Scope: -
- Deliverable: 03-chunk.test.ts: L15,22,23,50,66 fixed. 04-compact.test.ts: L94,95 fixed. 06-reduce.test.ts: L28,39,71,72 fixed; L45,46 flagged unfixed. _contract-suite.ts: L87 fixed. fuse.test.ts: L229,230 fixed. 07-memory-normalize.test.ts: L83,93(x2),100,101 flagged unfixed (0 fixed). ollama-embed.test.ts: L148,186 flagged unfixed (0 fixed).
- Changed Files:
  - tests/distill/03-chunk.test.ts
  - tests/distill/04-compact.test.ts
  - tests/distill/06-reduce.test.ts
  - tests/providers/_contract-suite.ts
  - tests/search/fuse.test.ts
- Confidence: high
- Risks: tsc -p tsconfig.tests.json still reports 9 TS2532 errors: 06-reduce.test.ts(45,19)(46,12), 07-memory-normalize.test.ts(83,12)(93,12)(93,34)(100,12)(101,12), ollama-embed.test.ts(148,14)(186,14) — left unfixed per dispatch hard rule since no preceding assertion in the same it() block proves array occupancy (see full explanation in final response). Recommend adding one explicit expect(result.length).toBe(N) / expect(res).toHaveLength(N) line per affected it() block, which both satisfies tsc and hardens the test against a future non-1:1 change to reduce/memoryNormalize/embed.
- Suggested Next Handoff: Dispatcher decides: (a) approve adding the missing length/toHaveLength assertions (then ! becomes mechanically justified and I can apply it), or (b) accept a documented targeted tsc allowlist for these 9 lines, or (c) route to qa-expert if a stricter invariant is wanted. Full typecheck:tests still not CI-wired — that remains out of this dispatch's scope.

