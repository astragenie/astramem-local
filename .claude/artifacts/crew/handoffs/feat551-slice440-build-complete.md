---
kind: handoff
objective: FEAT-551 evidence-gated sweeper implemented — AC-1/AC-2/AC-3 done, AC-4/AC-5 deferred to measurement lane
owner: fullstack-dev (builder)
slice: SLICE-440
feature: FEAT-551
phase: null
created_at: 2026-07-18
confidence: high
next_handoff: review-then-measurement-lane
---
# Handoff — FEAT-551 evidence-gated sweeper, build complete

**Feature:** FEAT-551 · **Slice:** SLICE-440 · **Branch:** `feat/551-evidence-gated-sweeper`
**Worktree:** `C:\work\mega\astramemory-local-wt551`

## Objective

Add a mechanical (judge-free) stage-8 admission gate for dual-pass
"specifics sweeper" (passB) atoms in the mixed-provider case: a passB atom
without a verbatim `evidence` quote, or one whose quote does not mechanically
verify (whitespace-normalized) against the source transcript, is dropped
pre-index — counted and logged with a distinct reason, never silent. Pass-A
atoms are never gated. Reuses FEAT-542's quote-verification logic via a
single promoted `src/` implementation shared with the extraction bench.

## What shipped (AC-1, AC-2, AC-3 — PASS with test evidence)

- **`src/distill/evidence-verify.ts`** (new) — `normalizeWhitespace` +
  `verifyEvidenceQuote`, the single shared quote-verification implementation.
- **`scripts/eval/extraction-bench/lib/mechanical-checks.ts`** —
  `computeEvidenceAccuracy` now delegates to `verifyEvidenceQuote` instead of
  carrying its own copy (AC-3: exactly one implementation).
- **`src/distill/evidence-gate.ts`** (new) — `checkEvidenceGate` (production
  admission decision) + `EvidenceGateDropReason`
  (`no-evidence-field`|`evidence-not-found`) + `AtomExtractionSource`.
- **`src/distill/prompts/extract.ts`** — `SourcedAtom`/`AtomExtractionSource`
  types (programmatic tag, never part of the LLM JSON contract); sweeper
  prompt (`EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER`) now states `evidence`
  is REQUIRED for every atom it emits (was "optional") — same shared prompt,
  not forked per provider.
- **`src/distill/dedup-merge.ts`** / **`src/distill/stages/06-reduce.ts`** —
  widened to generics over `SourcedAtom` so the pass tag survives
  merge/reduce for free (both already spread rather than reconstruct atoms).
- **`src/distill/pipeline.ts`** — tags passA/passB atoms right where each
  pass's atoms are read back (before `mergeDualPassAtoms`); resolves
  `evidenceGateEnabled` (explicit config wins; else defaults ON exactly when
  passB's resolved provider `.name` differs from pass A's) and threads it
  into `embedAndIndex`.
- **`src/distill/stages/08-embed-index.ts`** — new `evidenceGateEnabled`
  context field + gate check as a third "last line of defense" filter next
  to the erasure/durability gates; `false`/omitted is a total bypass (no
  call at all) — AC-2's byte-identical contract.
- **`src/config/config.ts`** — `distill.extractionPassB.evidenceGate:
  'on'|'off'`, validated by `applyExtractionPassBGovernance` (invalid value
  dropped with a warning, never fatal — same posture as the `provider`
  override it sits alongside).
- **`src/storage/evidence-gate-log.ts`** + **`migrations/053-evidence-gate-drops.sql`**
  — `evidence_gate_drops` (reason+count) and `evidence_gate_run_log`
  (atoms_attempted/atoms_dropped) so a future doctor canary or the AC-5
  measurement lane can compute a drop RATE, not just an existence check
  (canary-must-measure-rate-not-existence discipline).

## Test evidence

- `tests/distill/evidence-gate.test.ts` (new, 15 tests) — unit coverage for
  `verifyEvidenceQuote`/`normalizeWhitespace` and `checkEvidenceGate` (AC-1's
  two drop reasons; AC-2's pass-A/no-tag bypass); plus 4 parameterized AC-3
  cases asserting the bench's own `computeEvidenceAccuracy` and
  `checkEvidenceGate` agree on a shared fixture.
- `tests/distill/08-embed-index.test.ts` — new `describe('evidence gate
  (FEAT-551)')` block (8 tests): AC-1 drop-reason + admission cases, AC-2
  pass-A bypass / gate-off / gate-omitted / mixed-batch cases.
- `tests/distill/pipeline.test.ts` — new `describe('evidence-gated sweeper
  wiring')` block (4 tests): mixed-provider default resolution, explicit
  `'off'` override, explicit `'on'` forcing the gate in a same-provider run,
  and the AC-2 integration case explicitly required by the spec — pass-A
  atom count/content byte-identical whether the gate is explicitly on or off.
- `tests/config/config.test.ts` — 5 new `applyExtractionPassBGovernance`
  cases for `evidenceGate` validation.
- **Full run:** `tests/distill/` + `tests/config/` — **36 test files, 721
  tests, all green.** No pre-existing test was modified to make this pass.

## Verification commands run

```
bun run build                      # tsc -p . — clean
npx tsc -p tsconfig.tests.json      # clean
npx tsc -p tsconfig.eval.json       # clean (covers scripts/eval/*)
npx vitest run tests/distill/ tests/config/   # 36 files / 721 tests, all pass
```
`ASTRA_SKIP_CONSOLIDATE` was unset before every test run. No live Ollama/LLM
calls made — all tests use mock providers (`ASTRA_MEMORY_MOCK_PROVIDERS`
pattern already in the repo's test machinery); the GPU-owned rebaseline run
was never touched.

## Deferred (AC-4, AC-5 — NOT run, by design)

Per dispatch scope, AC-4 (extraction-bench sweep with codex+phi4-mini,
gate on, junk-rate/recall-retention numbers) and AC-5 (LoCoMo conv-1 A/B run
against the 0.6002 baseline, adversarial-category ≥0.87 floor,
gate-drop-rate) are the serial measurement lane and were deliberately NOT
run in this build. The wiring needed to run them exists:
- `distill.extractionPassB.evidenceGate` is settable in the bench's own
  config path (same `Config['distill']` shape production uses).
- `evidence_gate_run_log`/`evidence_gate_drops` give the gate-drop-rate
  numerator/denominator AC-5 asks for.
- `src/distill/evidence-gate.ts` and `src/distill/evidence-verify.ts` are
  importable directly by any bench/measurement script.

## Changed files

Core:
- `src/distill/evidence-verify.ts` (new)
- `src/distill/evidence-gate.ts` (new)
- `src/storage/evidence-gate-log.ts` (new)
- `migrations/053-evidence-gate-drops.sql` (new)
- `src/distill/prompts/extract.ts`
- `src/distill/dedup-merge.ts`
- `src/distill/stages/06-reduce.ts`
- `src/distill/pipeline.ts`
- `src/distill/stages/08-embed-index.ts`
- `src/config/config.ts`
- `scripts/eval/extraction-bench/lib/mechanical-checks.ts`

Tests:
- `tests/distill/evidence-gate.test.ts` (new)
- `tests/distill/08-embed-index.test.ts`
- `tests/distill/pipeline.test.ts`
- `tests/config/config.test.ts`

## Commits (branch `feat/551-evidence-gated-sweeper`)

1. `b43f69b4` feat(distill): FEAT-551 evidence-gated sweeper — shared verify util + production gate
2. `420c1eae` feat(distill): FEAT-551 — tag atoms by extraction pass, wire gate through the pipeline
3. `f07b165d` refactor(bench): FEAT-551 — mechanical-checks.ts delegates quote-check to shared util
4. `240ec18d` test(distill): FEAT-551 evidence-gated sweeper coverage (AC-1/AC-2/AC-3)

Branch tip: `240ec18d2eca843d4198b57240ef59c8d76aae91`

## Confidence

High for AC-1/AC-2/AC-3 — mechanically verified end-to-end (unit, stage-8
integration, full-pipeline wiring) with 721 green tests and clean
build/typecheck on all three tsconfigs. AC-4/AC-5 are unmeasured by design
(deferred to the serial measurement lane, GPU-owned by the rebaseline run).

## Risks / open questions

- **Provider-name-only mixed-provider detection**: the default resolution
  compares `passBProvider.name !== ctx.llmExtraction.name` (e.g.
  `codex-subscription` vs `ollama`), not model. Two DIFFERENT models on the
  SAME provider type (e.g. two different Ollama models) do NOT trigger the
  default-on gate — matches the FEAT body's explicit framing ("the
  mixed-provider case is exactly where the junk risk was measured") but is
  worth flagging in case future measurement finds same-provider,
  different-model passB carries similar junk risk; `evidenceGate: 'on'` is
  the explicit escape hatch already in place.
- **`sourceText` fidelity**: the gate verifies against `ctx.sourceText`,
  which is `runPipeline`'s own `transcript` argument (the flattened
  transcript, pre-cleanup/normalize) — same source FEAT-491's
  `attributeSpeaker` already relies on. Not re-verified against
  post-cleanup text; if cleanup ever strips content a real evidence quote
  depends on, that's a pre-existing risk this FEAT inherits, not introduces.
- **Migration 053 numbering**: confirmed via `git log origin/main --oneline
  -1 -- migrations` at build time that 052 was the last migration on
  `origin/main` (matches this worktree) — no renumbering risk detected, but
  re-verify before merge if `origin/main` has moved.
- AC-4/AC-5 not run — see Deferred section above. Needs a follow-up
  dispatch to the measurement lane (extraction-bench + LoCoMo harness owner).

## Suggested next handoff

1. Reviewer pass on this diff (11 source files + 4 test files across 4 commits).
2. Once reviewed, hand to the serial measurement lane for AC-4 (extraction
   bench, codex+phi4-mini, gate on vs the 12% ungated junk baseline) and
   AC-5 (LoCoMo conv-1 A/B vs 0.6002, adversarial ≥0.87 floor,
   gate-drop-rate) — that lane owns the GPU/Ollama and LoCoMo harness, not
   this build.
3. Slice-close ceremony (`/runner:slice complete --id SLICE-440` +
   grade) — not run by this builder; AC-4/AC-5 still open so the slice
   likely stays `in-progress` until the measurement lane reports back,
   unless the lead decides to close on AC-1/2/3 alone with AC-4/5 tracked
   as a follow-up.
