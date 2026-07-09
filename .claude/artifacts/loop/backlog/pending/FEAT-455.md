---
id: FEAT-455
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-09
updated: 2026-07-09
depends_on: []
slices: []
derived_from: docs/research/2026-07-09-competitor-gap-analysis.md
cross_product: [astramem-local]
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
