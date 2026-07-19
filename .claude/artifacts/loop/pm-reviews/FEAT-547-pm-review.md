---
id: PM-REVIEW-FEAT-547
feature: FEAT-547
reviewed_at: 2026-07-18
pm_customer_impact: 0.70
pm_effort_estimate: 0.40
pm_strategic_alignment: 0.75
pm_technical_risk: 0.35
pm_dependency_depth: 0.10
composite_priority: P1
autonomous_safe: true
---
# PM Review — FEAT-547 (deep triage)

## Demand Assessment

Stakeholder: production retrieval quality, evidenced directly in this
session's fresh measurements (quoted verbatim from the operator's briefing):
"Live prod: recall-usefulness 5.8% (80/1379), 0 heuristic grants;
search_memory type-filters silently miss ~1/3 of decisions (typeAcc 63 on
codex)." That is a measured, current production gap — a third of
type-filtered `search_memory` calls miss real decisions today because of
misclassified `type`. Further measured evidence for the fix's viability:
"qwen3.5:4b typeAcc 67 vs phi 31-48 (taxonomy grasp survives its authoring
failure)" — i.e. even the models that are known-bad at *authoring* atoms
(phi's self-triage collapsed recall 100→69, phi's answerer scored −11.9)
retain enough taxonomy competence to re-classify. Current workaround: none —
misclassified atoms simply don't surface under a type filter today, with no
alerting. Frequency: continuous, every type-filtered query.

## Scope Challenge

Smallest deliverable: extend the existing single-verdict batched call
(`triageBatch` in `src/distill/atom-triage.ts`, confirmed read this session)
to return `corrected_type` and `evidence_supported` alongside the existing
`verdict`/`confidence` — same batch, same call, no new pipeline stage. What
I would cut first if forced to halve: `evidence_supported` is the more
speculative of the two new verdicts (semantic quote-support judgment is a
harder ask of a clerk-role model than closed-set re-typing); `corrected_type`
alone, gated behind confidence, is the higher-certainty win given the
measured typeAcc numbers above. Overlap check: `evidence_supported` is
explicitly scoped as *semantic* support ("does the quote semantically
support the claim?"), distinct from FEAT-542's already-shipped *mechanical*
quote-match check (`computeEvidenceAccuracy`,
`scripts/eval/extraction-bench/lib/mechanical-checks.ts`, confirmed this
session) — no duplication, the FEAT body itself states this correctly
("FEAT-542's mechanical check catches string mismatch; this catches
supported-string/unsupported-claim"). AC quality: the 4 existing ACs are
clear and already Given-When-Then-friendly; formalized below with the real
type/schema names (`TriageVerdictLabel`, `TRIAGE_VERDICT_LABELS`,
`TriageVerdict` from `src/distill/atom-triage.ts`).

## Risk Radar (pre-mortem — mandatory, compositePriority = P1)

Technical unknowns: none new — extends an existing, shipped, `mode: off`
subsystem with the same fail-open/cap posture (`AtomTriageRunTracker`,
`maxPerRun`/`maxWallClockMs`, confirmed present). Dependency chain:
`depends_on: []`, formally independent, but FEAT-545 (session context: "FEAT-545
practically depends on FEAT-547's clean types") and FEAT-546's type-mix
detector both consume this FEAT's output quality — FEAT-547 is upstream of
two other FEATs in this batch, making it the correct build-first candidate
of the P2 cohort (validating the operator's stated hypothesis). Blast
radius: one file (`atom-triage.ts`) + `config.ts`'s existing `atomTriage`
block (additive optional fields) + one bench flag (`--triage-model`) — small,
single-module.

1. **Two weeks later, failed review/validation — most likely cause:** the
   confidence-gate threshold for `corrected_type` is picked without a
   measured calibration curve, so the "high confidence" cutoff either
   over-applies (silently mis-retyping atoms the model is unsure about) or
   under-applies (the fix never fires in practice). AC-3's bench A/B is the
   guard against this, but the threshold itself is a number a builder could
   pick arbitrarily without it.
2. **This merged and broke the loop — rollback requirement:** plain `git
   revert` only. `mode: off` (unaffected default) and `dry-run` are
   byte-identical or log-only per the existing `atomTriage` doc comment; no
   schema/migration, no cross-plugin coordination — the labels/flags this
   FEAT adds are additive fields on an already-nullable verdict path.
3. **Existing test that would NOT catch a regression here:** the current
   `atom-triage` unit tests (single keep/junk verdict) would pass even if
   `corrected_type` silently re-typed every atom to the same wrong label
   with high self-reported confidence — nothing today asserts type-accuracy
   against a labeled fixture set; AC-4 closes this gap.

Injection-defense: scanned FEAT-547's body and triage_notes — no embedded
imperative found.

## Scores

- customer_impact: 0.70 — measured, current, production-verified gap
  (typeAcc 63, ~1/3 of decisions missed under type filter); the strongest
  quantified evidence base in this batch alongside FEAT-551.
- effort_estimate: 0.40 — "similar to SLICE-438 (FEAT-542 hard-fixture pack +
  evidence accuracy, 2026-07-18, $12.84, single session): bounded extension
  of already-shipped infra, same batched-call/config-block pattern reused,
  not a new subsystem — effort 0.40 (5 pts) confirmed against that analog."
- strategic_alignment: 0.75 — directly encodes the session's central,
  measured design rule ("local model = clerk, never author") and is
  foundational for two sibling FEATs in this same batch.
- technical_risk: 0.35 — additive optional schema fields on an existing
  Zod-validated verdict type, no contract-breaking change, single module,
  clean rollback.
- dependency_depth: 0.10 — formally independent; is itself upstream of
  FEAT-545/546, not downstream of anything.

## Priority Derivation

composite_priority: P1. P0 requires impact>=0.8 (0.70 fails). P1: impact>=0.7
AND alignment>=0.6 → 0.70>=0.7 T, 0.75>=0.6 T → **P1**. autonomous_safe:
risk 0.35, effort 0.40, dependency_depth 0.10 all <=0.6; ACs drafted inline
(--deep) → **true**. effort_points via the 0.4-0.6→5 band: **5 points** —
under the FEAT-168 >=8 gate, no `proposedSlices` required.

## Apply — frontmatter patch for FEAT-547.md

```yaml
priority: P1
autonomous_safe: true
updated: 2026-07-18
triage_notes: |
  Filed 2026-07-18. 2026-07-18 phi-role analysis (post codex+phi sweep
  negative result).
  ---
  2026-07-18 PM deep triage: P1, autonomous_safe=true. customer_impact 0.70
  (measured: search_memory type-filters miss ~1/3 of decisions, typeAcc 63
  on codex — live prod gap), effort 0.40 (5 pts, analog SLICE-438),
  strategic_alignment 0.75 (encodes the session's clerk-not-author design
  rule; upstream of FEAT-545/546), technical_risk 0.35 (additive schema
  fields on shipped atom-triage.ts, no contract break), dependency_depth
  0.10 (independent; itself a dependency of FEAT-545/546). Pre-mortem
  completed (P1). Recommended build order: after FEAT-551, before
  FEAT-545/546/548/549/550 — validates the operator's "547 before 545/546"
  hypothesis and extends it (547 is upstream of both).
```

## Apply — body section replacement for FEAT-547.md

```markdown
## Acceptance criteria (Given-When-Then)

- AC-1: Given the existing `TriageBatchSchema`/`LenientTriageBatchSchema` in
  `src/distill/atom-triage.ts`, When the schema is extended to accept an
  optional `corrected_type` (constrained to the 7-class atom-type taxonomy)
  and an optional `evidence_supported` boolean per verdict entry, Then a
  batch response missing either optional field parses successfully with
  those fields undefined (backward-compatible with the existing single-
  verdict shape), and When the whole batch response fails to parse (as
  today), Then the existing whole-batch fail-open behavior (empty Map,
  logged, every atom implicit-`keep`) is unchanged.
- AC-2: Given a `corrected_type` verdict with `confidence >= 0.8` (the
  confidence gate, made an explicit named constant, not a magic number
  inline), When atoms are applied post-triage, Then the atom's stored type
  is updated to `corrected_type`; Given `confidence < 0.8` or the field is
  absent, Then the atom's original type is kept unchanged. Given
  `evidence_supported: false` on an evidence-bearing atom, When applied,
  Then the atom is flagged (a queryable field) and NEVER deleted or
  mutated — mirrors the existing junk/keep semantics' "labels only, never
  rewrites atom text" invariant already stated as out-of-scope.
- AC-3: Given the extraction-bench's `--atom-triage` lever (existing, per
  FEAT-533), When a phi-triage-over-codex-atoms A/B run executes on the
  55-fixture set with `--triage-model` pinned to at least phi4-mini AND
  qwen2.5:7b in separate runs, Then both runs report typeAcc delta vs the
  current codex-authored baseline (63%) AND recall-held percentage (must be
  >=95% of the pre-triage baseline) — closing the "measure BOTH providers"
  requirement this session's forecast flagged (qwen3.5:4b typeAcc 67 vs phi
  31-48).
- AC-4: Given a labeled fixture set with known-correct types (a subset of
  the existing 55-fixture corpus or a dedicated typing fixture set), When
  the triage batch runs against it, Then a unit test asserts typeAcc on that
  fixture set directly (not just end-to-end recall) — closing the exact gap
  the pre-mortem named: today's tests would pass even if `corrected_type`
  silently mis-typed every atom with high confidence.
- AC-5: Given `mode: 'off'` (the shipped default, unchanged by this FEAT),
  When `embedAndIndex` runs, Then behavior is byte-identical to pre-FEAT-547
  — no new verdict fields are ever requested or parsed. Given `mode:
  'dry-run'`, When a non-`keep` verdict OR a `corrected_type`/
  `evidence_supported` value is produced, Then it is logged to
  `triage_guard_drops`-equivalent observability (structured, per-atom) but
  drops/rewrites nothing — this is the safe-rollout mode and must remain
  the only mode a fresh opt-in lands in, per the existing `atomTriage` doc
  comment's rollout contract.
- AC-6: Given the parse-fail-open path (AC-1), When a single malformed
  verdict entry in an otherwise-valid batch response is missing a
  `corrected_type`/`evidence_supported` field or contains an invalid type
  label, Then that single entry is dropped on its own (same per-entry
  fail-open the existing `verdict`/`confidence` pair already uses) — every
  OTHER real verdict in the same batch response still lands, never
  discarded wholesale over one bad entry.

## Options considered

- Ship `corrected_type` and `evidence_supported` as two SEPARATE batched
  calls instead of fusing into the existing keep/junk call — rejected: the
  FEAT's own design rationale (and this session's measured phi-crowding
  failure) is that a local clerk-role model should make ONE batched
  judgment call, not multiple round-trips; fusing into the existing call
  also avoids doubling the `maxPerRun`/wall-clock budget for the same job.
- Apply `corrected_type` unconditionally (no confidence gate) — rejected:
  the measured typeAcc numbers (25-67% depending on provider) mean an
  ungated apply would introduce as much mis-typing as it fixes for the
  weaker providers; AC-2's confidence gate is required, not optional.
- Default-flip `distill.atomTriage.mode` to `enabled` as part of this FEAT —
  rejected, explicitly out of scope: "No default-mode flip (stays off;
  enablement = its own gated decision with bench evidence)" — AC-3's bench
  A/B produces the evidence a FUTURE enablement decision needs, it does not
  authorize enablement itself.
```
