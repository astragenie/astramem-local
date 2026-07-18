# Architect design review — FEAT-542 / FEAT-543 / FEAT-544 (eval-harness expansion)

**Date:** 2026-07-17
**Reviewer:** architect
**Scope:** verify design fit against the existing extraction-bench / consolidation
test / retrieval-eval conventions; correct concrete design errors; do not
implement.

## Patterns Found

- extraction-bench (`scripts/eval/extraction-bench/`) is an **operator-run,
  metered** harness: CLI entry point (`run-bench.mts`), Azure gpt-5-mini judge
  (`lib/judge.ts`), FEAT-450 multi-run mean±stdev + significance machinery
  (`lib/report.ts`, `../shared/stats.ts`'s `compareMeans`), results written to
  `results/<ts>/`. Never CI-gated (spend + Ollama dependency).
- `tests/eval/retrieval-eval.test.ts` is the opposite pattern: a **CI-run
  vitest gate** (ADR-005) using a deterministic fake embedder, no LLM, no
  spend — asserts fixed recall/NDCG floors on every test run.
- `tests/consolidate/proposals.test.ts` (lines ~159-230) already has the
  exact "seed real atoms with hand-controlled unit vectors via
  `SqliteVecStore.upsert`, run real `runConsolidation()`, assert on its
  output" pattern FEAT-543 wants to reuse — confirmed present and correct,
  under both `candidateSelection: 'full'|'knn'`.
- Atom shape carried by the bench's two run paths is asymmetric: the daemon
  HTTP path (`daemon-runner.ts`, used for every real Ollama candidate) only
  ever sees `{id, type, text}` (`DigestMemRow`, `src/server/queries/
  provenance.ts`); the direct in-process path (`pipeline-direct.ts`, used
  only for the `azure:gpt-5-mini` reference model) additionally carries
  `importance`/`confidence`/`evidence`/`relations`. This asymmetry is already
  documented as a known limitation in the bench's own README and is exactly
  what breaks FEAT-542 AC-3 as originally scoped (see verdict below).
- CLAUDE.md's H2 salvage verdict is respected by all three FEATs as filed —
  none reopen the SPO/12-type-taxonomy door; confirmed by direct reading, not
  just by the FEATs' own "explicitly out of scope" sections.

## Verdicts

### FEAT-542 (hard-fixture pack + evidence-accuracy) — **needs-fix, fixed**

Fixture pack (negation/uncertainty/status-transition/cross-chunk) and the
`forbidden_items` convention are sound and implementable without breaking the
FEAT-450 report shape — the judge already receives `type`+`text` for gold and
extracted atoms; adding a `forbidden_items` block to the prompt and a new
verdict category (or folding a forbidden-item hit into the existing `junk`
bucket for precision purposes, with a separate tally for reporting) is an
additive, non-breaking extension, same shape discipline `passAAtomCount`/
`pending_contradictions` already established elsewhere in this codebase.

AC-3 (evidence-accuracy) was **mis-scoped** and I fixed it in the FEAT file:
it claimed to be judge-free mechanical work only, but the daemon path — the
only path real Ollama candidates run through — has **zero** evidence data
available today (`DigestMemRow`/`DaemonAtom` are hardcoded `{id,type,text}`).
Only the Azure reference model's direct-pipeline path threads `evidence`
through (via `measure-evidence.mts`'s plumbing). As written, the new column
would be a permanent dash for every model actually being compared. Fixed by
adding an explicit AC-3 scope note requiring a small additive extension to
`DigestMemRow` + the digest route (`evidence?: string`, same pattern as the
existing additive `poison_jobs`/`pending_contradictions` fields) plus a
`daemon-runner.ts` read-through update. This is a real, small `src/` touch —
flagged so it isn't silently dropped under "fixture+metric work only."

### FEAT-543 (consolidation semantic-quality eval) — **needs-fix, fixed**

Design premise is sound and addresses a real, cited risk (issue #190's 334
unreviewed auto-corrections; the 0.90-0.92 band containing distinct facts).
The vector-seeding pattern it cites does exist and works as described.

Fixed: the FEAT left the file location ambiguous ("scripts/eval/
consolidation-bench/ (or tests/eval/)") and claimed "deterministic fake
embedder" language borrowed from the retrieval-eval convention without
matching it precisely. Corrected AC-1 to commit to `tests/eval/
consolidation-eval.test.ts` — the mechanical outcome-diff tier is fully
deterministic, needs no LLM/Azure spend, and is exactly the profile
`retrieval-eval.test.ts` already runs as an in-CI vitest gate; `scripts/
eval/`'s convention exists specifically for metered, operator-triggered
Azure-judge benches, which this eval's mandatory tier is not. Also corrected
AC-5's embedder language to describe what's actually reused (hand-seeded
orthogonal unit vectors via `SqliteVecStore.upsert`, not an `EmbedProvider`
stub) and added AC-6 requiring the optional LLM-judge quality pass to live
outside the CI-run vitest file (separate script or explicit opt-in gate) so
CI-safety is never accidentally coupled to a live LLM call.

### FEAT-544 (numeric quality-gate tiers) — **needs-fix, fixed**

The core mechanism (gates.json, PASS/FAIL-per-tier report section,
noise-floor-aware multi-run gating, unit test) is sound and well-scoped —
recalibrated floors instead of the external spec's unrealistic aspirational
ones is the right call.

Fixed: `depends_on: [FEAT-542]` in the frontmatter is only true for ONE of
five gated metrics (evidence-acc). As filed it reads as a hard build-order
gate on the whole FEAT. Added an AC-1 correction requiring the loader to
tolerate a `gates.json` evidence-acc entry with no matching report metric
(render `n/a`, not FAIL/error) so the F1/typeAcc/junk/over-extract gates and
the whole mechanism can ship independently of FEAT-542, in either order.

## Answers to the five questions

**1. Is `forbidden_items` judge-flow-implementable without breaking FEAT-450's
report shape? Does the daemon path even return evidence — does AC-3 need a
scope correction?**
`forbidden_items` — yes, cleanly, as an additive judge-prompt + verdict
extension (see verdict above). Evidence — **no, it does not exist on the
daemon path today**, confirmed by reading `src/server/queries/provenance.ts`'s
`DigestMemRow` (`SELECT id, type, text`) and `daemon-runner.ts`'s
`DigestBody`/`DaemonAtom` types, which mirror it exactly. AC-3 needed and got
a scope correction (see above) requiring a small additive digest-wire change.

**2. FEAT-543: standalone script vs `tests/eval/` — which fits, and does the
"deterministic fake embedder" claim hold for consolidation?**
`tests/eval/` fits better — the mandatory mechanical tier needs no LLM and is
fully deterministic, matching `retrieval-eval.test.ts`'s in-CI vitest
pattern exactly, unlike `scripts/eval/`'s metered-Azure-judge convention. The
determinism claim holds, but not via a fake `EmbedProvider` — via
hand-seeded orthogonal unit vectors written straight to `SqliteVecStore`
(the pattern `proposals.test.ts` already proves out against real
`runConsolidation()` under both candidate-selection modes). Fixed both in
the FEAT file.

**3. FEAT-544: does the noise-floor gate conflict with `compareMeans`'s
semantics? Should `gates.json` live per-repo or per-run?**
No direct conflict, but no direct reuse either — they're different
operations. `compareMeans` (shared/stats.ts) is a **two-sample** comparison
(does config A's mean differ from config B's, given both sides' stdev and
n). FEAT-544's gate is a **one-sample-vs-fixed-floor** comparison (is this
one model's measured mean±stdev interval above an externally-set number).
The FEAT's own description ("mean±stdev below floor = FAIL, straddling =
inconclusive") is a sound, distinct primitive — the build should write a
new small helper (naturally living beside `compareMeans` in `shared/
stats.ts` for reuse) rather than attempt to force-fit `compareMeans`'s
two-argument signature onto a threshold check. Worth a one-line note in
FEAT-544 for whoever builds it (not blocking — didn't edit the file for this
since it's an implementation-detail heads-up, not a design defect).
`gates.json` should live per-repo (`scripts/eval/extraction-bench/
gates.json`, version-controlled) — it encodes floors calibrated to *this*
codebase's measured baselines, not a per-invocation parameter; a per-run
copy would drift silently and defeat the "revisable, not sacred" provenance
story the FEAT already commits to.

**4. Dependency graph: is `544 depends_on 542` correct?**
Directionally correct (evidence-acc genuinely needs FEAT-542's column to
exist) but overstated as filed — it reads as blocking the entire FEAT.
Softened via the AC-1 edit above: the dependency is now scoped to exactly
one gate metric: the rest of FEAT-544 can build, ship, and be exercised
independently, in either priority order relative to 542.

**5. Sizing — single slice or multi-slice per FEAT?**

- **FEAT-542 — 2 slices.** Slice 1: additive `evidence` field on
  `DigestMemRow` + digest route + `daemon-runner.ts` read-through (small,
  mechanical, `src/`-touching, its own test). Slice 2: the ≥10 new fixtures,
  `forbidden_items` convention + judge/report extension, Evidence-acc column
  wired to the now-real data, baseline re-measure, README. Splitting keeps
  the one `src/` wire change reviewable in isolation from the fixture/prompt
  work, which is the larger and more judgment-heavy piece.
- **FEAT-543 — 2 slices.** Slice 1: fixture set + runner (seed + real
  `runConsolidation` + outcome diff) + weighted mechanical scoring +
  baseline measurement under both `candidateSelection` modes (AC-1–AC-5,
  minus the judge-optional pass) — this is the whole CI-safe, high-value
  core. Slice 2: the optional LLM-judge merged-text-quality pass (AC-6,
  correctly scoped as separable and lower-priority; could even be deferred
  past this FEAT's initial ship if budget is tight).
- **FEAT-544 — 1 slice.** `gates.json` + loader + report evaluator + unit
  test + README is contained, mechanical, and doesn't need splitting.

## Suggested priority order

1. **FEAT-543** — highest risk-reduction: consolidation today silently
   auto-merges with zero semantic-quality signal (334 uninspected
   corrections per issue #190); a false merge destroys data permanently.
   Nothing here blocks on the other two FEATs.
2. **FEAT-542** — closes real, cited failure classes (negation/uncertainty/
   cross-chunk — the last one is the measured dominant LoCoMo miss class) and
   unlocks a real evidence-accuracy signal once its digest-wire slice lands.
3. **FEAT-544** — do last so its evidence-acc gate can ship complete rather
   than partial; the rest of its mechanism has no ordering constraint and
   could technically run in parallel with either of the above if capacity
   allows.

## Files touched (surgical edits only, no rewrites)

- `.claude/artifacts/loop/backlog/pending/FEAT-542.md` — AC-3 scope
  correction (digest-wire dependency), out-of-scope caveat.
- `.claude/artifacts/loop/backlog/pending/FEAT-543.md` — AC-1 location fix
  (`tests/eval/consolidation-eval.test.ts`), AC-5 embedder-claim precision,
  new AC-6 (judge-optional pass isolation).
- `.claude/artifacts/loop/backlog/pending/FEAT-544.md` — AC-1 dependency
  softening (evidence-acc gate tolerates a not-yet-existing metric).

No `src/` or test files were touched — this review is design-only per the
architect's write boundary; the digest-wire change identified for FEAT-542
is design guidance for whichever builder picks up that slice, not something
implemented here.
