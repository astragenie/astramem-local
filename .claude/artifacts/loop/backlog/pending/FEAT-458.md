---
id: FEAT-458
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: [FEAT-455]
slices: []
derived_from: docs/adr/ADR-012-auto-capture-security-model.md
cross_product: [astramem-local]
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
