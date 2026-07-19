---
id: FEAT-551
status: done
priority: P1
category: feature
target_release: null
created: 2026-07-18
updated: 2026-07-18
depends_on: []
slices: []
derived_from: 2026-07-18 LoCoMo experiment series — the passB negative result (−5.8, junk crowding) + FEAT-542's mechanical quote verification landing the same day
cross_product: [astramem-local]
autonomous_safe: true
triage_notes: |
  Filed 2026-07-18 per operator ("push to 0.65"). 2026-07-18 LoCoMo
  experiment series — the passB negative result (−5.8, junk crowding) +
  FEAT-542's mechanical quote verification landing the same day.
  ---
  2026-07-18 PM deep triage: P1, autonomous_safe=true. customer_impact 0.75
  (est +2-4 LoCoMo pts, targets the 55% not-in-db bucket, the largest
  measured loss pile this session identified), effort 0.45 (5 pts, analog
  SLICE-437, reuses two shipped subsystems FEAT-534+FEAT-542), strategic_
  alignment 0.80, technical_risk 0.40 (touches stage-8 admission chokepoint;
  shared-vs-drifted quote-checker implementation named as the one real
  risk), dependency_depth 0.15 (depends_on: [] declared, both real
  prerequisites FEAT-534/FEAT-542 confirmed done). Pre-mortem completed
  (P1). Weighted composite 0.715 — highest of the seven FEATs in this
  batch; recommended build-FIRST, narrowly ahead of FEAT-547 (0.70).
---
## Description

**Evidence-gated sweeper — passB recall with a mechanical admission gate.**

Measured facts this rides on (2026-07-17/18):
- 55% of LoCoMo misses = the fact was never stored (largest bucket).
- phi4-mini passB recall ≈ 100%, but raw passB LOST −5.8 end-to-end: its junk atoms
  crowded top-k retrieval (adversarial −14.9 — junk = fake evidence for should-abstain
  questions).
- FEAT-542's mechanical quote check (whitespace-normalized verification that an atom's
  `evidence` quote appears in the source transcript) landed and is wired through the
  daemon digest path.

The fix: run the dual-pass sweeper (FEAT-534 machinery, `distill.extractionPassB`) with
a local model, but **admit passB atoms to the store ONLY when their evidence quote
mechanically verifies against the transcript**. Pass-A (primary extractor) atoms are
untouched. A hallucinated or free-floating passB atom has no verifying quote → dropped
before indexing (counted, logged — never silent). Junk cannot crowd retrieval because
junk cannot enter.

Mechanics:
- PassB prompt gains a REQUIRED `evidence` field (verbatim supporting quote) — an atom
  without one is dropped by construction.
- Gate sits at stage-8 admission (pre-embed/index), reusing FEAT-542's normalization
  logic (promote the checker from bench lib to a shared src util, or mirror it —
  builder's call, no drift: single implementation).
- Config: `distill.extractionPassB.evidenceGate: on|off` (default on whenever passB
  provider differs from passA — the mixed-provider case is exactly where the junk risk
  was measured), plus a dropped-count observable (rate canary discipline).

Measurement (the point): LoCoMo conv-1 A/B vs the 0.6002 baseline — overall delta AND
the adversarial guard (**must hold ≥0.87**; the phi-sweep failure defined this canary).
Also atoms-stored + gate-drop-rate reported.

## Explicitly out of scope
- No changes to pass-A extraction or the conv-liberal prompt (independent lever).
- No semantic (LLM) support-judgment in the gate — mechanical quote match only
  (semantic support-check is FEAT-547's evidence_supported flag, a different layer).
- No default enablement of passB itself — this FEAT makes mixed-provider passB SAFE,
  the enablement decision still needs the measured A/B.

## Acceptance criteria (Given-When-Then)

- AC-1: Given `distill.extractionPassB` is configured with a provider
  different from pass-A's provider (the mixed-provider case), When a passB
  atom is produced WITHOUT a verbatim `evidence` quote field, Then it is
  dropped before stage-8 admission (never embedded, never indexed) and the
  drop is counted and logged (structured: atom source, reason
  `no-evidence-field`) — never silent; Given a passB atom carries an
  `evidence` field that does NOT mechanically verify (whitespace-normalized
  match) against the source transcript text, Then it is likewise dropped
  pre-index with a distinct logged reason (`evidence-not-found`).
- AC-2: Given `distill.extractionPassB.evidenceGate: 'off'` OR pass-A atoms
  (regardless of the gate setting), When stage-8 admission runs, Then
  behavior is byte-identical to pre-FEAT-551 single-pass behavior — the gate
  applies ONLY to passB atoms in the mixed-provider case, and an integration
  test asserts pass-A atom count and content are unaffected by the gate
  being on or off.
- AC-3: Given FEAT-542's existing `computeEvidenceAccuracy`/
  `normalizeWhitespace` implementation
  (`scripts/eval/extraction-bench/lib/mechanical-checks.ts`), When this
  FEAT's stage-8 gate performs its quote-verification check, Then it calls
  the SAME implementation (promoted to a shared `src/` util, or a
  single-source-of-truth import — builder's choice, but there must be
  exactly one implementation, not two) — a test asserts the bench's
  `computeEvidenceAccuracy` and the production gate agree on at least one
  shared fixture, closing the exact "bench/src drift" risk named in the
  FEAT body and the pre-mortem's integration-failure mode.
- AC-4: Given an extraction-bench run with `codex` (pass-A) +
  `passB=phi4-mini` and the gate `on`, When the sweep completes against the
  existing fixture set, Then it reports the junk rate WITH the gate on
  versus the previously-measured ungated 12% baseline, AND the recall
  retention percentage (how much of phi's ≈100% passB recall survives
  gating) — both numbers in the run's evidence artifact, not narrated only.
- AC-5: Given the gate wired end-to-end, When a LoCoMo conv-1 A/B run
  executes against the current 0.6002 baseline, Then it reports the overall
  F1 delta AND the adversarial-category score, with the adversarial score
  required to hold **>=0.87** (the exact floor the phi-sweep failure
  defined) — a run where the overall delta is positive but the adversarial
  guard drops below 0.87 is recorded as a FAILED enablement case per the
  pre-mortem's #1 risk, not a partial success; the gate-drop-rate
  (dropped passB atoms / total passB atoms attempted) is also reported
  alongside both scores.

## Options considered

- Use FEAT-547's `evidence_supported` (semantic, LLM-judged) check as the
  admission gate instead of a mechanical string match — rejected,
  explicitly out of scope: "No semantic (LLM) support-judgment in the gate
  — mechanical quote match only (semantic support-check is FEAT-547's
  evidence_supported flag, a different layer)"; conflating the two would
  reintroduce an LLM call on the hot admission path this FEAT is designed
  to keep mechanical/free.
- Gate pass-A atoms too (symmetric treatment) — rejected, explicitly out of
  scope: "No changes to pass-A extraction... Pass-A (primary extractor)
  atoms are untouched"; pass-A's measured reliability does not carry the
  same junk-crowding risk passB's mixed-provider case does, so gating it
  would add cost with no evidenced benefit.
- Default `evidenceGate: on` for ALL passB configurations, not just
  mixed-provider — rejected: the FEAT body's own default is scoped to "on
  whenever passB provider differs from passA — the mixed-provider case is
  exactly where the junk risk was measured"; a same-provider passB run has
  no measured junk-crowding evidence justifying the gate's admission-loss
  cost.
- Ship without the LoCoMo A/B (AC-5), relying on the extraction-bench sweep
  (AC-4) alone — rejected: the FEAT's entire value proposition is a
  top-line benchmark delta (+2-4 LoCoMo pts) and an adversarial-guard floor
  (>=0.87) neither of which the extraction-bench sweep alone measures;
  shipping without AC-5 would leave the FEAT's central claim unverified.

## Wave outcome (2026-07-18)

2026-07-18 WAVE COMPLETE: built (SLICE-440, tip e6c17156 after one needs_fix round — counters-never-persisted, fixed + DB-row tests), review PASS. MEASURED (LoCoMo conv-1): gate VINDICATED (+3.7 vs ungated, junk blocked, adversarial 0.70->0.85) but phi ignores evidence-field 77% -> net -2.7 vs champion 0.6002; adversarial 0.8511 < 0.87 guard -> FORMAL NO-ENABLE for passB=phi. Gate infra makes any future sweeper safe to test. Gate telemetry (191 attempted/165 dropped) worked exactly as designed.
