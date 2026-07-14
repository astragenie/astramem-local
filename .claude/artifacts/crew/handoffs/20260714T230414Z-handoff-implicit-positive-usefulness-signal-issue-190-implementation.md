# Task Handoff: Implicit positive usefulness signal — issue #190 implementation

- Created: 2026-07-14T23:04:14Z
- From: builder-session (crew:fullstack-dev)
- To: crew:reviewer
- Objective: Implement the design in `docs/specs/20260714-implicit-usefulness-signal-190.md` /
  `.claude/artifacts/crew/handoffs/20260714T152524Z-handoff-implicit-positive-usefulness-signal-design-issue-190.md` —
  wire the missing automatic positive-usefulness signal ("cross-query survival")
  that ADR-010 v1 never shipped.
- Branch: `feat/190-implicit-usefulness-signal` (off `origin/main` @ `a70cad7`)
- Allowed Scope: `src/storage/usefulness.ts`, `src/config/config.ts`,
  `src/pipeline/handlers/cleanup.ts`, `src/eval/eval-evidence.ts`,
  `src/doctor/checks/usefulness-feedback-loop.ts` + matching tests, per dispatch.
- Forbidden Scope respected: did not rework `fuse.ts`'s scoring formula
  beyond what the design specifies (one necessary bugfix — see Risks), did
  not add a new migration (the design reuses the existing `memory_events`
  log, no schema change), did not touch sync/proxy/spool.
- Deliverable: implicit-positive sweep, weighted `usefulnessScores()`,
  eval-evidence governance gate, doctor canary message split, config
  plumbing, tests.
- Confidence: high (all typecheck + scoped test suites green; ranking is a
  proven byte-identical no-op at the shipped default).

## Changed files

- `src/config/config.ts` — new `search.usefulness.implicitPositive` config
  sub-object (`enabled` default `false`, `windowDays: 30`,
  `minDistinctQueries: 2`, `weight: 0.35`, `maxGrantsPerRun: 500`);
  `applyFusionGovernance` gains a third guard mirroring the existing η
  eval-evidence gate — `enabled: true` with no recorded evidence for
  `'implicitPositive'` is forced back to `false` at config-load time (and
  per-request, since `resolvePresetWeights` re-runs governance).
- `src/eval/eval-evidence.ts` — `GatedFusionComponent` widened from `'eta'`
  to `'eta' | 'implicitPositive'`.
- `src/storage/usefulness.ts` — new `runImplicitPositivePass` (the sweep,
  SQL exactly per the design doc: distinct-query-hash threshold, permanent
  exclusion on any `memory_corrected` ever, permanent exclusion on any prior
  heuristic grant, capped by `maxGrantsPerRun`); `usefulnessScores()` now
  computes a **weighted** sum for `recall_used` (`explicit` = 1.0,
  `heuristic` = configurable weight, default `0.35`) instead of a raw count;
  `feedbackLoopSummary()` gains `usedExplicitDistinct`/`usedHeuristicDistinct`;
  `UsefulnessSurface` widened to include `'system'` (background/pipeline
  events, distinct from `'cli'` which means the CLI tool) per the design's
  flagged follow-up.
- `src/pipeline/handlers/cleanup.ts` — invokes the sweep on the existing
  cleanup-job cadence, gated behind `config.search.usefulness.implicitPositive.enabled`
  (default no-op), same posture as `runArchivalPass`.
- `src/doctor/checks/usefulness-feedback-loop.ts` — the "Usefulness feedback
  loop" canary message now reads `N used (M explicit, K heuristic)` instead
  of a bare `N used`, so an operator can tell a real client action apart
  from the automatic grant. Gate logic (`usedDistinct > 0` ⇒ green) is
  unchanged — an implicit-only grant does flip the canary green by design
  (see design doc's explicit call-out on this).
- `src/search/search.ts` — threads the live configured weight
  (`weights.usefulness?.implicitPositive.weight`) into `usefulnessScores()`
  at the one real ranking call site, falling back to
  `DEFAULT_IMPLICIT_POSITIVE_WEIGHT` only for callers whose narrower weights
  type omits `usefulness` (eval harness, hand-built fixtures) — satisfies
  the design's "must not silently default inside SQL" requirement.
- `src/search/fuse.ts` — **bugfix, in-scope**: `fuseHits` used to build the
  `fuseScores()` input by spreading the whole `weights` object in *after*
  the `usefulness` score field. Every real production caller already passes
  the full `Config['search']` as `weights` (via `resolvePresetWeights`), and
  it now carries its own `usefulness` sub-object — the trailing spread would
  have silently clobbered every real search's per-atom usefulness *score*
  with that config *object*, corrupting ranking (`epsilon * {object}` →
  `NaN`) on every live search call the moment this branch merged. Fixed by
  picking the seven fusion weight keys explicitly instead of spreading. Not
  a scoring-formula change — same weights selected, same math, only the
  construction is safer. Flagged loudly in Risks below since it's outside
  the literal file list but was structurally unavoidable once the config
  schema changed.
- Tests: `tests/storage/usefulness.test.ts` (AC-1..AC-4 + payload shape +
  window/cap/negative cases + weighted-score cases including the
  correction-still-demotes negative case), `tests/pipeline/handlers/cleanup.test.ts`
  (AC-5 default-off no-op + enabled:true grants), `tests/config/config.test.ts`
  (AC-7-equivalent governance gate tests, mirroring the eta test shape),
  `tests/config/fusion-governance-shipped-config.test.ts` (shipped-default
  hard gate), `tests/config/writer.test.ts` (FEAT-461 emit-completeness
  fixture + round-trip, updated for the governance-forced `enabled:false`),
  `tests/search/fuse.test.ts` (fixed the pre-existing collision the schema
  change exposed).

## How the doctor "Usefulness feedback loop" row changes

Before (current production, `enabled: false` default — **unchanged today**):
```
usefulness feedback loop has NEVER received a POSITIVE signal: ... 0 marked used, ...
```
(WARN, unchanged — this PR ships the mechanism OFF by default; a real
production daemon's canary state does not change until an operator flips
`implicitPositive.enabled: true` **and** an eval-evidence entry is recorded).

Once enabled (post eval-evidence, future work) and the sweep has fired at
least once, the green-path message changes from:
```
usefulness feedback loop: active (N used, ...)
```
to:
```
usefulness feedback loop: active (N used (M explicit, K heuristic), ...)
```
Gate logic unchanged (`usedDistinct > 0` ⇒ ok) — only the message text
gained the explicit/heuristic split, which was Build Sequence phase 5 in
the design doc.

## Test evidence

```
bun run build                    -> clean (tsc -p .)
bun run typecheck:tests          -> clean (tsc -p tsconfig.tests.json)
bun run typecheck:eval           -> clean (tsc -p tsconfig.eval.json)

vitest run tests/storage/usefulness.test.ts tests/config/config.test.ts \
  tests/config/fusion-governance-shipped-config.test.ts tests/config/writer.test.ts \
  tests/pipeline/handlers/cleanup.test.ts tests/doctor/usefulness-feedback-loop-check.test.ts \
  tests/search/fuse.test.ts
  -> 7 files, 164 tests passed

vitest run tests/eval/retrieval-eval.test.ts tests/search/
  -> 14 files, 203 tests passed (ADR-005 recall@10/NDCG@10 floors hold —
     ranking is byte-identical at the shipped default, confirming the
     no-op-at-off posture)

vitest run tests/server/queries/agent-profile.test.ts tests/server/queries/user-profile.test.ts \
  tests/mcp/ tests/server/routes/search.test.ts
  -> 8 files, 108 tests passed (every other usefulnessScores() call site)

vitest run tests/config/ tests/eval/eval-evidence.test.ts \
  tests/e2e/usefulness-feedback-loop.e2e.test.ts tests/e2e/profile-learning.e2e.test.ts
  -> 16 files, 173 tests passed

vitest run tests/doctor/ tests/pipeline/
  -> 53 files, 457 tests passed
```

No full-suite run (slice-scoped per policy) — every changed file and every
known call site of the touched functions was covered.

## Risks / follow-ups

- **fuse.ts spread-collision fix is outside the literal dispatched file
  list** but was a structurally forced consequence of adding `usefulness`
  to `Config['search']` per the design — without it, this branch would have
  silently broken every real search ranking call in production (not a test
  gap; `tests/search/fuse.test.ts`'s own collision only surfaced because the
  same pattern exists in product code). Called out prominently for reviewer
  attention; recommend explicit sign-off on this specific diff.
- **Design Build Sequence phase 6** (a synthetic eval fixture in
  `tests/eval/retrieval-eval.test.ts` proving the implicit path clears the
  ADR-005 floors, to eventually back a `RECORDED_EVAL_EVIDENCE` entry) is
  **not done** in this pass — it's the input to a future decision to flip
  `enabled: true`, not required for this slice's acceptance criteria (the
  mechanism ships OFF, governance-gated, matching η's own shipped state).
  Flagging as the natural next slice: add the fixture, run the harness,
  record evidence, then flip a real config.
- **No production config currently sets `implicitPositive.enabled: true`** —
  confirmed via the shipped-default hard-gate test. Doctor's live canary
  state is therefore unchanged until that follow-up work happens.
- `UsefulnessSurface` widened to add `'system'` (additive, non-breaking) per
  the design's explicit recommendation — no exhaustive switch elsewhere in
  the codebase depended on the prior 3-member union (verified by grep).

## Suggested Next Handoff

`crew:reviewer` for independent review, with explicit attention to the
`fuse.ts` fix. If green, `crew:validator` is optional (no user-visible
behavior changed at the shipped `enabled:false` default — ADR-005 floors
already prove byte-identical ranking).
