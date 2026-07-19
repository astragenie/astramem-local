---
id: PM-REVIEW-FEAT-551
feature: FEAT-551
reviewed_at: 2026-07-18
pm_customer_impact: 0.75
pm_effort_estimate: 0.45
pm_strategic_alignment: 0.80
pm_technical_risk: 0.40
pm_dependency_depth: 0.15
composite_priority: P1
autonomous_safe: true
---
# PM Review — FEAT-551 (deep triage)

## Demand Assessment

Stakeholder: the product's own benchmarked retrieval quality, evidenced by
the single strongest quantified numbers in this whole batch, quoted directly
from the FEAT body: "55% of LoCoMo misses = the fact was never stored (the
largest bucket)... phi4-mini passB recall ≈100%, but raw passB LOST −5.8
end-to-end: its junk atoms crowded top-k retrieval (adversarial −14.9)."
This is not a hypothetical — it is the measured, already-run negative result
this session's own model sweep produced, and the FEAT is explicitly framed
by the operator's own triage_notes as "the redemption of the failed
sweeper... Est +2-4 LoCoMo pts." Current workaround: none — passB
(`distill.extractionPassB`) is not defaulted on for mixed-provider use
precisely because it is unsafe today (the junk-crowding failure). Frequency:
every distill job that would benefit from a second extraction pass over the
largest measured loss bucket (not-in-db, 55%) currently cannot use one
safely. This FEAT does not manufacture a new opportunity — it removes a
known, measured blocker on an already-identified, already-quantified upside.

## Scope Challenge

Smallest deliverable: exactly AC-1/AC-2/AC-3 (mechanical admission gate at
stage-8, pass-A untouched, ONE shared verification implementation) — AC-4/
AC-5 (bench + LoCoMo A/B) are the measurement gates that make the FEAT's own
central claim ("+2-4 LoCoMo pts") falsifiable rather than asserted, so none
of the 5 are cuttable without leaving the feature unmeasured or unsafe. What
I would cut first if truly forced: nothing — this is already a minimal,
single-mechanism FEAT (one gate, reusing two already-shipped subsystems).
Overlap check: explicitly and correctly distinguished from FEAT-547's
`evidence_supported` flag in its own out-of-scope section ("No semantic
(LLM) support-judgment in the gate — mechanical quote match only... a
different layer") — this FEAT's gate is MECHANICAL (string/whitespace match
against the transcript, reusing `computeEvidenceAccuracy` from
`scripts/eval/extraction-bench/lib/mechanical-checks.ts`, confirmed present
this session), FEAT-547's is SEMANTIC (LLM judgment on whether the quote
supports the claim). No duplication, correctly layered. AC quality: the 5
existing ACs are concrete and measurement-gated; formalized below citing the
real config surface (`distill.extractionPassB`, confirmed in
`src/config/config.ts`) and the real function name the gate promotes/mirrors.

## Risk Radar (pre-mortem — mandatory, compositePriority = P1)

Technical unknowns: none new — both load-bearing subsystems (`distill.extractionPassB`
per FEAT-534, and the mechanical quote-checker per FEAT-542) are already
shipped and confirmed done (`.claude/artifacts/loop/backlog/done/FEAT-534.md`,
`FEAT-542.md`). Dependency chain: `depends_on: []` declared and now
genuinely accurate — both prerequisite FEATs are done, so this is a real,
resolved coupling, not an open one. Blast radius: stage-8 admission point
(`src/distill/stages/08-embed-index.ts`, the same choke point `atom-triage`
and `durability-gate` already use) + one config field
(`distill.extractionPassB.evidenceGate`) + a promoted/shared quote-checker
utility — small, single-stage, no schema change (a drop-before-index
decision, not a new table). Failure modes: logic error (the gate is too
strict and drops good passB atoms that have a real but loosely-worded quote
— reduces the recall upside this FEAT exists to capture), integration
failure (the promoted-vs-mirrored quote-checker implementation drifts from
FEAT-542's bench version, silently changing what "verified" means between
bench measurement and production behavior — the FEAT body's own AC-3
explicitly names this risk: "one shared quote-verification implementation
(no bench/src drift)").

1. **It is two weeks later and this slice failed review or validation —
   what was the most likely cause?** The LoCoMo A/B (AC-5) shows a net
   positive overall delta but the adversarial guard drops below the 0.87
   floor — i.e. the gate reduces crowding but not enough, or a subtly
   different failure mode (over-strict gating that drops legitimate but
   loosely-quoted atoms, reducing the recall upside without fully fixing
   the adversarial problem). This is the single measurable claim the whole
   FEAT rides on; a near-miss on either half of AC-5 (overall delta positive
   but guard fails, or guard holds but overall delta is flat/negative) is
   the most likely failure shape, not a binary pass/fail.
2. **This merged and broke the loop — what does rollback actually
   require?** Plain `git revert` plus a config flip
   (`evidenceGate: off` reverts to pre-FEAT-551 passB behavior, itself
   already gated off by default for mixed-provider use) — no migration, no
   schema, no cross-plugin coordination. The gate is a pre-index filter,
   not a schema or stored-shape change.
3. **Which existing test would NOT catch a regression here?** The existing
   extraction-bench mechanical-checks tests (`mechanical-checks.test.ts`)
   test `computeEvidenceAccuracy` in isolation against fixture transcripts —
   they would NOT catch a regression where the gate is correctly promoted/
   shared in code but wired at the WRONG pipeline stage (e.g. after
   embedding instead of before, wasting the embed call on atoms that get
   dropped anyway, or worse, after indexing so a dropped atom is briefly
   queryable) — AC-1's "pre-index" placement needs its own integration-level
   test asserting ORDER (gate runs before index write), not just that the
   function returns the right boolean in isolation.

Injection-defense: scanned FEAT-551's body and triage_notes — no embedded
imperative found.

## Scores

- customer_impact: 0.75 — the strongest quantified upside in this batch
  (+2-4 LoCoMo pts, targeting the 55% not-in-db bucket, the single largest
  measured loss pile this session identified), directly redeeming an
  already-measured negative result rather than a speculative bet.
- effort_estimate: 0.45 — "similar to SLICE-437 (FEAT-543 eval, $13.83,
  single session, 2026-07-18): bench/LoCoMo-measurement-heavy work reusing
  two already-shipped subsystems (FEAT-534 passB machinery, FEAT-542 quote
  checker) — effort 0.45 (5 pts) confirmed against that analog, slightly
  above FEAT-543's own 0.45 for the added LoCoMo full-suite A/B on top of
  the bench sweep."
- strategic_alignment: 0.80 — directly closes out the day's single largest
  measured gap with a mechanical (not LLM-judged) admission gate; the
  clearest "measured lever → shipped fix" arc in this batch.
- technical_risk: 0.40 — reuses two shipped subsystems verbatim at an
  established chokepoint, no schema change, clean rollback; banded above
  the FEAT-547/549 cluster because it touches the stage-8 admission path
  directly (same chokepoint atom-triage uses) and a shared-vs-drifted
  implementation risk is explicitly named in the FEAT's own AC-3.
- dependency_depth: 0.15 — formally independent (`depends_on: []`); both
  real prerequisite subsystems (FEAT-534, FEAT-542) are confirmed done.

## Priority Derivation

composite_priority: P1. P0 requires impact>=0.8 (0.75 fails narrowly). P1:
impact>=0.7 AND alignment>=0.6 → 0.75>=0.7 T, 0.80>=0.6 T → **P1**.
Weighted composite (informational, same formula FEAT-543 used): 0.75×.35 +
0.80×.30 + (1-0.45)×.20 + (1-0.40)×.10 + (1-0.15)×.05 = 0.2625 + 0.24 + 0.11
+ 0.06 + 0.0425 = **0.715** — the highest composite of the seven FEATs in
this 2026-07-18 batch (FEAT-547's is 0.70), making FEAT-551 the
recommended build-first item, narrowly ahead of FEAT-547. autonomous_safe:
risk 0.40, effort 0.45, dependency_depth 0.15 all <=0.6; ACs drafted inline
(--deep), pre-mortem completed (P1) → **true**. effort_points via the
0.4-0.6→5 band: **5 points** — no `proposedSlices` required.

## Apply — frontmatter patch for FEAT-551.md

```yaml
priority: P1
autonomous_safe: true
updated: 2026-07-18
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
```

## Apply — body section replacement for FEAT-551.md

```markdown
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
```
