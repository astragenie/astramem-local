---
id: FEAT-472
status: triaged
priority: P2
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-12
depends_on: []
slices: []
derived_from: FEAT-466 handoff follow-up flag (2026-07-10)
cross_product: [astramem-local]
tags: ["concern:security", "stack:typescript", "surface:daemon"]
pm_customer_impact: 0.55
pm_effort_estimate: 0.5
pm_strategic_alignment: 0.65
pm_technical_risk: 0.4
pm_dependency_depth: 0.5
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-12
autonomous_safe: false
composite_score: 0.5725
triage_notes: "P2 via formula: impact 0.55<0.7 so the first P1 branch doesn't fire; alignment 0.65<0.8 so the second P1 branch doesn't fire; effort 0.5<0.7 so P3 doesn't fire. composite_score = 0.55*0.35 + 0.65*0.30 + (1-0.5)*0.20 + (1-0.4)*0.10 + (1-0.5)*0.05 = 0.5725 — highest of this batch, reflecting the same collision class as FEAT-466 (an already-shipped incident-class fix) but not yet an observed incident itself. customer_impact 0.55: a sandboxed pairing flow clobbering the production sync device token is a real blast-radius risk identical in kind to the FEAT-466 bearer/db-key collision, scored slightly below FEAT-466's 0.75 because no live incident has been observed for the sync-token path yet (proactive hardening, not incident remediation). strategic_alignment 0.65: protects the same trust boundary FEAT-466 established a precedent for. technical_risk banded 0.4 (lower than FEAT-468's 0.55): this FEAT explicitly mirrors the FEAT-466 pattern (per-configDir scoped identity + legacy fallback + keyfile bypass + doctor row) — precedented design, not novel, though still credential-storage-sensitive and needs to state sync.json rollback authority clearly. dependency_depth scored 0.5: depends_on is empty, but this shares the keystore.ts chain the coordinator flagged as blocked on FEAT-470 landing first. autonomous_safe=false: forced by the FEAT-470 chain blocker — mechanical thresholds all pass (risk 0.4, effort 0.5, dependency 0.5, all <=0.6) and the precedented FEAT-466 pattern makes this the easiest of the three FEAT-470-blocked items to greenlight the moment that dependency clears; no ACs drafted this pass is the secondary reason."
---
## Description

**sync-token still uses the unscoped machine-global keystore identity** —
`storeSyncToken`/`readSyncToken` (cloud sync device token) kept the fixed
service/account pattern FEAT-466 removed for bearer/db-key. Same collision
class: a sandboxed pairing flow would clobber the production device token.

### Scope

- Mirror FEAT-466: per-configDir scoped identity + read-only legacy fallback +
  keyfile bypass under ASTRA_MEMORY_TEST_FORCE_KEYFILE + doctor row.
- Check rollback interplay with sync.json (memory: sync.json prod-pairing
  leaks into sandboxed spawns — daemon-spawn-footguns) — pairing has its own
  file-state; state clearly which is authoritative post-change.
- Tests: two-configDir no-cross-clobber; bypass leaves OS store untouched.
