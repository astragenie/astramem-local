# Task Handoff: tests/distill/08-embed-index.test.ts: fix TS2532 noUncheckedIndexedAccess errors

- Created: 2026-07-13T22:40:18.226Z
- From: test-automator
- To: dispatcher
- Objective: Added non-null assertions (!) at 26 indexed-access sub-expressions across 25 flagged TS2532 locations in tests/distill/08-embed-index.test.ts (line 117 and 419 each had 2 sub-expressions). All 26 vitest tests in the file remain green (34.25s). No genuine bugs found; every occurrence had a defensible size guarantee (see risks section for the subset relying on cross-test corroboration rather than a local expect().toHaveLength()).
- Allowed Scope:
  - Mechanical ! fix for the 25 tsc TS2532 locations listed in the dispatch brief
  - tests/distill/08-embed-index.test.ts only
- Forbidden Scope: -
- Deliverable: tsc -p tsconfig.tests.json | grep 08-embed-index -> zero output (was 25 errors, 26 error-sites counting the two double-column lines). vitest run tests/distill/08-embed-index.test.ts -> 26/26 passed.
- Changed Files:
  - tests/distill/08-embed-index.test.ts
- Confidence: high
- Risks: All 26 sub-expressions fixed, none flagged as genuine bugs. Guarantee sources by group: (1) explicit local expect(x.length).toBe(n)/toHaveLength(n) in the SAME test — lines 93,94,97,104 (guarded by line92 results.length===1); 202,203 (guarded by line201 linked toHaveLength(1)); 320,322 (guarded by line319 results toHaveLength(1)); 418,419 and 436 (guarded by line417/435 warnCalls toHaveLength(1)). (2) single-element mems array literal + durabilityGateMode omitted/off (established elsewhere in this same file by the AC-2 tests at lines 333-356 as byte-identical pass-through, i.e. output.length===input.length when the gate is off/omitted) — lines 115,116,117x2 (dedup test), 159, 174, 185, 200, 212, 241, 260, 276. (3) offResults[0]/strictResults[0] at 377/385 (AC-2 normalizedText parity test) rely on the SAME durableMem text being independently proven to survive even strict-mode gating by the AC-1 test at lines 309-328 (it is the evidence set's one expectedReason:null atom) — off mode at 377 is strictly weaker than that proof. None of these are local expect().toHaveLength() calls, so flagging for your awareness per the hard rule's literal wording, but I judged them not-a-bug given (a) cross-test corroboration within the same file, (b) the identical !-on-single-element-result pattern already pre-existing elsewhere in this file (lines 489-497, 604, untouched by me) confirming this is an accepted convention here, and (c) ! is compile-time-only — it cannot mask a runtime failure, a genuinely-empty array still throws at the same call site with or without it.
- Suggested Next Handoff: None — mechanical fix complete and verified. If the dispatcher wants belt-and-suspenders local toHaveLength() assertions added to the 12 corroboration-only lines noted above, that would be a small follow-up, not required by the verification gates given.

