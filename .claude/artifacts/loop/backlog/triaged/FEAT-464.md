---
id: FEAT-464
status: triaged
priority: P3
category: platform
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: dependabot PR #55 (closed 2026-07-10 — major bumps rejected)
cross_product: [astramem-local]
tags: ["concern:deps", "stack:typescript", "surface:build"]
pm_customer_impact: 0.2
pm_effort_estimate: 0.7
pm_strategic_alignment: 0.35
pm_technical_risk: 0.3
pm_dependency_depth: 0.1
pm_composite_priority: P3
pm_autonomous_safe: false
pm_reviewed: 2026-07-10
autonomous_safe: false
triage_notes: "P3 via formula: impact 0.2 and alignment 0.35 are both far below the P1 thresholds (impact>=0.7 AND alignment>=0.6; or alignment>=0.8 AND effort<=0.4), so neither P1 branch fires. P3 fires on the second condition: effort 0.7>=0.7 AND impact 0.2<=0.3 both hold — this is a wide-reaching mechanical migration (105 test-side type errors across 3+ files, bun.lock regen, a real @types/node-26-vs-20 decision, 4-leg CI verification) with no direct end-user-visible impact (pure toolchain, no runtime behavior change per the FEAT's own text). composite_score = 0.2*0.35 + 0.35*0.30 + (1-0.7)*0.20 + (1-0.3)*0.10 + (1-0.1)*0.05 = 0.35. technical_risk banded at 0.3 (mechanical type-fixups only, no runtime/schema change, git-revertible; residual risk is entirely in the @types/node major-version decision, not the mechanical fixes). autonomous_safe=false is forced by effort_estimate 0.7 > 0.6 alone (mechanical threshold) — reinforced by no AC/spec being drafted this pass (not in this triage batch's AC-drafting scope) and by the wide test-file churn the coordinator flagged as needing human review of the toolchain decision (take TS7+@types/node 26 vs pin @types/node 20.x), not a bulk autonomous rewrite of ~105 call sites."
---
## Description

**TypeScript 7 + @types/node 26 migration** — dependabot PR #55 grouped
`typescript ^5.5 → ^7.0.2` and `@types/node ^20 → ^26.1.1`. Closed 2026-07-10
with `@dependabot ignore this major version` because it is a real migration,
not a rubber-stamp bump:

- `bunx tsc --noEmit` (src) passes clean under TS 7.0.2.
- `bun run build` passes.
- `bun run typecheck:tests` fails with **105 errors**, three clusters:
  - `TS2532 Object is possibly 'undefined'` — TS7 stricter narrowing on
    indexed access in tests (tests/vector/sqlite-vec.test.ts,
    tests/distill/05-extract.test.ts, others).
  - fetch-mock typing: `Property 'mock' does not exist` on typed global fetch
    (tests/search/rerank.test.ts) — needs `vi.mocked()` or cast.
  - `Float32Array<ArrayBufferLike>` generic mismatch in embed fakes
    (tests/server/score-contract.test.ts) — TS7 typed-array generics.
- Dependabot also never regenerates `bun.lock` (repo is bun-first; CI
  frozen-lockfile fails on every dependabot PR — consider dependabot.yml
  `enable-beta-ecosystems`/bun support or a CI job that regenerates).

### Scope

1. Bump typescript + @types/node deliberately; regenerate bun.lock.
2. Fix the ~105 test-side type errors (mechanical; no runtime behavior change).
3. Confirm @types/node 26 vs Node 20 runtime floor — if types drift from the
   supported runtime, pin @types/node 20.x instead and only take TS7.
4. CI green on all four legs.

### Done when

- typecheck, typecheck:tests, build, vitest all green under the new toolchain
- decision recorded on @types/node major (take 26 vs stay 20.x) with rationale
