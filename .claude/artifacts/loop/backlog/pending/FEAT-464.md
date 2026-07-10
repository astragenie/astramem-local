---
id: FEAT-464
status: pending
priority: null
category: platform
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: dependabot PR #55 (closed 2026-07-10 — major bumps rejected)
cross_product: [astramem-local]
autonomous_safe: null
tags: ["concern:deps", "stack:typescript", "surface:build"]
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
