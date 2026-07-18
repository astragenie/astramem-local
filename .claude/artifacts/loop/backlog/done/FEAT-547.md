---
id: FEAT-547
status: done
priority: P1
category: feature
target_release: null
created: 2026-07-18
updated: 2026-07-18
depends_on: []
slices: []
derived_from: 2026-07-18 phi-role analysis (post codex+phi sweep negative result)
cross_product: [astramem-local]
autonomous_safe: true
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
---
## Description

**Atom-triage v2 — multi-verdict batched call (junk + type-repair + evidence-support), local-model-friendly.**

Extend FEAT-533's existing batched atom-triage (`src/distill/atom-triage.ts`, shipped `mode: off`) from a single keep/junk verdict to three verdicts per atom in the SAME batched call:

1. **keep/junk** (existing labels unchanged).
2. **corrected_type** (optional): 7-class constrained re-label — measured typeAcc: codex 63%, qwen2.5:7b 25-48%, phi 31-48%; classification is far easier than generation, so a focused re-typing pass should beat inline typing. Applied only when confidence high; original type kept otherwise.
3. **evidence_supported** (optional, only for evidence-bearing atoms): does the quote semantically support the claim? (FEAT-542's mechanical check catches string mismatch; this catches supported-string/unsupported-claim.) Flags, never deletes.

Provider: configurable (`distill.atomTriage.provider/model` already exist) — designed for a cheap local model (phi4-mini: 20s/session class). Fail-open posture unchanged (broken triage = implicit keep-all, loud log, ADR-015). Caps unchanged (batchSize/maxPerRun/maxWallClockMs).

Measured guardrail: phi SELF-triage on its own atoms was recall-destructive (100→69, 2026-07-17) — v2 must be measured cross-model (phi triaging CODEX atoms) on the extraction bench before any default flip; the bench's --atom-triage lever exists.

## Explicitly out of scope
- No new atoms, no rewriting atom text (labels/flags only).
- No default-mode flip (stays off; enablement = its own gated decision with bench evidence).

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

## Wave outcome (2026-07-18)

2026-07-18 WAVE COMPLETE: built (SLICE-441, tip dd0e1a3a), review approved_with_notes (0 CRIT/HIGH). MEASURED (5fx A/B): keep/junk verdict costs ~40 recall with BOTH clerks (phi 94->54, 4b 94->58) — NO-ENABLE as-is; phi BEATS 4b at type-repair (typeAcc 58 vs 42; 4b forecast inverted). Follow-up: repair-only triage mode (apply corrected_type, skip keep/junk).
