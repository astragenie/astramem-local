---
id: PM-REVIEW-FEAT-442
feature: FEAT-442
reviewed_at: 2026-07-08
pm_customer_impact: 0.4
pm_effort_estimate: 0.35
pm_strategic_alignment: 0.75
pm_technical_risk: 0.5
pm_dependency_depth: 0.15
composite_priority: P2
autonomous_safe: false
---
# PM Review — FEAT-442

## Demand Assessment

- **Evidence:** No direct end-user complaint or stakeholder quote — this is competitive-narrative evidence, not reported pain. FEAT body cites '2026-07-08 ecosystem research D4 month-3 differentiation' and docs/research/2026-07-08-astramem-ecosystem-report.md line 157 confirms it verbatim: 'autonomous consolidation on the existing proposal flow (auto-accept above confidence, human gate below)' under 'Month 3 — differentiation'. Indirect efficiency-value evidence exists secondhand: the prior PM review for FEAT-441 (.claude/artifacts/loop/pm-reviews/20260707T180000Z-pm-review-feat-441.md) quotes a since-resolved/unfiled FEAT-437 as showing '158-162 pending consolidation merge proposals with zero manual review throughput' — I could not independently verify this because no FEAT-437 file exists on disk anymore (grep across .claude/artifacts/loop/backlog turned up nothing outside worktree copies of FEAT-441 itself), so I am treating it as secondhand/unconfirmed rather than primary evidence. customer_impact reflects real-but-indirect efficiency value (reduces a manual review backlog if the secondhand claim is accurate) rather than confirmed user pain, hence capped at 0.40.

## Scope Challenge

- **Scope notes:** Read src/consolidate/consolidate.ts in full (307 lines): the two-threshold design (mergeThreshold auto / proposeThreshold gate) is exactly as described, well-factored, and already event-sources merges via MemoryEventRepo.supersede (src/storage/memory-events.ts:112-124 mergeAsSupersede). Concrete finding that changes scope: the FEAT's own claim that auto-accepted merges are 'reversible' is NOT currently true. I read src/storage/memory-events.ts:262-278 — restore() explicitly throws MemoryConflictError when the target atom's `archived` flag is not 1 ('memory ${atomId} is not archived'); supersede() never sets `archived`, only `valid_to`/`superseded_by`. There is no existing un-supersede/un-merge primitive today. Building the third confidence band without adding one would ship an 'audit trail' that records what happened but no working way to reverse it — the FEAT's own core promise. This is real, in-scope work the FEAT body does not budget for. Smallest deliverable if scope were halved: ship the new confidence-band config knob (default off) + the auto-accept path reusing the EXISTING supersede/event-sourcing exactly as-is, and explicitly scope the un-supersede/reversal primitive as a fast-follow with a documented known-gap — but given 'reversible' is the FEAT's stated differentiator vs Supermemory's opaque auto-merge, shipping without it undercuts the entire positioning, so I would not recommend cutting it silently. No cost analog found in .claude/artifacts/crew/cost/: no aggregate report touches consolidation/memory-events; nearest single-module analogs (FEAT-420/421 cost reports) show $0/0-sessions-scanned (unattributed local-worktree runs), so 'no cost analog' per Framework 5. Weak grade dimensions per loop-snapshot.md (last-5-grade averages): architecture_quality 0.53, observability 0.68, production_readiness 0.53, security 0.52, product_completeness 0.55 (all below the 0.80 threshold; test_confidence 0.878 and reliability 0.88 are healthy) — caveat: two of the five graded slices (SLICE-416/417) have placeholder/unfilled grade bodies ('bullet 1', 'bullet 2') so the average is partly noise, but I am applying the rule as instructed rather than discounting it. Since this FEAT is not P0/P1 and no --deep/--spec flag was passed, no ACs are drafted now, but a future slicing pass MUST include an observability AC (auto-accept events distinctly logged/countable, not indistinguishable from human-gated merges in memory_events) given observability is a named weak dimension.

## Scores

- customer_impact: 0.40
- effort_estimate: 0.35
- strategic_alignment: 0.75
- technical_risk: 0.50
- dependency_depth: 0.15

## Priority Derivation

composite_priority: P2
autonomous_safe: false
reasoning: P2 via formula: impact 0.40 < 0.70 and alignment 0.75 < 0.80, so neither P1 branch fires; effort 0.35 < 0.70 so P3 doesn't fire either. technical_risk banded at 0.50 (top of the 0.3-0.5 'new pattern / one module, no contract change, clean rollback' band) — single-module extension of consolidate.ts + memory-events.ts, no new external dependency, no schema migration required to ship (default off), but scored at the band's ceiling rather than its middle because the FEAT's own audit/reversal claim has a confirmed gap (no un-supersede primitive exists) that is real scope, not because of any schema change. composite_score=0.5875. pm_effort_points=3 (band [0.25,0.4)) — well under the FEAT-168 decomposition threshold of 8, no proposed_slices needed. autonomous_safe=false because no AC/spec exists yet (P2, no --deep/--spec flag) — not a risk-threshold override; all three mechanical thresholds (risk 0.50, effort 0.35, dependency 0.15) individually pass.

## Risks

- Cascade risk (Framework 3): auto-accept sits on the consolidation write path, which runs as a periodic offline job over the whole corpus — a mistuned threshold or a bug in the new band's winner-selection logic could silently supersede many atoms in one run before anyone notices, unlike the current human-gated propose queue which caps blast radius to one decision at a time.
- Reversal-primitive gap (see scopeNotes): MemoryEventRepo.restore() only reverses archive(), not supersede() — confirmed by direct read of src/storage/memory-events.ts. Shipping the auto-accept band without a working un-supersede path means 'reversible' is aspirational, not actual, at ship time.
- Default-off mitigates most exposure at launch (config knob ships disabled), but if a future slice flips the default without re-verifying the reversal gap above, the risk surfaces silently.
