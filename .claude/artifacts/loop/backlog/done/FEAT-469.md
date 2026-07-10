---
id: FEAT-469
status: done
priority: null
category: bug
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: FEAT-457 slice-1 builder handoff (incidental finding, 2026-07-10)
cross_product: [astramem-local]
autonomous_safe: null
tags: ["concern:eval", "stack:typescript", "surface:eval"]
---
## Description

**extraction-bench imports point at moved longmemeval/lib files** —
`scripts/eval/extraction-bench/{lib/judge.ts, azure-reasoning-provider.ts,
daemon-runner.ts, run-bench.mts}` still import from
`scripts/eval/longmemeval/lib/{azure-client,config,spawn-daemon}.js`, which no
longer exist (moved to `scripts/eval/shared/` when the FEAT-457 LoCoMo harness
landed, commit 480d870). No test fails today (the judge.js import in report.ts
is type-only, erased at build), but **`run-bench.mts` would fail to execute
live** — which blocks the FEAT-450 close (its remaining AC needs a live
`--runs 8` judged sweep once `az login` is available).

### Scope

- Repoint the stale imports at `scripts/eval/shared/` (mechanical).
- Add a cheap executability guard: a unit test (or tsc project include) that
  fails when an eval-script import path resolves to a nonexistent file, so a
  future shared-tier move can't silently strand a runner again.
- Smoke: `run-bench.mts --help` (or dry-run path) executes without module
  resolution errors.

### Note

Do BEFORE the FEAT-450 evidence sweep — the sweep runs run-bench.mts live.
