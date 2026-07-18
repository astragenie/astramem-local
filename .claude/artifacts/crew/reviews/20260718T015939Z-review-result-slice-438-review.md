---
findings: "🔴:0,🟡:0,❓:1"
status: completed
decision: approved
author_id: crew:fullstack-dev
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-18T02:06:27.054Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: ## SLICE-438 (FEAT-542) hard-fixture pack + evidence-accuracy - review result

review_decision: PASS

### Scope verified
Diff read in full for: src/server/queries/provenance.ts, scripts/eval/extraction-bench run-bench.mts, README.md, and lib/fixtures.ts, judge.ts, daemon-runner.ts, report.ts, report.test.ts, mechanical-checks.ts, mechanical-checks.test.ts, fixtures.test.ts, plus all 12 new fixtures fx46 through fx57 (5 read in full: fx46 negation, fx49 uncertainty, fx52 status-transition, fx53 adversarial, fx55 cross-chunk).

### Focus 1 - judge.ts discipline (AC-2): CONFIRMED
Entire diff to judge.ts is the single additive evidence field (optional, string or null) on JudgeAtomIn plus its doc comment. Grepped the file for every other evidence occurrence; the only other hit is an unrelated pre-existing comment about triage-note F1 variance. buildUserPrompt, tryParseJudge, judgeFixture, judgeSelfAgreement are untouched. All forbidden-item and evidence-accuracy logic lives in the new mechanical-checks.ts, invoked from run-bench.mts strictly after judgeFixture returns. applyForbiddenItemScoring takes an already-computed FixtureScore. Matches the AC-2 architect-plus-reviewer decision.

### Focus 2 - fixture gold quality: PASS
5 of 12 new fixtures spot-checked (fx46, fx49, fx52, fx53, fx55) plus the fx53 adversarial shape specifically. All semantically sound:
- fx46 (negation): gold atom correctly preserves the NOT-using-Redis fact; forbidden_items are the positive-polarity restatements.
- fx49 (uncertainty): gold atom correctly frames DNS as a ruled-out hypothesis, cert expiry as logs-confirmed; forbidden_items block the DNS-confirmed false claim.
- fx52 (status-transition): gold captures latest state (RUNNING) as current plus a history atom; forbidden_items are the superseded blocked claims.
- fx53 (AC-6 adversarial): forbidden_items are full sentences (The v3 release is scheduled for Friday / v3 release is set for this Friday), not the bare word Friday, correctly avoiding collision with the legitimate second gold atom that also mentions Friday for the following release.
- fx55 (cross-chunk): owner, task, and deadline spread across turns with noise plus a late correction; gold atom captures the corrected deadline; forbidden_items are the superseded deadline.

### Focus 3 - mechanical-checks.ts correctness: PASS
- findForbiddenItemHits normalizes text (lowercase, collapse whitespace, strip light punctuation), then requires full containment; for forbidden items under 3 words it additionally requires the phrase to be at least 60 percent of the atom own normalized length (dominance ratio) - exactly what prevents the Friday substring trap from AC-6. Verified via mechanical-checks.test.ts dedicated bare-phrase-does-not-trigger and bare-phrase-does-trigger-when-dominant pair, both passing.
- applyForbiddenItemScoring recomputes precision from the union of judge-flagged-junk indices and forbidden-item-hit indices, so an atom is never double counted; it returns the same object reference when there are no forbidden_items (the majority case, no extra allocation). Tests cover the no-op passthrough, a judge-missed hit being penalized, and no double counting when the judge already flagged the same atom junk.
- computeEvidenceAccuracy excludes atoms with no or blank evidence from the denominator entirely, matching AC-3 exactly (never counted as a failure). Whitespace-only normalization (no lowercasing or punctuation stripping) is a deliberate choice so a fabricated-but-similar quote does not count as real evidence; the test suite proves this distinction directly (tolerates a whitespace difference, rejects a fabricated quote).

### Focus 4 - report.ts and FEAT-450 multi-run combine: PASS
aggregateFixtureScores sums forbidden-item hits and pools evidenceAcc as sum of numerators over sum of denominators, not mean of percentages - the correct choice, avoiding skew from fixtures with tiny denominators, consistent with FEAT-450 own noise-floor discipline. combineRuns re-derives the same pooled fraction across runs by re-summing the per-run aggregates raw numerator and denominator rather than averaging per-run percentages - mathematically sound. renderMarkdown new Evidence-acc column is inserted between Type-acc and Over-extract; the tail column order (Over-extract through Pass-B atoms) is unchanged, so pre-existing suffix-anchored assertions still hold. The legacy single-run shape (runs equal 1) is preserved, aggregate fields default to 0 or null when absent and render as an em-dash.

### Focus 5 - digest-wire additive check: PASS, with one nit
DigestMemRow.evidence is typed as required-but-nullable (string or null), not optional as AC-3 prose literally states - a minor deviation from the spec exact wording. Functionally this is fine and arguably safer: the only place that constructs a DigestMemRow is the SQL-row type assertion inside buildSessionDigest (src/server/queries/provenance.ts line 158, now selecting id, type, text, evidence), so no other call site breaks; bun run build is clean. Grepped all consumers (mcp/server.ts, server/routes/digest.ts) - both just pass the whole object through unaffected by the added field. null (not omitted) is used consistently between the route and daemon-runner.ts DaemonAtom and DigestBody types. LOW severity, no fix required.

### Focus 6 - re-run verification (fresh, this review)
All run with ASTRA_SKIP_CONSOLIDATE explicitly unset:
- bun run build - clean, 0 errors.
- npx tsc -p tsconfig.eval.json - clean, 0 errors.
- bun run typecheck:tests - clean, 0 errors.
- npx vitest run of the report, mechanical-checks, and fixtures test files under scripts/eval/extraction-bench/lib - 3 files, 36 tests, all pass.
- npx vitest run tests/mcp/server.test.ts (full file) - 55 of 55 pass, including both KNN-consolidation tests the handoff flagged as pre-existing failures. Finding: those 2 tests are NOT actually broken - with the env var unset they pass. The handoff Risks section attributes them to a pre-existing, unrelated bug; the real cause was a leftover ASTRA_SKIP_CONSOLIDATE shell var in whatever session ran them, exactly as this dispatch suspected. This is a documentation-accuracy gap in the handoff (would have sent a future triage cycle chasing a phantom bug), not a code defect - MEDIUM note, does not block approval since the underlying code has zero real regressions.
- npx vitest run of the why-digest-conformance, smoke, entity-relations-conformance, and recall pack test files - 34 of 34 pass (the smoke test doctor-FAILED lines are expected environmental warnings for budget, encryption, and plugin-config, unrelated to this diff and already present before this change).

### Out-of-scope contamination check
Confirmed uncommitted src/distill/stages/05-extract.ts (maxTokens 4000 to 6000, dual-pass no-compaction tuning) is present in the tree but is NOT part of this slice diff (not mentioned in the handoff changed-files list, not touched by any FEAT-542 acceptance criterion) - same class as the locomo and spawn-daemon pre-existing-experiment changes the dispatch already called out, just not named in that list. It coexists cleanly (build, typecheck, and tests all green with it present). Process note: the handoff CAUTION list should have named this file too for completeness, but it does not affect this slice correctness.

### AC coverage
AC-1 pass (55 fixtures, 2 or more per new tag, schema-valid, README table updated); AC-2 pass; AC-3 pass (evidence wired additively end to end, verified by fresh build, typecheck, and tests); AC-4 correctly skipped as an operator step; AC-5 pass (README reviewed, documents all 4 tags plus forbidden_items semantics plus the evidence-acc cross-reference); AC-6 pass (adversarial fx53 plus matcher dominance-ratio logic verified); AC-7 pass (summary.json shape confirmed in the run-bench.mts diff, raw counts not just percentages).

### Confidence
High - full diff read for every changed and new file in scope, all new fixtures difficulty categories spot-checked (5 of 12, one per category plus the adversarial), all specified verification commands re-run fresh with the correct environment and independently confirmed, wire-consumer grep performed for the one src touch.
- Evidence Checked:
  - bun run build clean; npx tsc -p tsconfig.eval.json clean; bun run typecheck:tests clean; vitest report/mechanical-checks/fixtures.test.ts 36/36 pass; vitest tests/mcp/server.test.ts full file 55/55 pass with ASTRA_SKIP_CONSOLIDATE unset (both flagged KNN tests pass -- handoff risk was a phantom env-var artifact); vitest why-digest-conformance+smoke+entity-relations+recall-pack 34/34 pass; judge.ts diff confirmed additive-only via full read + grep
- Files Reviewed:
  - src/server/queries/provenance.ts
  - scripts/eval/extraction-bench/{run-bench.mts
  - README.md
  - lib/fixtures.ts
  - lib/judge.ts
  - lib/daemon-runner.ts
  - lib/report.ts
  - lib/report.test.ts
  - lib/mechanical-checks.ts
  - lib/mechanical-checks.test.ts
  - lib/fixtures.test.ts}
  - fixtures/fx46-fx57.json (12 new)
- Test Adequacy: 36 new/updated unit tests (report, mechanical-checks, fixtures) all pass; re-ran full tests/mcp/server.test.ts (55/55) and 3 adjacent digest/smoke/recall suites (34/34) fresh with correct env, confirming zero regressions and that the handoff's 2 flagged KNN failures do not actually exist
- Author: crew:fullstack-dev
- Judge: crew:reviewer
- Risks: LOW: DigestMemRow.evidence typed required-but-nullable instead of optional per AC-3's literal prose -- functionally safe, only constructor is the SQL-row cast, build is clean. MEDIUM (process, not code): handoff's Risks section misattributed 2 KNN test failures to a pre-existing unrelated bug; re-run with ASTRA_SKIP_CONSOLIDATE unset shows both pass -- was a leftover shell var, not a real issue; worth correcting so it does not waste a future triage cycle. Unrelated uncommitted src/distill/stages/05-extract.ts maxTokens change coexists cleanly but was not named in the handoff's caution list.
- Required Follow-up: none blocking; optionally correct the handoff's KNN-failure note for the record

