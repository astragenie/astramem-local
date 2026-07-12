---
id: FEAT-475
status: in-progress
priority: P2
category: bug
target_release: null
created: 2026-07-12
updated: 2026-07-12
depends_on: []
slices: [SLICE-424]
derived_from: 2026-07-12 wave reviews — two agents independently hit it
cross_product: [astramem-local]
autonomous_safe: true
tags: ["concern:testing", "stack:typescript", "surface:ci", "followup:FEAT-471"]
pm_customer_impact: 0.45
pm_effort_estimate: 0.55
pm_strategic_alignment: 0.6
pm_technical_risk: 0.35
pm_dependency_depth: 0.1
pm_composite_priority: P2
pm_autonomous_safe: true
pm_reviewed: 2026-07-12
triage_notes: "P2 via formula: impact 0.45 < 0.70 and alignment 0.60 < 0.80, so neither P1 branch fires; effort 0.55 < 0.70 so P3 doesn't fire either (and impact 0.45 > 0.30 so P3's second condition also fails) — lands P2 by the formula's default branch, same tier as its sibling FEAT-471. composite_score=0.1575+0.18+0.09+0.065+0.045=0.5375 (~0.54), higher than FEAT-471's 0.51 due to the frequency/recurrence bump in customer_impact and strategic_alignment. technical_risk banded at 0.35 (0.3-0.5 band: 'new pattern in repo OR one module, no contract change, clean rollback') — test-isolation fix only, no schema/runtime change, clean per-file revert; scored above FEAT-471's 0.25 to reflect the wider, not-yet-confirmed-single-root-cause footprint (4+ files across up to 3 subsystems) without crossing into the 0.6-0.8 'cross-module reach' band, since the actual blast radius is confined to test infrastructure, not production code paths. pm_effort_points=5 (band [0.4,0.6)) — under the FEAT-168 gate threshold (8), no proposed_slices required. autonomous_safe=true: all three mechanical thresholds (risk 0.35, effort 0.55, dependency 0.10) pass individually, AND — unlike a typical P2 with no drafted AC — this FEAT carries its own explicit, quantified acceptance bar in its Scope section ('5 consecutive full-suite runs green under an artificial parallel load'), which is the same substitute-for-AC reasoning FEAT-471 used to justify autonomous_safe=true at P2; that bar is testable by a builder unattended."
started_at: 2026-07-12
---
## Description

**Eval detach/daemon-manifest tests flake under parallel load** — sibling of
FEAT-471 (fixed, merged) but in a different file family: during 2026-07-12
wave reviews, two independent reviewer agents running the full suite under
box load hit failures in `scripts/eval/longmemeval/detach-kill-resume.test.ts`
and `scripts/eval/shared/daemon-manifest.test.ts` (e.g. the spawnDetached
heartbeat-timing assertion, and "pid whose port is not listening →
already-dead"). All pass in isolation; failures only appear with concurrent
suite runs / builder agents active.

### Scope

- Same treatment as FEAT-471: root-cause the shared resource or timing margin
  (these tests do real process spawn/kill + port probing — likely
  idle-box-tuned heartbeat/probe timeouts), then isolate or widen budgets with
  measured rationale. No retry/skip.
- Evidence bar: 5 consecutive full-suite runs green under an artificial
  parallel load, matching FEAT-471's bar.
- FEAT-471's fix (tests/scripts/post-merge-rebuild.test.ts +
  tests/service/release.test.ts) is merged and holding — do not re-touch
  those files.

### Update 2026-07-12 (later)

Third reviewer full-suite run flaked a DIFFERENT pair: tests/backup/
snapshot.test.ts + tests/cli/capture-claude.test.ts. Flake is spread across
4+ files under load, not just the eval detach family — widen root-cause scope
accordingly.

## Acceptance criteria

- **AC-1 — Root cause, not a bandage.**
  Given the four known-flaky test files (`scripts/eval/longmemeval/detach-kill-resume.test.ts`,
  `scripts/eval/shared/daemon-manifest.test.ts`, `tests/backup/snapshot.test.ts`,
  `tests/cli/capture-claude.test.ts`) fail intermittently under concurrent
  suite/agent load but pass in isolation,
  When the fix is implemented,
  Then each failure's actual shared-resource contention or timing margin
  (e.g. a fixed heartbeat/probe timeout tuned for an idle box, a shared port
  range, a shared temp/lock path) is identified and named in the slice's
  handoff or commit message,
  And the fix is either (a) isolation of the shared resource so concurrent
  runs no longer contend for it, or (b) a widened timing budget backed by
  measured numbers (e.g. observed p99 spawn/kill/probe latency under
  artificial load) recorded in the same handoff,
  And no fix consists solely of `test.retry(...)`, `.skip`, `.only`,
  increased `--retry` CLI flags, or swallowing/ignoring the failure.

- **AC-2 — Full scope covered, not just the original pair.**
  Given the flake has now been observed in 4 distinct files across 3
  subsystems (eval/longmemeval, eval/shared, backup, cli) as of the
  2026-07-12 updates to this FEAT,
  When the slice is scoped,
  Then all four files listed in AC1 are root-caused and fixed in this slice
  (not just the originally-named eval-detach pair),
  And if `tests/search/rerank.test.ts` (the timeout flake seen on PR #157)
  reproduces under the same artificial-parallel-load harness during this
  slice's investigation, it is folded into this FEAT's scope rather than
  filed as a separate FEAT,
  And if any in-scope file turns out on investigation to share a root cause
  with another, that shared root cause is fixed once and referenced from
  each affected file's test setup/teardown rather than duplicated.

- **AC-3 — Evidence bar: 5 consecutive green full-suite runs under load.**
  Given the fix is claimed complete,
  When the full test suite is run 5 consecutive times under an artificial
  parallel load (matching or exceeding the concurrency level that originally
  triggered the flakes — e.g. multiple builder/reviewer/eval processes
  running concurrently against the same repo checkout),
  Then all 5 runs are green with zero failures in the four AC1 files (and
  in `rerank.test.ts` if it was folded into scope per AC2),
  And the 5 run logs (or a summary with pass/fail counts and timestamps)
  are captured as evidence in the slice's validation artifact.

- **AC-4 — FEAT-471's fix stays untouched.**
  Given `tests/scripts/post-merge-rebuild.test.ts` and
  `tests/service/release.test.ts` are FEAT-471's already-merged, holding fix,
  When this slice's changes are diffed against main,
  Then neither of those two files appears in the diff.

- **AC-5 — No image-name process kills.**
  Given this box concurrently runs the production astramem-local daemon,
  Ollama, and sibling agents' processes, and an image-name kill
  (`taskkill /F /IM node.exe`, `Stop-Process -Name node`, or equivalent) has
  previously killed unrelated production/eval processes by accident,
  When the fix touches any process spawn/kill/detach logic in the affected
  tests (all four AC1 files do real process spawn + kill + port probing),
  Then any process termination introduced or modified by the fix targets
  only a PID the test itself spawned (tracked explicitly, e.g. via the
  child process handle or a recorded PID/process-tree), never an image name
  or process-name match,
  And this constraint is verified by reading the diff, not just assumed.

- **AC-6 — Product source stays out of scope unless a real bug is proven.**
  Given this flake is presumed to be test-infrastructure timing/isolation,
  not a product defect,
  When root-causing any of the four AC1 files,
  Then no file under `src/` is modified UNLESS the investigation produces
  concrete evidence that the flake stems from a real product-code race or
  bug (not test timing) — in which case the handoff explicitly states which
  product behavior is wrong, cites the evidence, and calls out the
  `src/` change as an exception to this AC.

## Files

- `scripts/eval/longmemeval/detach-kill-resume.test.ts` — known flaky, spawnDetached heartbeat-timing assertion
- `scripts/eval/shared/daemon-manifest.test.ts` — known flaky, "pid whose port is not listening → already-dead"
- `tests/backup/snapshot.test.ts` — known flaky (2026-07-12 third-reviewer run)
- `tests/cli/capture-claude.test.ts` — known flaky (2026-07-12 third-reviewer run)
- `tests/search/rerank.test.ts` — conditional: fold in only if it reproduces under this slice's load harness (per AC2); otherwise out of scope
- OFF LIMITS: `tests/scripts/post-merge-rebuild.test.ts`, `tests/service/release.test.ts` (FEAT-471's merged fix — do not re-touch)
- `src/**` — out of scope unless AC6's exception is proven and documented
