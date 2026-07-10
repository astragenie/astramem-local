---
id: FEAT-458
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: [FEAT-455]
slices: []
derived_from: docs/adr/ADR-012-auto-capture-security-model.md
cross_product: [astramem-local]
pm_customer_impact: 0.55
pm_effort_estimate: 0.62
pm_strategic_alignment: 0.65
pm_technical_risk: 0.85
pm_dependency_depth: 0.75
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-10
autonomous_safe: false
triage_notes: "P2 via formula (default branch): impact 0.55 < 0.70 so the (impact>=0.7 AND alignment>=0.6) P1 branch does not fire; alignment 0.65 < 0.80 so the (alignment>=0.8 AND effort<=0.4) P1 branch does not fire either; effort 0.62 < 0.70 so P3 (effort>=0.7 AND impact<=0.3) does not fire. composite_score = 0.55*0.35 + 0.65*0.30 + (1-0.62)*0.20 + (1-0.85)*0.10 + (1-0.75)*0.05 = 0.491. technical_risk banded at 0.85 (top rubric band: hot-path proxy sees full system prompts + every turn, byte-transparent-forwarding invariant is hard-to-reverse-if-violated, and the FEAT's OWN scope mandates a pre-build STRIDE/latency/failure-mode spike -- same shape as FEAT-455's own 0.9 score for the same underlying capture-mechanism-choice reason). autonomousSafe=false is forced THREE independent ways (any one alone is sufficient): technical_risk 0.85 > 0.6, effort_estimate 0.62 > 0.6, dependency_depth 0.75 > 0.6 -- exactly matching the coordinator's explicit requirement that this must not be autonomous_safe=true."
---
## Description

**LLM proxy/router auto-capture (mem0-style traffic interception)** — an
OpenAI-compatible `/v1/chat/completions` middleman the user can point their
agents at; the router forwards to the real provider and passively captures
memory-worthy content from the traffic it relays.

**Why:** completes auto-capture coverage beyond FEAT-455's hook-tap tier —
catches agents/tools that produce no transcript hooks at all (any OpenAI-SDK
client becomes capturable by changing one base URL). mem0 ships this as its
primary capture mechanism.

**Explicitly deferred by ADR-012** (tier 3): maximal blast radius (sees full
system prompts + every turn — highest secret density), sits in the hot path of
every LLM call (a capture bug = every agent turn hangs; real SPOF/latency
surface). This FEAT exists so the deferral is tracked, not forgotten.

### Hard gates (from ADR-012 — non-negotiable before slicing)
1. Its OWN security ADR (do not reuse ADR-012's hook-tap analysis): STRIDE pass
   for a hot-path proxy, TLS/credential handling for forwarded provider keys,
   failure-mode analysis (proxy down ≠ agent down — pass-through-on-error or
   fail-closed decision), latency budget (<10ms added p50 target).
2. FEAT-455 hook-tap must be SHIPPED and its scrub gate proven in production
   use first — the proxy inherits and amplifies every capture-path risk.
3. Strict side-channel invariant: the proxy NEVER mutates the in-flight
   request/response (byte-transparent forwarding; capture is an async fork).

### Scope sketch (post-gates)
- `astramem-local proxy serve --port N --upstream <url>` — local-only bind by
  default, streaming (SSE) transparent pass-through.
- Capture fork: reuse the FEAT-455 source-side relevance gate + durable ingest
  spool (FEAT-449); provenance tag `capture_source: 'proxy'`.
- Default OFF; doctor WARN row when on (same disclosure pattern as hook-tap);
  disable flow offers purge.
- Local-only (no cloud component; captured content reaches SaaS via the
  normal shipper like everything else).

### Approximate ETA (1 dev, after gates clear)
ADR + review ~2d; proxy core (transparent forward + SSE) ~3-4d; capture fork +
tests ~2-3d; hardening (timeout/failure modes, latency bench) ~2d.
**Total ≈ 2 weeks, strictly after FEAT-455 ships.**

## Intake notes
Filed 2026-07-10 per product-owner decision ("land hook-tap first, file separate
feature for future router implementation"). Blocked on FEAT-455 completion +
its own ADR. Unscored; run `/runner:triage`.
