# Astramem-local wave program (2026-07-23)

Autonomous multi-wave program. Operator delegated full execution in recommended order (2026-07-23), ending with a summary + release. Strategic basis: 6-review campaign (Codex + 2 architect-reviewers on the plan, 2 Fable-model architects on the codebase, quick-wins reviewer) — synthesis in `docs/specs/20260723-codebase-refactor-plan.md` + the session log.

## Strategic reframe (the north star)
- **Retrieval is proven capped** (oracle-factorial: retrieval −0.007; extraction −0.058; ~87% of the gap to Zep is the answerer/evidence-sufficiency layer). Five same-store retrieval A/Bs all washed. STOP investing in retrieval ranking/fusion.
- **Score lives in extraction (Wave 5, addressable) + the answerer (Wave 6, biggest lever).**
- **OPERATOR DECISION 2026-07-23: stronger answerer PERMITTED** (cheap-answerer-only constraint lifted for milestone measurements + as a product option). This unlocks Wave 6 — the 87% lever. Supersedes the prior `eval-cheap-stack-only` posture for answerer (judge stays cheap unless separately approved).

## Waves (waves 1-2 already done: retrieval-overhaul → PR #456; quick-wins qw/* merged into feat)

| Wave | Theme | Key items | Depends on | Score |
|---|---|---|---|---|
| **3 · Hygiene + reliability** | close real bugs, ~0 risk | 2a indexes (corrected defs + id-tiebreaker) · embed retryAfterMs · 9-checks tier-correct (+FULL lock) · codex-subscription retry · **memory_events rotation** (new bug: grows on READ) · N+1s (oversize, timeline) · results.find→Map · CLI arg-parse · RunCapTracker(3 sites) · chunkedIn · dashboard real-config · governance-unify + drop test-only loadConfig | none | 0 |
| **4 · Measurement trust** | make "is this lever real" mechanical | `compare(A,B,repeats≥3)` significance harness (compose Track E scripts + paired-CI) above the ±6 noise | none | 0 (gates 5/6) |
| **5 · Extraction quality** | addressable score lever (−0.058) | investigate gold-turns→gold-atoms loss · future-relative grounding (both halves: regex + prompt template, measured) · date-survival · invalid_at/entity/relation gaps · atom-granularity for multi-hop | Wave 4 | near-term measured gains |
| **6 · Answerer + evidence** | the 87% lever (UNLOCKED) | stronger-answerer A/B (milestone) · evidence-sufficiency = #6 multi-scope (path past 0.526 gold-turns ceiling, selective post-rerank enrichment) | Wave 4 + answerer-unlock ✓ | the big one |
| **7 · Structural velocity/reliability** | compounding (not score) | yield-ledger (1 recordStageOutcome + 1 check vs 17+ guard-drop tables) · config+provider-role registry · boot double-DB-open fix (real crashloop root) | none | 0 |
| **Release** | ship it | consolidate to main, full-suite validation, version bump + tag + npm publish (docs/runbooks/release-publish.md) | all waves | — |

## Sequencing
Wave 3 + Wave 4 in parallel now (no deps) → Wave 5 (extraction, gated by 4) → Wave 6 (answerer, unlocked) → Wave 7 (structural, by capacity) → Release. Deferred/measured (not their own wave): embed batching, fan-out concurrency, config.ts split — run through Wave 4's harness.

## Cut (do NOT build — reviewers killed these)
performSearch unification (wire-shape collapse, #1 risk) · guard-log factories · all big file-splits (config.ts maybe, own PR, last) · stmt.iterate · EXTRACTION_STRICT_PROMPT activation via this program · pricing guesswork · Redis/BullMQ queue swap · doctor auto-discovery.

## Operating rules
FEAT-439 hook stays OFF through all merges. Every retrieval/fusion/extraction touch gated by ADR-005 floors + retrieval-eval. Score claims require Wave-4 significance (median of ≥3, above ±6 noise) — no single-run "levers". Durable handoff per wave. No prod touch except the final release (operator-gated).

## Status log
- 2026-07-23: program approved; roadmap persisted; consolidating wave-2 → launching Wave 3 + Wave 4.
