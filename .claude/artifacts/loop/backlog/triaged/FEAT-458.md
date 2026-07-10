---
id: FEAT-458
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: [FEAT-455, FEAT-467]
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
triage_notes: "P2 via formula (default branch): impact 0.55 < 0.70 so the (impact>=0.7 AND alignment>=0.6) P1 branch does not fire; alignment 0.65 < 0.80 so the (alignment>=0.8 AND effort<=0.4) P1 branch does not fire either; effort 0.62 < 0.70 so P3 (effort>=0.7 AND impact<=0.3) does not fire. composite_score = 0.55*0.35 + 0.65*0.30 + (1-0.62)*0.20 + (1-0.85)*0.10 + (1-0.75)*0.05 = 0.491. technical_risk banded at 0.85 (top rubric band: hot-path proxy sees full system prompts + every turn, byte-transparent-forwarding invariant is hard-to-reverse-if-violated, and the FEAT's OWN scope mandates a pre-build STRIDE/latency/failure-mode spike -- same shape as FEAT-455's own 0.9 score for the same underlying capture-mechanism-choice reason). autonomousSafe=false is forced THREE independent ways (any one alone is sufficient): technical_risk 0.85 > 0.6, effort_estimate 0.62 > 0.6, dependency_depth 0.75 > 0.6 -- exactly matching the coordinator's explicit requirement that this must not be autonomous_safe=true. UPDATE 2026-07-10: ADR-013 (this FEAT's own security ADR) is now Accepted with all open questions resolved by operator review -- see '## Review decisions' section. This does NOT change autonomous_safe: the gate that must clear before building is a RUNTIME condition (FEAT-455 hook-tap 14-day production bake + >=1 real scrub-evidence instance + FEAT-463 shipped), not a review-completeness gate. depends_on now includes FEAT-467 (invalidate() reversal/audit hard prerequisite, filed from ADR-013 review decision 4) alongside FEAT-455."
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

## Acceptance criteria

### S1 — Design gate

- **AC-1:** Given FEAT-467 (invalidate() reversal/audit hard prerequisite) has a drafted design, When it goes through review, Then it is marked settled and reviewed, since ADR-013 review decision 4 makes it a hard blocker for slice 3 (capture fork) — not merely a nice-to-have.
- **AC-2:** Given the proxy feature needs a config surface, When `proxy.*` settings are defined, Then they specify default OFF, a dedicated `proxy` CLI subcommand, a `doctor` WARN row shown whenever the proxy is enabled, and disable→purge parity with the existing hook-tap (FEAT-455) disable flow.
- **AC-3:** Given no latency evidence exists yet for the proxy, When a bench harness skeleton is created under `scripts/eval/proxy-bench/`, Then it exists on disk with its methodology (request mix, warm-up period, percentile calculation) pinned in a README or header comment, ahead of any real proxy implementation.
- **AC-4:** Given slice 1 is the sole gate before implementation starts, When slice 1 is marked complete, Then a design-gate artifact records that FEAT-467's design, the `proxy.*` config surface, and the bench harness skeleton are all in place before slice 2 is allowed to open.

### S2 — Core proxy (no capture)

- **AC-1:** Given `astramem-local proxy serve --port N --upstream <url>` is running, When a client sends requests including SSE-streamed chat completions, Then the proxy forwards them byte-transparently to upstream with no mutation of request or response bodies.
- **AC-2:** Given a non-loopback bind address is supplied, When the proxy is started, Then it refuses to bind and exits with a clear error, since loopback-only bind is the only supported v1 mode (ADR-013 review decision 2).
- **AC-3:** Given the upstream provider returns an error response, When the proxy relays it to the client, Then the status code, body, and headers pass through unchanged with no proxy-side rewriting.
- **AC-4:** Given the slice 1 bench harness, When core proxy latency is measured against a direct (non-proxied) call to the same upstream, Then the added p50 latency is under 10ms, with the measurement captured as evidence.
- **AC-5:** Given slice 2 explicitly excludes capture, When the slice 2 diff is reviewed, Then it contains zero capture code paths — no tee, no relevance-gate call, no spool write of any kind.

### S3 — Capture fork (interim review checkpoint required)

- **AC-1:** Given FEAT-458 slice 3 is about to start, When the preconditions are checked, Then FEAT-467 is done and FEAT-455's own capture path has FEAT-463 (stage-0 redaction hardening) shipped — both asserted before any capture code merges, per ADR-013 review decisions 1 and 4.
- **AC-2:** Given the capture fork receives proxied traffic, When it constructs its input to the capture pipeline, Then the input type carries body-only fields with no headers field present at all (enforced by the type boundary, not by runtime filtering), per ADR-013 review decision 3.
- **AC-3:** Given a canary header is injected at the proxy on a test request, When that request flows through the capture fork, Then a regression test asserts the canary header value never appears in any spool write.
- **AC-4:** Given memory-worthy content is captured, When it reaches the ingest spool, Then it is tagged `capture_source: 'proxy'`, has passed through the FEAT-455 source-side relevance gate, and lands in the FEAT-449 durable spool exactly like hook-tap captures do.
- **AC-5:** Given the capture path fails or is killed outright, When forwarding continues, Then the client-visible forwarded response is byte-identical to capture-disabled behavior (fail-silent capture), verified by a test that kills capture mid-flight and diffs the output.
- **AC-6:** Given slice 3 is otherwise complete, When the dedicated interim review checkpoint runs (ADR-013 review decision 5, in addition to the standard reviewer gate), Then byte-transparency and non-mutation evidence is presented and passes before slice 4 is allowed to open.

### S4 — Hardening

- **AC-1:** Given the proxy has multiple documented failure modes, When the failure-mode test matrix runs (upstream down, spool full, daemon down while proxy stays up, capture throws mid-SSE), Then each scenario behaves per its documented pass-through-on-error or fail-closed decision from the FEAT's own security ADR.
- **AC-2:** Given the <10ms p50 target from slice 1/2, When latency is benched with capture enabled end-to-end, Then p50 and p95 evidence is captured and the p50 target still holds with capture live, not just in the capture-free slice 2 measurement.
- **AC-3:** Given the proxy can run with capture enabled, When `doctor` runs, Then it emits a WARN row for the proxy-with-capture state, matching the disclosure pattern already used for hook-tap (FEAT-455).
- **AC-4:** Given FEAT-467's reversal/audit guarantees must extend to proxy-captured content, When the disable→purge flow is exercised as a live end-to-end test against `capture_source: 'proxy'` records, Then the purge is reversible within the bounded window and the audit record is complete, matching the guarantee already proven for hook-tap.

## Intake notes
Filed 2026-07-10 per product-owner decision ("land hook-tap first, file separate
feature for future router implementation"). Blocked on FEAT-455 completion +
its own ADR. Unscored; run `/runner:triage`.
