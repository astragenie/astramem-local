---
findings: "🔴:0,🟡:2,❓:1"
status: completed
decision: approved_with_notes
author_id: fullstack-dev
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-19T15:23:48.040Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: escapeFtsQuery OR-join fix is correct, narrowly scoped, and regression-free (396 tests green); merge it, but FEAT-480's own AC-2/AC-3/AC-4 (real-data MRR harness, hit-source breakdown, weight sweep) are unmet and the ADR-005 fixture floor is much weaker evidence than it looks.
- Evidence Checked:
  - FEAT-480 FTS OR-join fix — correctness/regression review of `escapeFtsQuery()` (src/search/search.ts) on top of 8364ff2
  - vs main.

VERDICT: approved_with_notes (merge the code change; do NOT close FEAT-480 or treat this as production-validated retrieval quality work — real-data AC-2 is still required and is currently missing).

## 1. Does the fix work
  - and is the eval floor meaningful evidence?

The fix itself is correct and narrowly scoped: `escapeFtsQuery` (search.ts:419-433) now OR-joins non-stopword tokens
  - falls back to the old AND-of-all-tokens when every token is a stopword (avoids FTS5 throwing on an empty MATCH string)
  - and caps at FTS_MAX_OR_TOKENS=12. Verified directly: on `main`
  - `search('FTS5 negation escaping hyphenated query'
  - {}
  - 10
  - {mode:'keyword'
  - ...})` against a single-atom DB returns `[]` (zero FTS candidates) — reproduces the claimed defect exactly. New unit tests (tests/search/fts-or-join.test.ts) pin partial multi-word match recovery
  - the all-stopword fallback
  - single-token no-op
  - and operator-char sanitization (hyphen/quote/leading-dash) under the new join — all pass
  - and I ran the wider tests/search + tests/server/search.test.ts + tests/mcp suite (396 tests) with no regressions.

However
  - the ADR-005 fixture eval (tests/eval/retrieval-eval.test.ts) is weaker evidence than the handoff implies:
- `src/eval/harness.ts` (its own doc comment
  - lines 8-11
  - and `runRetrievalEval` at line 169) **never passes `mode` into `search()`** — every query
  - including the ones the fixture labels `keyword` (q3/q5/q7/q8)
  - silently runs full `hybrid` mode. The vec leg (fake embedder) is always active even for "FTS-only" test queries.
- The corpus has only 11 atoms vs k=10
  - so recall@10 is structurally close to 1.0 regardless of which leg finds what. I measured this directly: I ran the same eval on `main` (pre-fix
  - via a scratch worktree) and got **mean recall@10 = 0.955 — byte-identical to this branch's 0.955**. Recall did not move at all.
- NDCG@10 DID move (0.840 → 0.959 mean; q1 0.387→1.000
  - q5 0.301→1.000)
  - and that movement is real and attributable to this fix — it is legitimate evidence the change isn't obviously harmful and does what it claims on this fixture. But it's a hand-authored 11-atom corpus with hash-derived fake vectors
  - not the real-data harness the FEAT spec names.

None of this is a defect introduced by this PR (the mode-is-advisory gap is a pre-existing
  - documented harness limitation) — but it means "the ADR-005 floor stayed green" is much weaker proof of retrieval-quality improvement than the phrase suggests
  - and should not be cited as validating AC-2.

## 2. Behavioral compatibility

No caller regression found. Grepped every `search()`/`escapeFtsQuery` consumer (src/mcp/server.ts
  - src/server/app.ts
  - src/eval/harness.ts
  - src/contracts/wire-hit.ts) — all pass through `search()` unchanged; `mode` gating (`gatherCandidates`
  - search.ts:648-697) is untouched
  - so `mode:'keyword'`/`'semantic'`/`'hybrid'` selection logic is identical to before. `tests/server/search.test.ts`'s mode-differentiation test (wombat husbandry / capybara grooming
  - lines 766-816) still passes because both query tokens are present in the fixture text either way. Ran the full tests/search + tests/server/search.test.ts + tests/mcp suite: 26 files / 396 tests
  - all green.

## 3. Stopword-list safety

Checked the "the WHO" case explicitly: both "the" and "who" are in FTS_STOPWORDS (search.ts:364-374
  - "who" is listed alongside the interrogatives). A query of only those two tokens hits the all-stopword branch and falls back to the pre-existing AND-of-all-tokens behavior — i.e. byte-identical to current production behavior
  - not a regression. Single-stopword queries ("who" alone) behave the same way. Genuine content tokens that happen to collide with the list only when they appear as an *exact
  - standalone* lowercased token (e.g. "this" in "this binding arrow function") lose OR-membership but are not blocked from matching via the other tokens — a minor
  - disclosed
  - low-risk trade-off (the doc comment at search.ts:355-363 correctly frames this as deliberately narrow). No case found where stripping silently returns wrong/harmful results instead of just slightly less recall on that one token.

## 4. Is a real-data A/B still required
  - and do the unit tests substitute?

Read the full FEAT-480 spec (.claude/artifacts/loop/backlog/pending/FEAT-480.md). It defines five ACs:
- AC-1 (FTS leg returns non-zero hits) — DONE
  - proven by the new unit tests.
- AC-2 (measured against `scripts/eval/recall-quality/run.mjs`
  - plain-English MRR must not regress from baseline 0.637) — **NOT done in this slice.** I confirmed `scripts/eval/recall-quality/run.mjs` exists on disk and was not invoked.
- AC-3 (before/after fts/vec/both hit-source breakdown reported) — **NOT done.**
- AC-4 (fusion weights re-swept against the harness
  - not left as a stale guess) — **NOT done
  - not attempted.**
- AC-5 (short/exact literal-keyword queries still work) — only unit-tested for a trivial single-token case and an operator-sanitization case
  - not against the real "2-4 word bag of the memory's own vocabulary" pattern the spec explicitly calls out as the thing that must not regress (its own 0.750 ceiling).

The spec's own language is unusually explicit about this: *"This FEAT establishes that the leg is dead. It does NOT establish that reviving it will improve recall... All three [helps/no-op/hurts] are live possibilities. Measure before believing."* and *"A fix that leaves fts:0 has not fixed anything"* (AC-3). Given that
  - unit tests proving the mechanism now works are necessary but explicitly insufficient per the FEAT's own bar — the real A/B is still required before FEAT-480 can be considered closed or before this ranking-behavior change should be treated as production-quality-validated.

To the builder's credit
  - the handoff (.claude/artifacts/crew/handoffs/20260719T151300Z-handoff-feat-480-fts-or-join-fix.md) does NOT overclaim: it explicitly states the LoCoMo/real A/B is deferred
  - lists it under "Risks/open questions
  - " and names it as the "Suggested next handoff." It does not misrepresent the ADR-005 green floor as proof of quality gain. That honesty is why this is approved_with_notes rather than rejected.

## Recommendation

Merge this as a scoped
  - reversible
  - well-tested slice-1 fix — it is low-risk (single function
  - no fusion-weight change
  - no caller-visible contract change
  - full test suite green
  - mechanism independently reproduced). But:
1. Do NOT mark FEAT-480 "done"/closed — AC-2/AC-3/AC-4 remain open and are the actual quality gate.
2. Before this ships to real users as "the retrieval fix
  - " run `scripts/eval/recall-quality/run.mjs` against the real store per AC-2
  - and report the fts/vec/both breakdown per AC-3
  - per the FEAT's own explicit "measure before believing" mandate.
3. If the real-data run shows the OR-join hurts plain-English or literal-keyword MRR
  - the fallback per the spec is dropping `alpha` toward 0
  - not reverting this mechanism.
- Files Reviewed:
  - src/search/search.ts
  - tests/search/fts-or-join.test.ts
  - src/eval/harness.ts
  - tests/eval/retrieval-eval.test.ts
  - .claude/artifacts/loop/backlog/pending/FEAT-480.md
  - .claude/artifacts/crew/handoffs/20260719T151300Z-handoff-feat-480-fts-or-join-fix.md
- Test Adequacy: New fts-or-join.test.ts (4 cases: partial OR match, all-stopword AND fallback, single-token no-op, operator-char sanitization) all pass; full tests/search+tests/server/search.test.ts+tests/mcp (396 tests/26 files) green; ADR-005 recall@10 floor unchanged pre/post-fix (0.955 both, confirmed by running eval on main via scratch worktree) but NDCG@10 improved 0.840->0.959, real and attributable to this fix but on an 11-atom fixture corpus, not the real-data harness AC-2 names.
- Author: fullstack-dev
- Judge: crew:reviewer
- Risks: FEAT-480 AC-2/AC-3/AC-4 (real recall-quality harness MRR check, fts/vec/both breakdown, fusion-weight sweep) are unmet; ADR-005 eval harness ignores per-query mode entirely (src/eval/harness.ts, pre-existing gap) and its corpus (11 atoms) is smaller than k=10, so its recall@10 floor cannot detect this class of regression at all -- NDCG@10 did move and is real signal, but is not a substitute for the FEAT's own real-data gate.
- Required Follow-up: Run scripts/eval/recall-quality/run.mjs against the real store per AC-2 before closing FEAT-480 or treating this as validated retrieval-quality work; report fts/vec/both breakdown per AC-3; sweep alpha/beta per AC-4. Code itself is safe to merge now.

