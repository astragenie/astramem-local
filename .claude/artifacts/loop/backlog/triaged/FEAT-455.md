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
  surface); MCP tap = narrower but safer. Recommend MCP/hook tap first.
- Debounce + relevance gate so we do not spool every token (reuse the durability
  gate FEAT-441 signal to drop low-value captures at the source).
- Strictly opt-in, clearly disclosed (it observes traffic), default OFF; respect
  private-by-default scope and client scrub flags.
- Feed the existing durable ingest spool (FEAT-449) → no new storage.

### Shared contract impact
- None required for the capture path (reuses `/ingest/transcript`). If a new
  capture-source tag is wanted for provenance, additive contract field only.

### Approximate ETA (1 dev)
- Design spike (pick interception mechanism, privacy review): **~1–2d**
- Local implementation (tap + debounce + relevance gate + opt-in wiring): **~5–8d**
- **Total ≈ 1.5–2 weeks, local only.** Gate the spike behind a privacy/security
  review before building — this feature observes model traffic.

## Intake notes
From 2026-07-09 competitor gap analysis (gap #5 in the "cool features" list). Local-only
by design. Needs a security/privacy review at the spike gate. Unscored; run `/runner:triage`.
