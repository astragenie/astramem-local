# FEAT-483 SLICE-6: config-defaults-vs-docs consistency test — DONE

- **Status**: DONE
- **Owner**: crew:fullstack-dev
- **Branch**: `feat/483-s6-config-vs-docs`
- **PR**: https://github.com/astragenie/astramem-local/pull/445

## Objective
Build a test that catches the "docs say X, code defaults to Y" drift class —
the exact bug where CLAUDE.md/doc-comments claimed contradiction detection
ships OFF while `defaultConfig()` actually shipped it `enabled` (the FEAT-482
incident class).

## Deliverable
`tests/config/defaults-vs-docs.test.ts` — a curated table of
`{ configPath, documentedDefault, actualDefault, docSource }` rows, hand-
verified against the live source at write time, asserted with
`it.each(cases)`. Covers:

- `consolidation.contradictionDetection.mode/maxPerRun/maxWallClockMs`
  (the FEAT-482 incident key — explicitly distinguishes the shipped default
  from the `DEFAULT_CONTRADICTION_DETECTION` governance-fallback constant)
- `consolidation.candidateSelection`/`knnK`/`maxCandidatePairsPerRun`/`autoAcceptThreshold`/`dupJudge.mode`
- `distill.atomTriage.mode/maxPerRun/maxWallClockMs`, `distill.gatekeeper.mode`,
  `distill.extractionPasses`, `distill.durabilityGate`, `distill.typeHints`
- `sync.batchSize`, `embedding.provider`, `llm.compaction.provider/model`
- `ollama.ts` exported `NUM_CTX_FLOOR`/`NUM_CTX_CAP` constants
- The four per-stage LLM sampling temperatures (04-compact, 05-extract via
  `EXTRACT_TEMPERATURE` env-override-aware check, entity extraction,
  contradiction judge) — read via a hand-verified single-occurrence regex
  against the actual source file where no exported symbol exists.

Design note (documented in the test file's own doc comment): chose a
curated table over auto-parsing doc comments/CLAUDE.md prose — prose
parsing breaks silently on rewording (false confidence, exactly the failure
this test exists to prevent); a curated row is hand-verified once and then
asserted against the live runtime value on every run.

## Result
**No current drift found.** All 25 assertions pass against today's
`defaultConfig()` / exported constants / source literals.

## Evidence
- `bunx vitest run tests/config` — 17 files / 267 tests passed
- `bunx tsc --noEmit -p .` — clean
- `bunx tsc --noEmit -p tsconfig.tests.json` — clean

## Allowed scope
New test file only (`tests/config/defaults-vs-docs.test.ts`). No config
source touched.

## Confidence
High — every documentedDefault row cites its exact doc source (CLAUDE.md
paragraph or config.ts doc-comment) and was cross-checked against the live
source before being written into the table.

## Risks / open questions
None. `scripts/report-to-pr.ts` referenced by the standard report contract
does not exist in this repo — reported via a direct `gh pr comment` on PR
#445 instead, plus this handoff artifact, per the best-effort fallback rule.

## Suggested next handoff
None required — this slice is self-contained (test-only, no drift found to
triage). If FEAT-483 has further SLICE-7+ waves, promote per the normal
loop backlog scan.
