---
findings: "🔴:0,🟡:0,❓:3"
status: completed
decision: approved
author_id: w4-eval (worktree C:/work/mega/astra-wt/w4-eval, commit 7b1de4b0)
judge_id: main (independent review, read-only)
self_approval: false
---
# Review Result: Wave-4 eval significance harness (compare.mts + paired-significance.ts)

- Created: 2026-07-23T16:28:35Z
- Reviewer: main (independent, read-only)
- Decision: approved (PASS)
- Status: completed
- Summary: PASS. This harness is the gate for all future LoCoMo A/B score
  claims, so the review centered on statistical correctness, not style. The
  paired-bootstrap method is sound and correctly implemented: pairing is on
  qa_id (the intersection, with onlyInA/onlyInB counted and excluded — never
  silently dropped), each config's per-question mean is computed first
  across that config's own repeats (isolating answerer noise), the signed
  delta (meanA - meanB) is the correct per-question unit fed into the
  bootstrap (not a per-repeat unit), the percentile CI (10k resamples,
  seeded mulberry32, default alpha 0.05) is textbook Efron/Koehn-2004, and
  SIGNIFICANT is correctly decided as "CI excludes zero." Verified by
  reading scorePerQuestionAcrossRuns/scoreHypothesis against repeat-run.mts's
  own scoreRun — same skip-handling ("(skipped...)" placeholders excluded),
  same qa_id join key (qaId() = `${sampleId}#${qaIndex}`), same scoring
  function — so the paired path is a faithful per-question refinement of the
  existing aggregate scorer, not a parallel reimplementation that could drift.
  The collision fix is real: reanswerSnapshotDirs names both configs'
  raw output identically when they share a baseRunDir
  (`${baseRunDir}-reanswerN`), and runConfig() renames each config's result
  into a label-scoped `-cmp-<slug>` dir immediately after that config's
  spawnSync returns and *before* the next config's spawnSync starts —
  sequential call order (dirsA fully run+renamed, then dirsB) makes the
  fix sound by construction, not just by lucky test coverage. Judge-cheap
  discipline holds: the verdict (overall + byCategory) is computed purely
  from token-F1 before the `--llm-judge` block ever runs, and the stronger
  answerer presets require an explicit `--config-*-answerer-preset` flag
  (never a default) with a loud stderr warning on every non-cheap preset.
  evaluateMultiRunParamsGuard is reused verbatim across the full dirsA+dirsB
  set (not re-implemented, not scoped to just one side). --print-only is
  confirmed side-effect-free (no spawn, no rename, no file write) by test
  and by reading runConfig's early return. Full test suite green
  (221/221, 16 files) and `bunx tsc --noEmit -p tsconfig.eval.json` clean,
  both re-run live in this review, not trusted from the commit message.
  Base discipline holds: diff vs feat/retrieval-overhaul is exactly the
  4 new files claimed (compare.mts, compare.test.ts,
  judge/paired-significance.ts, judge/paired-significance.test.ts), 1234
  insertions, 0 deletions, nothing touched outside scripts/eval/locomo.
- Evidence Checked:
  - `npx vitest run scripts/eval/locomo` → 16 files / 221 tests passed
  - `bunx tsc --noEmit -p tsconfig.eval.json` → clean, no output
  - `git diff feat/retrieval-overhaul..w4/eval --stat` → 4 files, 1234(+)/0(-), matches claim
  - Read paired-significance.ts and compare.mts in full; cross-checked
    scorePerQuestionAcrossRuns against judge/metrics.mts's scoreRun and
    lib/types.ts's qaId() for scoring/join parity
  - Read repeat-run.mts's reingestRunDirs/reanswerSnapshotDirs/aggregateRunDirs
    and shared/run-params.ts's evaluateMultiRunParamsGuard to verify the
    collision-fix premise and guard semantics independently of the PR's own
    claims
- Files Reviewed:
  - scripts/eval/locomo/compare.mts
  - scripts/eval/locomo/compare.test.ts
  - scripts/eval/locomo/judge/paired-significance.ts
  - scripts/eval/locomo/judge/paired-significance.test.ts
  - (read-only, for cross-check) scripts/eval/locomo/repeat-run.mts, scripts/eval/shared/run-params.ts, scripts/eval/shared/stats.ts, scripts/eval/locomo/judge/metrics.mts, scripts/eval/locomo/lib/types.ts
- Test Adequacy: Fixture tests genuinely prove the statistical claim, not
  just happy-path shape — `decidePairedSignificance` has a dedicated
  SIGNIFICANT case (60 questions, delta centered at 0.15 with small jitter,
  every value strictly positive so the result isn't seed-lucky) and a
  dedicated NOT_SIGNIFICANT case (10 questions, deltas jittered symmetrically
  around ~0). `decidePairedSignificanceByCategory` proves per-category
  independence (one category SIGNIFICANT, one NOT_SIGNIFICANT, one
  INCONCLUSIVE for zero paired questions, in the same call). `bootstrapMeanCI`
  has both determinism-given-seed and CI-excludes/includes-zero cases.
  `pairDeltas` has explicit onlyInA/onlyInB coverage. The collision-fix test
  (`expectedRunDirs`) proves the *naming scheme* never collides even when
  both configs share a baseRunDir+mode — see the one ❓ below on what it does
  not prove.
- Author: w4-eval (worktree agent)
- Judge: main (independent review)
- Risks:
  - ❓ LOW: The live rename/collision-avoidance behavior in `runConfig()`
    (spawnSync + immediate renameSync) is never exercised by an automated
    test — only the pure directory-naming math (`expectedRunDirs` vs
    `rawRepeatRunDirs`) is tested; the actual spawn-then-rename sequencing is
    verified here by code reading (sequential dirsA-then-dirsB calls,
    matching repeat-run.mts's own precedent for not testing the
    child-spawning top layer), not by a test that simulates two real
    invocations sharing a baseRunDir. Disclosed in the file's own header, so
    not a hidden gap — but worth knowing before trusting it blind on a novel
    OS/filesystem.
  - ❓ LOW: `evaluateMultiRunParamsGuard` runs *after* both configs' full
    repeat-run.mts invocations complete (compare.mts's own docstring says
    so explicitly: "Runs ... N repeats of each config ... then: 1. refuses
    via the guard"), not before. For the documented intended cheap path
    (both sides `--mode reanswer` against the identical `baseRunDir`) this
    is a non-issue — the guard trivially passes by construction. But if an
    operator points configA/configB's `baseRunDir`/`runDirBase` at two
    stores that turn out to have been sampled differently, the mismatch is
    only caught (correctly refused, not silently blessed) *after* both
    configs' repeats have already run — i.e., this protects correctness of
    the reported number, not the cost/time already spent discovering the
    mismatch. Worth a pre-flight run-params.json comparison in a future
    slice if cross-store comparisons become common; not a correctness flaw
    in what gets reported today.
  - ❓ LOW: A per-question `meanA(qa)`/`meanB(qa)` is only as stable as the
    number of that question's own non-skipped repeats, which can be less
    than the config's overall `repeats` if a distill timeout skipped just
    that question on some repeats. `MIN_REPEATS`/`minRepeats` gates the
    *config-level* repeat count (dirsA.length/dirsB.length), not each
    individual paired question's actual supporting sample size — so a
    question with only 1-of-5 non-skipped repeats contributes a delta with
    no more statistical backing than n=1, indistinguishable in the output
    from a fully-supported question. Narrow edge case (requires per-question
    skip, not a whole-repeat failure), not a bug in the math itself; a
    reasonable follow-up would be to surface per-question support count in
    the report.
- Required Follow-up: None required to merge — all three items above are
  disclosed-tradeoff or narrow-edge-case observations, not correctness bugs
  in the shipped statistics. Optional follow-ups for a future slice: (1) a
  cheap pre-flight run-params.json comparability check before spawning
  either config's repeat-run.mts, for the cross-store comparison case; (2)
  surface per-question repeat-support counts alongside each paired delta.
