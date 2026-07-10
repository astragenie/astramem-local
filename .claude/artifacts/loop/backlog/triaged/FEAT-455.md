---
id: FEAT-455
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-07-09
updated: 2026-07-09
depends_on: []
slices: []
derived_from: docs/research/2026-07-09-competitor-gap-analysis.md
cross_product: [astramem-local]
pm_customer_impact: 0.45
pm_effort_estimate: 0.52
pm_strategic_alignment: 0.55
pm_technical_risk: 0.9
pm_dependency_depth: 0.2
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-09
autonomous_safe: false
triage_notes: "technical_risk 0.9 sits in the top band (0.9-1.0: 'unknowns needing a spike') because the FEAT body itself mandates a pre-build design spike to choose the interception mechanism, and the mechanism observes live agent<->LLM/MCP traffic -- a privacy-sensitive, hard-to-fully-reverse trust surface even though the code path itself is revertable. Real adoption-driver value but explicitly gated -- P2, autonomous_safe FALSE per the operator's direction pending a dedicated security/privacy review before any build dispatch."
---
## Description

**Automatic memory capture (proxy / interception)** — capture memories without the
agent making explicit `remember`/ingest calls.

Today capture is hook-driven: the plugin ships transcript content to
`/ingest/transcript` on session events. Add an **opt-in auto-capture router** that
observes agent↔LLM traffic (or MCP tool traffic) and enqueues distill-worthy content
automatically, so memory forms passively.

**Why:** mem0 (LLM proxy) and Supermemory auto-capture memories by sitting in the
request path — no explicit save call. Lowest-friction path to "it just remembers,"
a repeatedly-cited adoption driver.

### Scope — LOCAL-SPECIFIC (astramem-local, TS)
This one is intentionally local-only. The SaaS (`memory`) already receives content
via the daemon→SaaS shipper, so cloud gets auto-captured memories for free once the
local daemon captures them — no separate cloud feature.

- Design decision (spike first): **MCP passthrough tap** vs **local LLM proxy**
  (OpenAI-compatible `/v1/chat/completions` middleman) vs **enriched hook capture**.
  Proxy = broadest coverage but intercepts model traffic (privacy + latency
  surface); MCP tap is its own, separate risk tier — see corrections below — not
  simply "narrower but safer." Ship the hook tap first; treat MCP tap as later,
  separately-risk-assessed work.
- Debounce + relevance gate so we do not spool every token. **Cannot reuse the
  FEAT-441 durability gate as originally proposed** — that gate is a post-distill,
  store-write choke point (src/distill/durability-gate.ts:1-11) and its own AC-6
  forbids a second use of its taxonomy elsewhere. This needs a DISTINCT
  source-side debounce/relevance filter, designed fresh (or FEAT-441 must be
  formally extended via a mini-ADR that revisits its own AC-6).
- Strictly opt-in, clearly disclosed (it observes traffic), default OFF; respect
  private-by-default scope and client scrub flags. **Client-side scrub is not
  currently implemented** — `src/capture/claude.ts:143-148` ships
  `client_scrub_applied: false` today — so auto-capture would amplify secret-leak
  risk through an already-unscrubbed path. This must be closed, or explicitly
  risk-accepted in the required ADR, before auto-capture ships.
- Interception must be a strict side-channel: it observes and copies, but never
  mutates the in-flight agent↔LLM/MCP request or response.
- Disabling auto-capture must wire through to the existing purge tooling (erase/
  invalidate of already-captured content) — turning the toggle off must be able to
  retroactively remove what it already captured, not just stop future capture.
- Feed the existing durable ingest spool (FEAT-449) → no new storage.

### Shared contract impact
- None required for the capture path (reuses `/ingest/transcript`). If a new
  capture-source tag is wanted for provenance, additive contract field only.

### Approximate ETA (1 dev)
- Design spike (pick interception mechanism, privacy review): **~1–2d**
- Local implementation (tap + debounce + relevance gate + opt-in wiring): **~5–8d**
- **Total ≈ 1.5–2 weeks, local only.** Gate: an ADR plus a dedicated
  security/privacy spike MUST happen BEFORE any slicing — this feature observes
  model/tool traffic and, unresolved, would ship through an unscrubbed capture
  path.

## Intake notes
From 2026-07-09 competitor gap analysis (gap #5 in the "cool features" list). Local-only
by design. Needs a security/privacy review at the spike gate. Unscored; run `/runner:triage`.

## Architecture review corrections (2026-07-09)

1. **Durability-gate reuse is invalid as originally stated.** The gate
   (src/distill/durability-gate.ts:1-11) is a post-distill, store-write choke
   point, and its own AC-6 forbids reusing its taxonomy elsewhere. Auto-capture
   needs a distinct source-side debounce/relevance filter, or a mini-ADR that
   formally extends FEAT-441.
2. **Client-side scrub is not implemented.** `src/capture/claude.ts:143-148`
   ships `client_scrub_applied: false` today. Auto-capture would amplify
   secret-leak risk through this already-unscrubbed path — close it or explicitly
   risk-accept it in the required ADR before shipping.
3. **MCP tap is its own risk tier**, not "the safe option" bundled with hook
   capture — tool args/results can carry file contents, DB rows, and third-party
   credentials. Hook-tap ships first; MCP tap gets a separate risk assessment
   later.
4. **Added scope:** disabling auto-capture must wire to the existing purge
   tooling (erase/invalidate of already-captured content); interception must be a
   strict side-channel that never mutates the in-flight request.
5. **Gate:** an ADR plus a security/privacy spike must happen BEFORE any slicing
   begins, not merely before the build phase.
