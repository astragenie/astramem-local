---
id: FEAT-471
status: pending
priority: null
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: 2026-07-10 Wave-2 gates — two agents independently observed
cross_product: [astramem-local]
autonomous_safe: null
tags: ["concern:testing", "stack:typescript", "surface:ci"]
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
