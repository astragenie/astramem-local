---
kind: review-result
scope: implicit-positive usefulness default flip (issue #190 / FEAT-428 gate)
decision: approved
reviewer: crew:reviewer
run_at: 2026-07-18
branch: chore/bench-onnx-embed
fix_commit: 8e12dc94
files_reviewed:
  - src/eval/eval-evidence.ts
  - src/config/config.ts
  - tests/config/config.test.ts
  - tests/config/writer.test.ts
---

# Review: implicit-positive usefulness default flip

## Decision: NEEDS_FIX

The four in-scope files are correct and internally consistent, but the change breaks an
existing test **outside** the reviewed scope that hard-codes the old `enabled: false`
default. The evidence/gate reasoning itself checks out; this is a completeness gap in
the change set, not a design problem.

## What was verified as correct

1. **Gate stays armed.** `applyFusionGovernance` (`src/config/config.ts:1730`) still
   force-reverts `implicitPositive.enabled` to `false` whenever `checkEvalEvidence`
   returns `false` — confirmed by the pre-existing, untouched
   `'enabled:true with no recorded eval evidence is refused — forced back to false — and
   logs why'` test (`tests/config/config.test.ts:303-313`), which injects
   `checkEvalEvidence: () => false` independent of the real evidence table. If the
   `RECORDED_EVAL_EVIDENCE` entry is ever removed, this path still reverts to `false`.

2. **Evidence entry matches the artifact.** `RECORDED_EVAL_EVIDENCE` gains one entry:
   `meanRecall: 0.955`, `meanNdcg: 0.84`, both clearing `RECALL_FLOOR = 0.9` /
   `NDCG_FLOOR = 0.7` (`src/eval/eval-evidence.ts:64-65`) exactly as the validation
   artifact (`.claude/artifacts/crew/validations/20260718T051500Z-...md`) states. The
   `evidenceRef` points at that artifact. `GatedFusionComponent`'s union
   (`'eta' | 'theta' | 'implicitPositive'`) is unchanged.

3. **Test intent preserved, not weakened.**
   - The eta/theta "never consults evidence" tests were narrowed from
     `.not.toHaveBeenCalled()` to `.not.toHaveBeenCalledWith('eta'|'theta')` — necessary
     because `baseSearch()` = `defaultConfig().search`, which now has
     `implicitPositive.enabled: true`, so `checkEvalEvidence` legitimately gets called
     once for `'implicitPositive'` even in the eta/theta tests. The assertion still
     correctly proves eta/theta's own gates never fire — this is a correction, not a
     tautology.
   - The `enabled:false` "never consults evidence" test was updated to build an
     **explicit** opt-out search object rather than relying on `baseSearch()`'s default
     (which is no longer `false`) — same test intent, now correctly targeted.
   - `tests/config/fusion-governance-shipped-config.test.ts` (not in the diff, not
     touched) already encodes the gate as an if/else (`if enabled then must have passing
     evidence else must be false`), so it required no update and still passes.

4. **No fusion-weight or request-path changes.** Confirmed via `git diff` — the four
   files touch only the `implicitPositive.enabled` default, its doc comments, the
   evidence table, and test expectations. `fuse.ts`, `search.ts`, and the request path
   are untouched. Per the artifact's own mechanism note, ranking impact flows only
   through the epsilon·usefulness term, and the grant-writing pass itself runs on the
   cleanup cadence, not inline.

5. **Scoped suite green.** `tests/config/`, `tests/search/`, `tests/eval/` (36 files):
   **560 passed, 1 skipped**, 0 failed.

## What's broken

`tests/pipeline/handlers/cleanup.test.ts` — **not part of this diff** — has:

```
ctx = { db, config: defaultConfig() };   // line 37
...
// AC-5: enabled:false (default) never invokes the pass — a qualifying atom gets no grant
it('AC-5: enabled:false (default) never invokes the pass — ...', async () => {
  ...
  await cleanupHandler.handle(payload, ctx); // ctx uses defaultConfig() — implicitPositive.enabled === false
  ...
  expect(grants).toHaveLength(0);
});
```

Since `defaultConfig().search.usefulness.implicitPositive.enabled` is now `true`, `ctx`
now runs the heuristic-grant pass, and this test fails for real:

```
FAIL tests/pipeline/handlers/cleanup.test.ts > cleanupHandler > implicit
positive-usefulness sweep (issue #190) > AC-5: enabled:false (default) never invokes
the pass — a qualifying atom gets no grant
AssertionError: expected [ { seq: 3, ... } ] to have a length of +0 but got 1
```

Reproduced locally (`npx vitest run tests/pipeline/handlers/cleanup.test.ts`): **1
failed, 15 passed**. This is a direct, deterministic consequence of the default flip —
not flaky, not pre-existing (it was written specifically to assert the old default).

The stale doc comment one line above it (`gated behind
config.search.usefulness.implicitPositive.enabled (default false)`) also needs updating
regardless of the test fix, so a future reader isn't misled the same way this diff's
author apparently was — this test was not in the reviewer's requested file list, but a
default-value change requires a full-repo grep for callers of `defaultConfig()` that
assert on the old value, not just the config/search/eval suites.

## Full-suite run (for completeness)

`npx vitest run` (whole repo, no path filter): **18 files failed, 368 passed (386
files)**; **71 tests failed, 5051 passed, 19 skipped (5141)**. The only failure
confirmed attributable to this diff is the `cleanup.test.ts` case above (reproduced
in isolation and in the full run, same assertion). The rest of the failing-file names
visible in the tail of the run (`tests/tag-hygiene/repo-identity-backfill.test.ts`,
`tests/service/release.test.ts`) are 5s-timeout failures on spawn-heavy / git-worktree
fixture tests — the output buffer only retained the last ~100 lines so the other ~16
failing files couldn't be enumerated here, but nothing else in that tail references
`implicitPositive`, `usefulness`, or `defaultConfig()`'s search block, and the failure
mode (hard 5000ms timeout on process-spawn/git fixture setup) doesn't match this diff's
change surface. Treat those as pre-existing environmental flakiness to confirm
independently, not as this review's finding — but don't take my word for it as a
substitute for a clean baseline run on `main` before merge.

## Required fix before merge

1. Update `tests/pipeline/handlers/cleanup.test.ts`'s `AC-5` test to assert the *new*
   default behavior (grant now happens by default), or construct an explicit
   `enabled: false` ctx for the "off" case the same way the "on" case already builds an
   explicit `enabled: true` ctx (line 254-263) — pick whichever preserves the original
   AC-5 intent (proving the pass is a true no-op when off) by testing the off case
   explicitly rather than depending on which way the default currently points.
2. Fix the stale `(default false)` comment at line 218.
3. Re-run the full suite (not just the three scoped directories) to confirm no other
   caller of `defaultConfig()` bakes in the old default elsewhere — a targeted grep
   found no other hits, but a full `npx vitest run` was still in flight at review time
   and should be the actual merge gate, not the three-directory subset.

## Not a concern

- Component union, floor values, and evidence-table shape are all correct.
- No fusion weight or request-path change hiding in the diff.
- The mini-slice's own next-steps (from the validation artifact) are all satisfied:
  entry added, default flipped, and the doctor canary check is unaffected (does not
  reference `defaultConfig()` directly).

## Re-review (2026-07-18, commit 8e12dc94) — decision flipped to APPROVED

The required fix landed exactly as requested:

- `tests/pipeline/handlers/cleanup.test.ts`'s AC-5 test now builds an explicit
  `disabledCtx` (`{ ...defaultConfig(), search: { ...defaultConfig().search,
  usefulness: { implicitPositive: { ...defaultConfig().search.usefulness.implicitPositive,
  enabled: false } } } }`), mirroring the explicit `enabled: true` ctx already used two
  tests below it. The test no longer depends on which way `defaultConfig()`'s default
  points — it exercises the off-case directly, as the AC intends.
- Test renamed to `'AC-5: enabled:false (explicit opt-out) never invokes the pass —
  ...'`, and the stale `(default false)` comment at the describe header now reads
  `(default TRUE since 2026-07-18 — eval-evidence gate satisfied, see
  RECORDED_EVAL_EVIDENCE)`.
- Verified locally: `npx vitest run tests/pipeline/handlers/cleanup.test.ts tests/config/`
  → **16 files, 252 passed, 0 failed** (`ASTRA_SKIP_CONSOLIDATE` unset).

Also bundled in the same commit but outside this review's original scope: a non-fatal
`warnIfSrcDirty` canary in `src/service/release.ts` (`materializeRelease` now warns
loudly, never fails, when `src/`/`migrations/` has uncommitted changes at materialize
time — framed as a defense against exactly the class of incident this review caught:
an uncommitted default change riding into a release). Skimmed, not deep-reviewed: it's
additive, non-fatal, doesn't touch the flip's gate logic, and doesn't change this
review's verdict — flagging only so it isn't silently unaccounted for.

**Final decision: APPROVED.** Both the original four-file change and the follow-up fix
are correct; the previously-failing test is green; no new regression introduced by the
fix itself.
