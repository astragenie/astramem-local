---
slice: SLICE-444
feature: FEAT-553
reviewer: independent-correctness-review (same-dispatch fallback — no
  Agent/Task dispatch tool was available to this run to spawn a separate
  crew:reviewer; per the dispatch instruction's own fallback clause, this
  review was done by re-reading the diff cold against the slice's ACs and
  DEC-017, independently of the builder narrative in the handoff — same
  convention SLICE-442/443 used)
branch: main-SLICE-444
base: main @ a40d1d39
worktree: C:\work\mega\astramem-local-SLICE-444-0
date: 2026-11-05
verdict: PASS
---

# SLICE-444 correctness review — ingest-side `project_id` override + log event

## Scope of diff (vs main @ a40d1d39)

Exactly the 5 files in the slice's `touches_files`, no scope creep:

- `src/pipeline/derive-project.ts` (+110) — new `reconcileIngestProject` +
  `plainBasename`; pre-existing `deriveProject` untouched.
- `src/server/routes/ingest.ts` (+88/-2) — 2 new imports, `applyProjectOverride`
  helper, wired at all 3 session-upsert call sites.
- `tests/pipeline/derive-project.test.ts`, `tests/server/ingest.test.ts`,
  `tests/tag-hygiene/worktree-ingest-canary.test.ts` — test-only.

`scripts/eval/consolidation-bench/results/latest-run.json` was touched by
the full-suite run (pre-existing non-idempotent side effect, already
flagged in SLICE-443's own handoff) and reverted before this review —
confirmed absent from `git status --porcelain` at review time.

## Logic read — `reconcileIngestProject`

```ts
if (!projectId) return { project: projectId ?? null, overridden: false };
const cwdBasename = plainBasename(cwd);
if (!cwdBasename || projectId !== cwdBasename) return { project: projectId, overridden: false };
const derived = repo ? repo : deriveWorktreeSafeBasename(cwd);
const source = repo ? 'git-common-dir' : 'string-heuristic';
if (!derived || derived === projectId) return { project: projectId, overridden: false };
return { project: derived, overridden: true, source };
```

- **DEC-017 rule 2 (conservative override)**: the equality gate compares
  against `plainBasename(cwd)` — a NEW, deliberately separate helper from
  `deriveWorktreeSafeBasename`. This distinction matters and is correct:
  `deriveWorktreeSafeBasename` already resolves a worktree path to the
  REPO name, so for a worktree `cwd` it could never equal the hook's raw
  `basename "$CWD"` output — using it for the equality check would make
  the override NEVER fire for the exact bug case AC-1 describes. Using the
  plain literal basename instead is the right call. Verified `plainBasename`
  itself: strips trailing separators, splits on both `\` and `/`, filters
  empty segments, returns the last one or `null` — correct cross-platform
  behavior, matches `cwd-basename.ts`'s own separator handling without
  duplicating that file's worktree-shape logic (which stays untouched, per
  scope: "consume, do not edit").
- **AC-5 (never clobber an explicit label)**: `projectId !== cwdBasename`
  short-circuits to verbatim BEFORE any derivation runs. Correct — an
  explicit different label can never reach the override branch regardless
  of what `repo`/git says.
- **No-cwd no-op (legacy envelope)**: `plainBasename(undefined) === null`
  → `!cwdBasename` is true → verbatim passthrough. Confirmed this is
  exactly what the legacy call site in `ingest.ts` exercises (`cwd:
  undefined` passed explicitly) — the function never reaches the
  `derived`/`source` computation there, so the `repo` value passed at that
  call site (the legacy envelope's own client-sent `repo` field, NOT a
  git-resolved signal) is never actually consumed. Vestigial parameter at
  that one call site, not a bug — the early return makes it dead on that
  path by construction, not by a lucky accident of the values involved.
- **`source` attribution correctness**: this is the one real design
  judgment call the slice text left implicit (it says "repo if
  git-resolved, else `deriveWorktreeSafeBasename(cwd)`" without saying
  how a caller signals "git-resolved"). The implementation's choice —
  `repo` must be the RAW `resolveRepoIdentity`/`resolveRepoIdentityAsync`
  return value, not the already-merged `deriveRepoFromCwd` value — is
  correct and is the only choice that makes `source` actually accurate
  (merging first would make `repo` truthy whenever EITHER signal
  answered, destroying the git-vs-string distinction DEC-017 rule 3 wants
  measured). Confirmed both `ingest.ts` call sites honor this contract:
  Site 1 passes `resolveRepoIdentity(data.cwd)` (raw, sync), Site 2 passes
  `await resolveRepoIdentityAsync(data.cwd)` (raw, async) — neither passes
  `sessionRepo` (the merged value) by mistake.
- **No-op guards**: `!derived || derived === projectId` correctly suppresses
  a spurious `overridden: true` when nothing would actually change (e.g. a
  plain non-worktree cwd whose basename happens to already equal
  `project_id`, or when both git and the string heuristic come up empty).
  Verified by the "identical-value" and "null-derived" unit tests.

## Logic read — `ingest.ts` wiring

- **Cache-hit claim verified, not just asserted in a comment.** Re-read
  `src/tag-hygiene/repo-identity.ts`: `resolveRepoIdentity` and
  `resolveRepoIdentityAsync` share one module-level `cache` Map
  (`cacheGet`/`cacheSet` both read/write it), and `resolveRepoIdentityAsync`
  checks that cache before touching `pending`/spawning. At Site 1, when
  the HTTP route is the caller, `resolvedRepo` arrives already resolved via
  `deriveRepoFromCwdAsync` (awaited BEFORE calling `ingestCanonicalTranscript`
  — confirmed at the route's own call site), which warms the cache for
  `data.cwd` before this function's body ever runs; when spool-drain is
  the caller (`resolvedRepo` undefined), the function's own
  `deriveRepoFromCwd(data.cwd)` on the line immediately above warms the
  same cache first. Either way, the subsequent `resolveRepoIdentity(data.cwd)`
  for the override is a guaranteed Map lookup — the "never a second git
  spawn" claim in the comments holds structurally, not just in the common
  case. Same reasoning holds for Site 2's async pair.
- **All 3 call sites wired**, matching the slice's own line references
  (now shifted by the edits, but same logical sites): `ingestCanonicalTranscript`'s
  `stmtUpsertSession.run`, the inline events-kind branch's
  `stmtUpsertSession.run`, and the legacy `stmtUpsertSessionLegacy.run`.
  Each passes the reconciled project value instead of the raw
  `data.project_id`/`project`, and nothing else in those call argument
  lists changed (`sessionRepo`, `agent_type`, `cwd`, `now` all untouched).
- **AC-9 structurally guaranteed, not incidental.** The only `log.info`
  call logs `original` (gated to equal `plainBasename(cwd)`, which by
  construction never contains a path separator), `derived` (either `repo`
  — `resolveRepoIdentity` always returns `basename(repoRoot)`, never a
  full path — or `deriveWorktreeSafeBasename(cwd)`, likewise always a
  basename), and `source` (a fixed string-literal union). `cwd` itself is
  never passed to the logger. None of the three fields can ever be a full
  path regardless of what the client sends, because the override only
  fires when `original` already equals a basename.
- **`session_id` binding, not restated.** `applyProjectOverride` relies on
  the caller's `log` already carrying `session_id` as a bound field
  (`childLogger({ session_id, ... })` at both Sites 1 and 2) rather than
  re-stating it in the `.info()` payload — avoids the duplicate-JSON-key
  line a first-draft version of this code produced (visible if you diff
  an intermediate commit, not in the final diff). Clean.

## Risk noted (not blocking)

- **Idempotent replay still logs an override event even though no DB
  write happens.** At Site 1, `gitRepoForOverride`/`applyProjectOverride`
  run BEFORE `db.transaction()`, same as the pre-existing `sessionRepo`
  computation on the line directly above it. If the same idempotency key
  + body is replayed, the transaction throws `IdempotentReplayError`
  before `stmtUpsertSession.run` ever executes, but the override log line
  (if the payload matches the override shape) already fired on the
  line before. This is an INHERITED pattern, not a new defect — `sessionRepo`
  already has identical hoisted-before-tx-even-on-replay behavior, and
  fixing it would mean moving override detection past the idempotency
  check, which the file's own event-loop-blocking constraints (no sync git
  work inside `db.transaction()`) make awkward without a larger
  restructure outside this slice's narrow scope. Worth a one-line note for
  whoever eventually re-derives override-rate metrics from the logs (a
  replayed request could double-count), not a blocker for this slice.

## Test read

- `tests/pipeline/derive-project.test.ts`: 9 new cases cover the override
  firing (git-sourced and string-heuristic-sourced), the sibling worktree
  shape, AC-5 verbatim, the no-cwd no-op, both no-op-guard branches
  (identical value, null derived), and null/undefined `projectId`
  passthrough. Good coverage of the pure function's branches.
- `tests/tag-hygiene/worktree-ingest-canary.test.ts`: real git + real
  linked worktree — the ONE place `source: 'git-common-dir'` is exercised
  against actual git output rather than a hand-constructed `repo` value.
  Confirmed the raw log line from this test run shows exactly that
  (`"source":"git-common-dir"`) — not just asserted, independently
  re-run during this review.
- `tests/server/ingest.test.ts`: route-level AC-5/AC-7/AC-9, plus explicit
  coverage of the events-kind and legacy call sites (the two sites the
  canary test doesn't reach). The module-wide `childLogger` mock mirrors
  `tests/server/score-contract.test.ts`'s existing pattern exactly — low
  risk of being a one-off convention.
- Re-ran all three files independently during this review:
  `bunx vitest run tests/pipeline/derive-project.test.ts
  tests/tag-hygiene/worktree-ingest-canary.test.ts tests/server/ingest.test.ts`
  → 78/78 pass.

## Verdict

**PASS.** DEC-017 rules 1-3 are implemented correctly and conservatively;
AC-1/5/7/9 all have direct test coverage (unit + 2 independent route-level
styles — real git and mocked-logger); no scope creep; the one risk noted
above is a pre-existing pattern this diff inherits rather than introduces,
and is low-severity (log-only, no data-correctness impact).
