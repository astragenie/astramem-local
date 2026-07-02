# ADR-004: Formation Pipeline — keep the 8 stages, add redaction (0) and consolidation (9)

**Status:** accepted · **Date:** 2026-07-02 · **Confidence:** High
**Context:** The 8-stage distill pipeline (cleanup → normalize → chunk → compact → extract →
reduce → memory-normalize → embed+index) is the company's most differentiated asset (strategy
Pass 1). Known defects D-DEF1 (turn-flattening) / D-DEF2 (summary_memory_id). SEC-3..5 mandates
ingest-boundary redaction. Strategy Pass 3 P2 identifies consolidation as the highest-value
extension.

## Decision

Keep the staged architecture. Formalize and extend:

1. **Typed stage contract.** Every stage declares `(InputT) → OutputT`, is deterministic given
   its inputs + model version, and is **replayable**: redacted transcripts are retained
   (ADR-002), so the pipeline can re-run end-to-end after extractor/model/schema upgrades —
   re-distillation is a first-class capability, not a migration hack.
2. **Stage 0 — Redaction (NEW, SEC-3..5):** runs at the ingest choke point *before* transcript
   persistence and therefore before any cloud-LLM egress. Pattern + entropy detectors, stable
   `[REDACTED:type:hash8]` placeholders, counts-only redaction log. One choke point; all
   downstream stages inherit.
3. **Stages 1–8:** unchanged in shape. Fix D-DEF1/D-DEF2 as quality-floor work (90-day plan #2).
   Extraction (stage 5) emits ADR-001 atoms with `evidence` spans mandatory.
4. **Stage 9 — Consolidation (NEW, periodic offline job, not per-ingest):**
   re-reads accumulated atoms per project/repo and emits: (a) merged near-duplicates,
   (b) second-order abstractions (`lesson` atoms with `derived_from` lineage),
   (c) **contradiction proposals** — candidate supersessions surfaced as *propose-only* events
   requiring user confirm (strategy Pass 6 A4: auto-invalidation is trust-destroying).
   Uses the existing `jobs` table; budget-capped like every LLM stage.
5. **Verification hooks:** extraction quality fixtures (input transcript → expected atoms) run in
   CI; redaction false-positive/negative fixtures likewise (SEC spec test strategy). The pipeline
   is testable *as an architecture property*, not by sampling.

**Plugin points (deliberately narrow, C1):** capture connectors (new sources in, ADR-008) and
custom extractors (new atom types out). Core stages 0–4 and 6–9 are NOT pluggable in v1 — every
extension point is a support surface.

## Options considered

1. **Staged, typed, replayable pipeline (chosen).** It exists, it's the moat, it composes.
2. **Single-pass "LLM does everything" extraction.** Rejected: unmeasurable, unreplayable,
   undebuggable; quality regressions become vibes instead of fixture diffs.
3. **Fully pluggable pipeline framework.** Rejected: framework-building against C1; no user has
   asked; the two real extension needs (sources, types) are covered narrowly.

## Consequences & migration

- Ordered work: D-DEF fixes → stage 0 (with SEC implementation) → stage contracts + fixtures →
  stage 9 (post-launch, per migration map).
- Replayability requires transcript retention default (90d) to be documented in the privacy
  model (ADR-009) — retention and erase-requests override replay.
