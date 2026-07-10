---
id: PM-REVIEW-FEAT-455
feature: FEAT-455
reviewed_at: 2026-07-09
pm_customer_impact: 0.45
pm_effort_estimate: 0.52
pm_strategic_alignment: 0.55
pm_technical_risk: 0.9
pm_dependency_depth: 0.2
composite_priority: P2
autonomous_safe: false
---
# PM Review — FEAT-455

## Demand Assessment

- **Evidence:** Competitive evidence, not a first-party user request: docs/research/2026-07-09-competitor-gap-analysis.md, 'Gaps to close' gap #5: 'mem0 (LLM proxy) and Supermemory auto-capture memories by sitting in the request path -- no explicit save call. Lowest-friction path to "it just remembers," a repeatedly-cited adoption driver.' The FEAT body itself flags the risk explicitly: 'Gate the spike behind a privacy/security review before building -- this feature observes model traffic.'

## Scope Challenge

- **Scope notes:** Effort 0.52 -> 5 points (FEAT-167 table), below the decomposition gate on effort alone -- but technical_risk (0.9) is the dominant concern here, not effort. No cost analog for a traffic-interception design spike on file; the FEAT's own scope explicitly front-loads 'Design decision (spike first): MCP passthrough tap vs local LLM proxy... vs enriched hook capture' before any implementation cost is knowable, which is itself evidence this is spike-gated work, not estimatable from history. Weak grade dimensions apply as noted on FEAT-451 -- security is one of the five weak dimensions (0.51 true last-5 average), which combined with this FEAT's inherent privacy exposure is the primary reason autonomous_safe is false here, per the operator's explicit instruction to flag this FEAT for a security/privacy review. Local-only by design (cross_product frontmatter correctly omits 'memory' -- matches the FEAT body's own 'Scope -- LOCAL-SPECIFIC' framing, consistent with the operator's batch note that 455 is local-only).

## Scores

- customer_impact: 0.45
- effort_estimate: 0.52
- strategic_alignment: 0.55
- technical_risk: 0.90
- dependency_depth: 0.20

## Priority Derivation

composite_priority: P2
autonomous_safe: false
reasoning: technical_risk 0.9 sits in the top band (0.9-1.0: 'unknowns needing a spike') because the FEAT body itself mandates a pre-build design spike to choose the interception mechanism, and the mechanism observes live agent<->LLM/MCP traffic -- a privacy-sensitive, hard-to-fully-reverse trust surface even though the code path itself is revertable. Real adoption-driver value but explicitly gated -- P2, autonomous_safe FALSE per the operator's direction pending a dedicated security/privacy review before any build dispatch.

## Risks

- Pre-mortem (technical_risk >= 0.6, mandatory) 1 -- fails review: the interception mechanism chosen at the design spike (MCP tap vs LLM proxy vs enriched hook) turns out to observe more traffic than intended -- e.g. captures content from a session the user believed was NOT being remembered -- a scope/consent violation the spike didn't fully specify before build started.
- Pre-mortem 2 -- rollback: revert-only for the CODE path if strictly opt-in/default-off as specified. But if captured content was already ingested into the durable spool (FEAT-449, already shipped) before rollback, that data is not automatically purged by a git revert -- rollback of code does not equal rollback of already-captured data, which is the actual privacy exposure.
- Pre-mortem 3 -- coverage gap: the existing ingest/idempotency test suite (59 pre-existing tests per the FEAT-449 grade) covers /ingest/transcript correctness but says nothing about consent/opt-in state -- a regression that silently flips auto-capture on for a user who never opted in would pass every existing test today.
