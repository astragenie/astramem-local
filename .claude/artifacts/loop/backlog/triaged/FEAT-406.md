---
id: FEAT-406
status: pending
priority: null
category: null
target_release: null
created: 2026-07-03
updated: 2026-07-03
depends_on: []
slices: []
derived_from: null
github_issue: null
github_milestone: null
github_url: null
pm_customer_impact: 0.25
pm_effort_estimate: 0.30
pm_strategic_alignment: 0.40
pm_technical_risk: 0.60
pm_dependency_depth: 0.00
pm_effort_points: 3
composite_score: 0.49
composite_priority: P2
autonomous_safe: false
pm_demand_evidence: "none - no fleet of daemons currently exists in this local-first single-user product; 'fleet dashboards' is a speculative future need named only in the roadmap, not a stakeholder quote. customer_impact capped <=0.3."
pm_scope_notes: "Smallest deliverable: bearer-gated non-local bind only, defer push-gateway mode alternative if halved. Overlap check: extends existing public health route (src/server/routes/health.ts:22, exempted from auth at src/server/app.ts:92 'if (path === /health ... ) return;') rather than duplicating it. AC quality: concrete test cases given (401/200), but 'threat model documented' has no acceptance criterion for what the doc must contain - flagging as underspecified for autonomous execution. No grade history / no cost analog available."
pm_risks:
  - "Pre-mortem (technical_risk>=0.6 mandatory): most likely failure cause is the default-unchanged claim ('loopback-only, /health public') not holding under a config typo or partial rollout, silently exposing health data on a non-loopback interface without the bearer requirement being wired to the same auth check as the rest of the API."
  - "Rollback: revert-only for the code path (git revert restores loopback-only default), but any operator who already opted into a non-local bind before the bearer gate is code-reviewed and shipped would have a window of unauthenticated exposure - not a pure code-only concern."
  - "Coverage gap: existing tests exempt /health from auth entirely (src/server/app.ts:92) - there is currently no test that distinguishes local-bind-public from non-local-bind-authenticated behavior; AC's 401/200 cases must be new, not modifications of an existing exemption test."
reasoning: "Security-sensitive auth-boundary change on a currently-public endpoint (src/server/app.ts:92 explicitly exempts /health from Bearer auth); technical_risk band 0.6-0.8 given the auth-boundary sensitivity even though blast radius is small. autonomous_safe=false per operator signal - auth boundary changes warrant human review regardless of AC clarity."
---
# FEAT-406: Remote /health scrape (W4.6)

## Description

Optional bind beyond 127.0.0.1 (or a push-gateway) so fleet dashboards can scrape
daemon health. Security-sensitive: when the bind is non-local, /health must require
a bearer token instead of staying public.

## Acceptance criteria (Given / When / Then)

**AC-1** Given default config, When the daemon binds, Then /health listens on 127.0.0.1 only and stays public (no Bearer required) — current behavior preserved (regression snapshot).
**AC-2** Given non-local bind opt-in enabled, When `GET /health` is called without `Authorization: Bearer`, Then the response is 401.
**AC-3** Given non-local bind + a Bearer matching `MEMORY_BEARER`, When `GET /health` is called, Then the response is 200 with the health body.
**AC-4** Given non-local bind + a wrong/expired Bearer, When `GET /health` is called, Then the response is 401 (not 200, not 500).
**AC-5** Given the same non-local bind, When `GET /version` is called, Then it follows the identical auth rule as /health (both gated together) — no public-endpoint gap left open.
**AC-6** Given the change, When the threat-model doc is reviewed, Then it states exactly what a non-local /health scrape exposes and where the auth boundary sits.

## Notes

Roadmap W4.6. Complexity: Med — small code, careful threat model. Est 4–6h.
Security-sensitive (auth boundary change). Suggested activation order: 7th.
