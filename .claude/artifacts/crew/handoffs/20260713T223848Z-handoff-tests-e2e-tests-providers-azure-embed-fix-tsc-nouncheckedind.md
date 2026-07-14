# Task Handoff: tests/e2e + tests/providers/azure-embed: fix tsc noUncheckedIndexedAccess errors

- Created: 2026-07-13T22:38:48.908Z
- From: test-automator
- To: dispatcher
- Objective: Added 9 non-null assertions across 3 test files to satisfy tsc -p tsconfig.tests.json under noUncheckedIndexedAccess; every assertion is backed by a preceding runtime guarantee (test-level length/existence check, or a source-level invariant in AzureOpenAIEmbedProvider.embed that throws before returning a length-mismatched array). No product code touched. Zero mechanical-scope tsc errors remain for the 3 target files; only the pre-existing full-repo tsc noise (out of scope) is unaffected.
- Allowed Scope:
  - tests/e2e/plugin-flow.test.ts:159
  - 186-187
  - 194; tests/e2e/usefulness-feedback-loop.e2e.test.ts:134; tests/providers/azure-embed.test.ts:166
  - 189
  - 220
- Forbidden Scope: -
- Deliverable: plugin-flow.test.ts:159 hits[0]! (guard: hits.length>0 asserted line158); :186-187 parsed.atoms[0]! x2 (guard: atoms.length>0 asserted line185); :194 vecs[0]! (guard: vecs.length===1 asserted line193). usefulness-feedback-loop.e2e.test.ts:134 replaced array-destructure with beforeFacts[0]!/beforeFacts[1]! (guard: beforeFacts toHaveLength(2) asserted line132) — fixes downstream 135,136,153 usages for free since firstBefore/secondBefore are now non-null typed. azure-embed.test.ts:166 res[0]! (guard: source invariant AzureOpenAIEmbedProvider.embed throws if results.length!==texts.length, azure-openai.ts:143-147, texts=['x'] len1); :189 res[0]![0]! and expected0[0]! (guard: same source invariant for res[0], texts=['a','b','c'] len3, dim-check azure-openai.ts:134-138 guarantees embedding.length===dim so [0] exists; expected0 built via Array.from({length:1024},...) in makeVec so always has index 0) — this resolves BOTH the TS2532 at col14 and the separate TS2345 at col37 on the same line; :220 vecs[0]! (guard: same source invariant, texts=['integration test'] len1).
- Changed Files:
  - tests/e2e/plugin-flow.test.ts
  - tests/e2e/usefulness-feedback-loop.e2e.test.ts
  - tests/providers/azure-embed.test.ts
- Confidence: high
- Risks: None outstanding — the flagged 'special case' at azure-embed.test.ts:189 col37 was investigated and found safe to fix mechanically (not deferred): expected0=makeVec(1024,0) is built via Array.from({length:dim},...) which always produces exactly 'dim' elements, so expected0[0] is unconditionally defined, not a genuinely-optional value. No occurrences were left unfixed / no genuine bugs found. verify-1 (tsc filtered to the 3 files) returned zero lines. verify-2 (vitest run on the 3 files) is 3 files passed, 20 passed, 1 skipped (the pre-existing describe.skipIf(!process.env.INTEGRATION_LIVE) Azure live test — legitimate env-gated skip, not a disguised failure). First vitest attempt (before I ran 'bun run build') hit the known worktree false-failure documented in repo memory 'tsc --noEmit != build' (daemon-spawn e2e couldn't find unbuilt dist/cli/index.js) — resolved by running 'bun run build' (not in the forbidden list: only serve/doctor/migrate were forbidden), then rerun was fully green.
- Suggested Next Handoff: none

