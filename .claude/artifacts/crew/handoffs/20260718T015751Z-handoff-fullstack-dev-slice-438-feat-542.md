---
slice: SLICE-438
feature: FEAT-542
owner: crew:fullstack-dev
status: implementation-complete (AC-4 is an operator step, not run)
---

# Handoff: SLICE-438 (FEAT-542) — hard-fixture pack + evidence-accuracy metric

## Objective

Add >=10 new gold fixtures across 4 failure dimensions (negation,
uncertainty, status-transition, cross-chunk), a mechanical `forbidden_items`
precision penalty, and a mechanical "Evidence acc" report column to
`scripts/eval/extraction-bench/`, plus the one permitted additive `src/`
touch (daemon digest evidence field) that AC-3 requires to make Evidence-acc
real on the Ollama daemon path, not just the Azure/codex direct path.

## Scope note honored

Per dispatch: implementation only. Did not dispatch `crew:reviewer` /
`crew:verifier`. Did not touch `.github/workflows/*`, `marketplace.json`, or
deploy scripts. Did not revert or sweep the pre-existing uncommitted changes
in `scripts/eval/locomo/run.mts` / `scripts/eval/shared/spawn-daemon.ts`
(passB/atomTriage levers, present before this session) — left untouched,
confirmed via `git status` before and after.

## judge.ts — explicit scope-compliance statement (read this first)

**`lib/judge.ts` was touched. The change is a type-only additive field, not a
judge-prompt or scoring-logic change.** Full diff:

```diff
 export interface JudgeAtomIn {
   type: string;
   text: string;
+  /** FEAT-542: additive pass-through of the atom's own `evidence` excerpt... */
+  evidence?: string | null;
 }
```

That is the ENTIRE diff to this file. `JUDGE_SYSTEM_PROMPT`, `buildUserPrompt`
(which still only ever emits `(${a.type}) ${a.text}` per atom — verified by
re-reading the current source), `tryParseJudge`, `judgeFixture`, and
`judgeSelfAgreement` are byte-identical to before this slice. The new field
exists purely so `entry.atoms` (already flowing through `JudgeAtomIn[]`) can
carry an atom's `evidence` string from extraction through to
`run-bench.mts`'s mechanical evidence-accuracy check
(`lib/mechanical-checks.ts`) without inventing a second parallel data path.
The judge LLM never sees this field and is never asked to reason about it.

The actual forbidden-item / evidence-accuracy SCORING logic lives entirely
in the new `scripts/eval/extraction-bench/lib/mechanical-checks.ts` and is
invoked from `run-bench.mts` (`runModelOnce`), strictly AFTER
`judgeFixture()` returns — `applyForbiddenItemScoring` takes an
already-computed `FixtureScore` and returns an adjusted copy; it never
touches `judge.ts`'s own control flow, prompt, or schema. This matches AC-2's
explicit architect+reviewer decision ("NOT a change to judge.ts's LLM prompt
or JudgeResult schema").

## Changed files

**New:**
- `scripts/eval/extraction-bench/lib/mechanical-checks.ts` — forbidden-item matcher (`findForbiddenItemHits`, `applyForbiddenItemScoring`) + evidence-accuracy (`computeEvidenceAccuracy`, `fixtureTranscriptText`)
- `scripts/eval/extraction-bench/lib/mechanical-checks.test.ts` — unit tests incl. AC-6 adversarial substring case
- `scripts/eval/extraction-bench/lib/fixtures.test.ts` — AC-1 fixture-count/schema/tag tests
- `scripts/eval/extraction-bench/fixtures/fx46..fx57*.json` — 12 new gold fixtures (3 each: negation, uncertainty, status-transition, cross-chunk)

**Modified:**
- `src/server/queries/provenance.ts` — `DigestMemRow` additively gains `evidence: string | null`; SQL now selects `evidence`. The one permitted `src/` touch (AC-3).
- `scripts/eval/extraction-bench/lib/daemon-runner.ts` — `DaemonAtom`/`DigestBody` additively carry `evidence?: string | null`
- `scripts/eval/extraction-bench/lib/judge.ts` — `JudgeAtomIn` additively carries `evidence?: string | null` (see explicit statement above)
- `scripts/eval/extraction-bench/lib/fixtures.ts` — `GoldFixture` additively gains `forbidden_items?: string[]` + loader validation
- `scripts/eval/extraction-bench/lib/report.ts` — `FixtureReportRow`/`RunAggregate` gain `forbiddenItemHits(Total)`/`evidenceAcc(Numerator/Denominator)`; `aggregateFixtureScores` pools them; `combineRuns` sums raw counts across runs (not mean-of-percentages); `renderMarkdown` adds an "Evidence acc" column after "Type acc" (tail column order for Pass A/B atoms unchanged, so pre-existing suffix-anchored tests still hold)
- `scripts/eval/extraction-bench/lib/report.test.ts` — extended: pooled evidence-acc aggregation, multi-run combine, forbidden-hit summing, new-column rendering
- `scripts/eval/extraction-bench/run-bench.mts` — threads `evidence` through all 3 atom-mapping call sites (direct/nuextract/daemon); computes forbidden-item hits + evidence accuracy per fixture in `runModelOnce`; writes `results/<run>/summary.json` (AC-7)
- `scripts/eval/extraction-bench/README.md` — fixture count 42→55, 4 new difficulty rows with 1 example each, `forbidden_items` semantics section, "Evidence accuracy (FEAT-542)" section cross-referencing AC-3, updated stale "daemon atoms carry only `{id,type,text}`" limitation bullet

## AC-by-AC evidence

- **[CHECKPOINT] AC-1: pass** — `lib/fixtures.test.ts` asserts `loadFixtures().length >= 53` (actual: 55) and >=2 fixtures per new difficulty tag (actual: 3 each). README category table updated with all 4 new tags + 1 example each. Verified: `npx vitest run scripts/eval/extraction-bench/lib/fixtures.test.ts` → 4/4 pass.
- **[CHECKPOINT] AC-2: pass** — `findForbiddenItemHits`/`applyForbiddenItemScoring` in `lib/mechanical-checks.ts` run entirely post-judge, never touch `judge.ts`'s prompt/schema (see explicit statement above). `applyForbiddenItemScoring` test proves a forbidden-item hit reduces `FixtureScore.precision` independent of the judge's own junk verdict. Verified: `lib/mechanical-checks.test.ts` `applyForbiddenItemScoring` block, 3/3 pass.
- **[CHECKPOINT] AC-3: pass** — `DigestMemRow`/digest route additively expose `evidence: string | null` (`src/server/queries/provenance.ts`); `daemon-runner.ts`'s `DaemonAtom` reads it; `report.ts`'s "Evidence acc" column computes pooled numerator/denominator, excluding no-evidence atoms from the denominator (not a failure). Verified THREE ways: (1) `bun run build` clean, (2) end-to-end smoke script (`buildSessionDigest` against a real in-memory SQLite DB with a migrated schema) confirmed a memory row with `evidence: 'The reinstall step threw Access is denied.'` round-trips through the digest exactly, and a no-evidence row returns `evidence: null` (not omitted) — script deleted after use, (3) `mechanical-checks.test.ts`'s `computeEvidenceAccuracy` describe block, 3/3 pass, including the exclude-from-denominator case.
- **[CHECKPOINT] AC-4: skip (operator step, by design)** — Per dispatch instruction, did NOT run the full paid `--runs 3` qwen2.5:7b/qwen3.5:9b re-baseline. Smoke-verified the underlying machinery instead: typecheck clean end-to-end (`run-bench.mts` imports/wires `mechanical-checks.ts` without error) and the digest evidence round-trip above proves the daemon path will carry real evidence into a live run. Did not spin an actual Ollama daemon (GPU may be shared with other running evals per dispatch caution) — that live sweep remains the operator's next step.
- **[CHECKPOINT] AC-5: pass** — README.md updated: fixture-count language, 4 new difficulty rows each with one named example fixture, a full `forbidden_items` semantics section (including the bare-phrase/dominance-ratio rule), and an "Evidence accuracy (FEAT-542)" section that cross-references this same mechanical definition. "Adding a gold transcript" section also updated with the optional `forbidden_items` field.
- **[CHECKPOINT] AC-6: pass** — `fx53-status-transition-release-date-moved.json` is exactly this adversarial shape (forbidden item is the superseded Friday date; a later, legitimately-different atom mentions Friday again for the *following* release's normal slot) and doesn't false-trigger, because `findForbiddenItemHits` requires a bare/short (<3-word) forbidden phrase to dominate (>=60% of normalized length) the atom's own text, not just appear as a substring. Directly pinned in `mechanical-checks.test.ts`: `'AC-6: a bare short forbidden phrase ("Friday") does NOT false-positive...'` and its paired positive-control test (`'still matches when it dominates a short atom'`). Verified: both tests pass.
- **[CHECKPOINT] AC-7: pass** — `run-bench.mts`'s `main()` writes `results/<run>/summary.json` after every model (same crash-safety pattern as `results.json`/`report.md`) with `{model, forbiddenItemHitsTotal, evidenceAccNumerator, evidenceAccDenominator, evidenceAcc}` per model. `report.ts`'s `RunAggregate` carries the raw numerator/denominator (not just the pooled percentage) precisely so this artifact has real sample-size inputs, not just the final number. Verified via `report.test.ts`'s pooling/combine tests (raw counts propagate correctly through both single- and multi-run paths).

## Final verification commands run (fresh, this pass)

```
bun run build                              # clean, 0 errors
npx tsc -p tsconfig.eval.json               # clean, 0 errors
bun run typecheck:tests                     # clean, 0 errors
npx vitest run scripts/eval/extraction-bench/lib/report.test.ts \
  scripts/eval/extraction-bench/lib/mechanical-checks.test.ts \
  scripts/eval/extraction-bench/lib/fixtures.test.ts \
  tests/mcp/why-digest-conformance.test.ts
  # -> 4 test files, 41 tests, all PASS
```

Also ran (broader digest-adjacent regression check, not required by Done-when
but touched provenance.ts so checked anyway):
```
npx vitest run tests/mcp/server.test.ts tests/smoke/smoke.test.ts \
  tests/mcp/entity-relations-conformance.test.ts tests/recall/pack.test.ts
  # -> 3/4 files clean; tests/mcp/server.test.ts has 2 PRE-EXISTING failures
  #    unrelated to this slice (see Risks below) — 82/84 passed in that file.
```

Temp smoke script (`.tmp-smoke-evidence.mts`, repo root, used to prove the
digest evidence round-trip against compiled `dist/`) was deleted after use —
confirmed via `git status --short` showing no stray file.

## Confidence

High on AC-1/2/3/5/6/7 (all mechanically verified, not just typechecked).
Medium-high on AC-4 by design — it is explicitly an operator step per
dispatch, not something this slice was asked to run.

## Risks / follow-ups

- **Pre-existing, unrelated test failures observed in `tests/mcp/server.test.ts`**: `list + resolve consolidation proposals roundtrip over MCP` and `resolve_consolidation_proposals_batch drains a knn-mode-produced queue across repeated capped calls` both fail (`expected [] to have a length of N but got +0`). These tests exercise KNN-mode consolidation-proposal generation — a module this slice never touched (no edits to `src/consolidate/**`, `src/search/**`, or embedding code). Not introduced by this change; flagged for the parent loop to triage separately, not something this slice should absorb.
- AC-4's live `--runs 3` re-baseline against `qwen2.5:7b`/`qwen3.5:9b` (43 old + 12 new fixtures) is still outstanding — that's the operator's next action, not a defect in this slice's implementation.
- `forbidden_items` bare-phrase dominance threshold (60%, <3 words) is a judgment call, not derived from the FEAT text verbatim — documented inline in `mechanical-checks.ts` and README; worth a second look if a real bench run produces an unexpected forbidden-item false-positive/negative on a new fixture author's phrasing.
- Pre-existing uncommitted changes in `scripts/eval/locomo/run.mts` and `scripts/eval/shared/spawn-daemon.ts` (passB/atomTriage levers) were left completely untouched, per dispatch instruction — still present in the working tree, not part of this slice's diff.
