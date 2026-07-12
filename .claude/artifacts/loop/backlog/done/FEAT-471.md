---
id: FEAT-471
status: done
priority: P2
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-12
depends_on: []
slices: []
derived_from: 2026-07-10 Wave-2 gates — two agents independently observed
cross_product: [astramem-local]
tags: ["concern:testing", "stack:typescript", "surface:ci"]
pm_customer_impact: 0.3
pm_effort_estimate: 0.4
pm_strategic_alignment: 0.55
pm_technical_risk: 0.25
pm_dependency_depth: 0.1
pm_composite_priority: P2
pm_autonomous_safe: true
pm_reviewed: 2026-07-12
autonomous_safe: true
composite_score: 0.51
triage_notes: "P2 via formula: impact 0.3<0.7 and alignment 0.55<0.8 so neither P1 branch fires; effort 0.4<0.7 so P3 (effort>=0.7 AND impact<=0.3) doesn't fire either — default P2. composite_score = 0.3*0.35 + 0.55*0.30 + (1-0.4)*0.20 + (1-0.25)*0.10 + (1-0.1)*0.05 = 0.51. customer_impact scored low-moderate (0.3): test-infra only, no prod surface per the FEAT's own framing — the cost is developer/CI trust and wasted re-run cycles, not an end-user-visible defect. strategic_alignment 0.55: flaky suites erode confidence in the regression gate this repo leans on hard (eval/retrieval floors, redact-perf budgets) — worth fixing but not a strategic bet. technical_risk banded low (0.25): fix is isolation-only (unique tmp dirs, port randomization, or widened timeout budgets) confined to two test files, fully revertible, no runtime/schema change. dependency_depth 0.1: depends_on empty, no chain on FEAT-470 or any other in-flight FEAT — fully independent of the entropy.ts/keystore.ts chain blocking FEAT-468/472/473. autonomous_safe=true: all three mechanical thresholds pass well inside range (risk 0.25, effort 0.4, dependency 0.1, all <=0.6), no external blocker, and the FEAT already specifies its own acceptance bar in Scope (5 consecutive green full-suite runs under artificial parallel load) which stands in for a drafted AC — a builder can pick this up unattended."
---
## Description

**Suite flake under parallel load: post-merge-rebuild + release tests** —
`tests/scripts/post-merge-rebuild.test.ts` and `tests/service/release.test.ts`
fail intermittently when the full suite runs while the box is loaded (two
concurrent full-suite runs, or eval daemons active). Both pass 14/14 in
isolation; different sub-test fails each time; 7/9 full runs clean. Two
independent agents reproduced the pattern on 2026-07-10.

### Scope

- Root-cause: likely shared temp-dir/port/fixture contention or timeout
  margins tuned for an idle box. Instrument, identify the shared resource,
  isolate (unique tmp dirs per test file, port randomization, or widened
  budgets with rationale).
- Do NOT mark them retry/skip — fix the isolation.
- Evidence: 5 consecutive full-suite runs green while an artificial load
  (one parallel vitest run) is active.
