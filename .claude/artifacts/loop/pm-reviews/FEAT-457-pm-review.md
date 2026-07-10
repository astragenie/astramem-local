---
id: PM-REVIEW-FEAT-457
feature: FEAT-457
reviewed_at: 2026-07-10
pm_customer_impact: 0.4
pm_effort_estimate: 0.45
pm_strategic_alignment: 0.55
pm_technical_risk: 0.35
pm_dependency_depth: 0.15
composite_priority: P2
autonomous_safe: false
---
# PM Review — FEAT-457

## Demand Assessment

- **Evidence:** Quoted from the FEAT body / derived_from doc: docs/research/2026-07-09-packaging-audit.md named 'publish one honest external eval number (LongMemEval/LoCoMo)' as 'the single item that must happen before an announcement and the biggest lever on the competitive score.' Competitive citation: 'Competitors quote LoCoMo (Zep/Graphiti cite 63.8% -- not repo-reproducible per the gap analysis; mem0 quotes LoCoMo in its paper).' However the FEAT's OWN 'Sequencing consideration' section undercuts urgency for THIS specific deliverable: 'LongMemEval has NEVER produced a published number from this repo (docs/eval/methodology.md:91-95). Running LongMemEval's existing non-temporal ~58% may be the faster path to the packaging audit's actual goal... than building LoCoMo first.' This is real, evidenced demand for 'publish a number' in general, but weak/discounted demand specifically for 'build a new LoCoMo harness now' -- the FEAT itself names a cheaper substitute for the actual business goal.

## Scope Challenge

- **Scope notes:** AC clarity: no formal Given-When-Then ACs in the body -- prose scope bullets + an ETA breakdown + explicit 'Architecture review corrections' section (already unusually thorough for a P2, but not GWT-formatted) -- vague per the authoring.md checklist; not P0/P1 and no --deep/--spec flag passed, so acs: [] per the priority-gating table (not a scoring omission). Weak grade dimensions (true last-5 average, same recomputation as FEAT-459/458): architecture_quality 0.51, observability 0.654, production_readiness 0.504, security 0.51, product_completeness 0.504 all below 0.80 -- this FEAT's own body states 'Contract / cloud impact: None -- eval infrastructure only, no product code path, no wire change,' so none of these weak dimensions are load-bearing here; noted per Framework 4 for completeness only. Effort calibration: no exact eval-harness cost analog on file (FEAT-419/420/421 SLICE-413/414/415 cost reports show usd:0/tokens:0 -- an aggregation gap, not a true zero). Nearest shape is the FEAT-450 precedent ('eval-bench hardening... nearest shape by module count is FEAT-449 (single-module, $72.34/1 session) but spans more ACs... scored above that floor,' landing at 0.42->5pts). FEAT-457 is a full parallel-harness build (new loader + new judge-layer authorship + new ingest/answer drivers + repro doc), comparable in shape to FEAT-450's 'above the floor' framing but for a materially larger scope (a second full eval pipeline vs. hardening an existing one) -- scored at 0.45 -> 5 effort_points (FEAT-167 band [0.4,0.6)), matching the FEAT's own 4-5.5 day ETA; well under the FEAT-168 8-point decomposition gate. technical_risk banded at 0.35 (0.3-0.5 band, 'new pattern in repo OR one module, no contract change, clean rollback'): the judge-scoring layer is genuinely new authorship (the FEAT's own body: 'Judge layer is new authorship, not reuse... expect the same fork-upstream-and-discover-incompatibilities work'), but the plumbing tier is explicitly reused unforked (spawn-daemon etc.), there is zero product code path or wire/contract impact, and the whole deliverable is a new, independently discardable directory (scripts/eval/locomo/) -- clean rollback. No overlap found with FEAT-450 (eval-bench hardening of the EXISTING LongMemEval harness) or any other triaged/in-progress FEAT -- this is a genuinely new, non-duplicative harness.

## Scores

- customer_impact: 0.40
- effort_estimate: 0.45
- strategic_alignment: 0.55
- technical_risk: 0.35
- dependency_depth: 0.15

## Priority Derivation

composite_priority: P2
autonomous_safe: false
reasoning: P2 via formula (default branch): impact 0.40 < 0.70 so the (impact>=0.7 AND alignment>=0.6) P1 branch does not fire; alignment 0.55 < 0.80 so the (alignment>=0.8 AND effort<=0.4) P1 branch does not fire; effort 0.45 < 0.70 so P3 (effort>=0.7 AND impact<=0.3) does not fire. composite_score = 0.40*0.35 + 0.55*0.30 + (1-0.45)*0.20 + (1-0.35)*0.10 + (1-0.15)*0.05 = 0.5225. autonomousSafe=false: all three mechanical thresholds individually pass (risk 0.35, effort 0.45, dependency 0.15 all <=0.6) but no AC/spec exists on the body and P2-with-no-flag means inline AC drafting is not triggered -- forced false by the missing-AC branch, not a risk-threshold override. Moderate-priority eval-infra item, exactly as the coordinator framed it: the FEAT's own sequencing section is the load-bearing reason this isn't scored higher despite genuine external-credibility value.

## Risks

- Sequencing risk (from the FEAT's own body, load-bearing): building LoCoMo end-to-end (4-5.5 days) before ever publishing a LongMemEval number risks spending the full eval-infra budget without closing the packaging audit's actual gate ('publish one honest external eval number') any faster than a same-week LongMemEval publish would. Recommend an operator decision on sequencing (publish LongMemEval first, THEN slice this) before dispatch, independent of this FEAT's own priority score.
- Temporal-category footgun (from the FEAT body): the as_of/temporal daemon gap is stated as fixed in 0.9.0, but the FEAT's own text notes the prior 'verified live' test ran against a NOT-yet-reinstalled daemon 31 seconds after the fix commit -- a slice building on this FEAT must re-verify end-to-end against a freshly-reinstalled >=0.10.0 daemon before including temporal-category scores in any published number, or risk publishing a stale/invalid figure.
- Judge-layer authorship risk: the FEAT's own body flags 'expect the same fork-upstream-and-discover-incompatibilities work LongMemEval's judge took' -- this is the least-scoped, least-predictable part of the ETA and the most likely source of overrun if a slice is dispatched without a timeboxed spike for the F1/token-overlap scoring categories specifically.
- Licensing note (low severity, already correctly scoped in the FEAT body): LoCoMo is CC BY-NC 4.0; .eval-data/ is gitignored so no redistribution risk, but the repro doc's attribution requirement must not be dropped by a slice that treats this as boilerplate.
- Injection-defense check: FEAT body read in full -- no embedded imperative instructions found; nothing to quote here.
