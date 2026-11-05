# Handoff: SLICE-444 (FEAT-553) — ingest-side `project_id` override at the 3 session-upsert call sites + override log event

- **Objective**: fix the `project` half of the FEAT-553 provenance leak at
  ingest time — re-derive `sessions.project` when the client-sent
  `project_id` is exactly the hook-produced `basename($CWD)` shape (DEC-017
  rule 2), and emit a structured log event on every override (DEC-017
  rule 3), implementing it identically at all three session-upsert call
  sites in `src/server/routes/ingest.ts`.
- **Owner**: builder (this dispatch, wave 2)
- **Worktree**: `C:\work\mega\astramem-local-SLICE-444-0`
- **Branch**: `main-SLICE-444`
- **Base**: `main` @ `a40d1d39`

## Allowed scope (per slice `touches_files`)

- `src/pipeline/derive-project.ts`
- `src/server/routes/ingest.ts`
- `tests/pipeline/derive-project.test.ts`
- `tests/tag-hygiene/worktree-ingest-canary.test.ts`
- `tests/server/ingest.test.ts`

No other source/test file was touched. (`scripts/eval/consolidation-bench/
results/latest-run.json`'s `generatedAt` timestamp gets rewritten as a
pre-existing side effect of running the full-repo test suite on this box —
same non-idempotent-full-suite behavior SLICE-443's handoff already flagged
— and was reverted with `git checkout --` before the final commit so it
never lands in this slice's diff.)

## Design decisions (worth citing explicitly, since the slice text left
   some of the wiring under-specified)

1. **`reconcileIngestProject({ projectId, cwd, repo })` → `{ project,
   overridden, source }`** (`src/pipeline/derive-project.ts`), alongside the
   pre-existing `deriveProject`. Implements DEC-017 rule 2 exactly:
   - Compares `projectId` against the **plain** `basename(cwd)` (the
     literal `basename "$CWD"` value the capture hooks stamp) — deliberately
     NOT `deriveWorktreeSafeBasename(cwd)`, which would already resolve a
     worktree path to the repo name and could never equal the hook's raw
     output for a worktree cwd. A new unexported `plainBasename()` helper in
     the same file does this (cross-platform, mirrors `cwd-basename.ts`'s
     own separator handling, but is not that file — `cwd-basename.ts` is
     SLICE-442's file and stayed untouched, consumed only via its existing
     export).
   - No match (or no `cwd`, e.g. the legacy envelope) → verbatim passthrough,
     `overridden: false` (AC-5).
   - Match → derived replacement = `repo` (trusted as the git-resolved
     signal) when truthy, else `deriveWorktreeSafeBasename(cwd)` — DEC-017
     rule 1's trust boundary stays exactly where SLICE-442 drew it, this
     slice adds no new trusted shape.
   - `repo` **must** be the RAW git-only signal (`resolveRepoIdentity`/
     `resolveRepoIdentityAsync`), not the already-merged `deriveRepoFromCwd`
     value — otherwise `source` could never be attributed correctly (the
     merged value is truthy whenever EITHER git or the string heuristic
     answered, so "repo truthy" could no longer mean "git answered"). This
     is the one real design call the slice text left implicit; documented
     in the function's own doc comment for the next reader.
   - No-op guard: if the derived value is null or identical to `projectId`,
     `overridden` stays `false` (avoids logging a no-change "override").
2. **`applyProjectOverride(log, { projectId, cwd, repo })`** (private helper,
   `ingest.ts`) — thin wrapper that calls the above and, when it fires,
   logs `{ original, derived, source }` + msg `'ingest project_id
   overridden'` (AC-7). `session_id` is deliberately NOT re-stated in the
   payload — `log` is required to already carry it as a **bound** field
   (`childLogger({ session_id, ... })`), matching this file's existing
   convention instead of duplicating the key on every call (verified this
   avoids the duplicate-key JSON line a first draft produced — see Risks).
3. **Wired at all three call sites**, exactly as the slice named them:
   - `ingestCanonicalTranscript` (~line 468, the shared transcript-kind
     path reached both by the live HTTP route and by `spool-drain.ts`) —
     `resolveRepoIdentity(data.cwd)` read a second time here; it is always a
     cache hit (`src/tag-hygiene/repo-identity.ts`'s module-level cache is
     shared between the sync/async entry points and `sessionRepo` just
     above already warmed it for this exact `cwd`), never a second `git`
     spawn.
   - The inline events-kind (ADR-008) branch (~line 782 pre-edit, now
     ~841) — same pattern with `resolveRepoIdentityAsync`, reusing the
     route's already-bound `log`.
   - The legacy envelope path (~line 996 pre-edit, now ~1066) — applied for
     consistency across "the 3 call sites" per the slice text, but the
     legacy schema has no `cwd` field at all, so `reconcileIngestProject`
     always short-circuits to a verbatim passthrough here — confirmed a
     guaranteed no-op, not exercised with a real override in testing (see
     AC checklist).

## Deliverable — files changed (552 insertions / 20 deletions across 5 files)

- `src/pipeline/derive-project.ts` (+110) — `reconcileIngestProject` +
  `plainBasename` + supporting types/doc comments; `deriveProject` itself
  untouched.
- `src/server/routes/ingest.ts` (+88/-?) — 2 new imports
  (`resolveRepoIdentity`/`resolveRepoIdentityAsync` from
  `../../tag-hygiene/repo-identity.js`, `reconcileIngestProject` from
  `../../pipeline/derive-project.js`), `applyProjectOverride` helper, and
  the override wired into all 3 upsert call sites.
- `tests/pipeline/derive-project.test.ts` (+107) — 9 new `it` blocks for
  `reconcileIngestProject` (AC-1 shape w/ git source, string-heuristic
  fallback, sibling-worktree shape, AC-5 verbatim label, no-cwd no-op,
  identical-value no-op, null-derived no-op, null/undefined `projectId`
  passthrough, POSIX nested shape).
- `tests/tag-hygiene/worktree-ingest-canary.test.ts` (+87/-20) — extracted
  the git/worktree scaffold into a shared `makeWorktreeFixture()` helper;
  original test now also asserts `sessions.project` stays `'proj-canary'`
  (AC-5 at the route level, real worktree, no real override); new test
  asserts AC-1 exactly as specified (`project_id === basename(cwd)` →
  `sessions.project = 'astramemory-local'`, matching `sessions.repo`, real
  git `--git-common-dir` resolution → `source: 'git-common-dir'` confirmed
  in the raw log line during the test run).
- `tests/server/ingest.test.ts` (+180) — module-wide `childLogger`/`logger`
  mock (same pattern as `tests/server/score-contract.test.ts`) + a new
  4-test `describe` block: AC-5 (verbatim, no log event), AC-7/AC-9
  (override fires at the transcript-kind call site, log event fields
  asserted directly off the mock, every string field checked to contain no
  path separator), events-kind call site parity, legacy call site no-op.

## Evidence

1. `bun install` — 297 packages, clean (fresh `node_modules`, not shared
   with the main checkout).
2. `bun run build` (`tsc -p .`) — clean, no diagnostics, both before and
   after every edit round.
3. `bun run typecheck:tests` (`tsc -p tsconfig.tests.json`) — clean.
4. `bunx vitest run tests/pipeline/derive-project.test.ts
   tests/tag-hygiene/worktree-ingest-canary.test.ts
   tests/server/ingest.test.ts` — **78/78 pass** (23 + 2 + 53).
5. `bun run test` (whole-repo vitest run), run #1 — **87 failed / 5735
   passed** across 426 files. Investigated before accepting: every single
   failure is in `tests/consolidate/*`, `tests/mcp/server.test.ts`
   (consolidation-roundtrip cases), or `tests/service/shim.test.ts`
   (win32 watchdog-probe timeouts) — confirmed via
   `env | grep -i astra` that `ASTRA_SKIP_CONSOLIDATE=1` was leaking into
   the shell from OUTSIDE this dispatch (not set by anything in this
   session) — exactly the trap `2a2c981c` (wave-1 close commit, already on
   `main`) warned about. Zero failures in any of this slice's 5 touched
   files.
6. `bun run test`, run #2 (`ASTRA_SKIP_CONSOLIDATE` explicitly unset in the
   same shell) — see the validation artifact for the clean-baseline result;
   launched as the last step of this build and its result is recorded
   there rather than re-derived here.
7. `git diff --name-only a40d1d39..HEAD` / `git log --format=%h
   a40d1d39..HEAD` — see the StructuredOutput return for the exact lists
   (this handoff is written before the final commit).

## AC checklist (builder's own pass — independent re-verification is the
   validation artifact's job)

- **AC-1**: PASS — `tests/tag-hygiene/worktree-ingest-canary.test.ts`'s new
  test, real git worktree, `project_id === basename(cwd)` →
  `sessions.project = 'astramemory-local' = sessions.repo`, neither equals
  the agent hash.
- **AC-5**: PASS — covered 3x: `reconcileIngestProject` unit test (pure),
  the (extended) original canary test (real worktree, route-level), and
  `ingest.test.ts`'s new AC-5 test (route-level, no-git worktree-shaped
  cwd) — a deliberate label never equal to `basename(cwd)` is always
  verbatim and never logged.
- **AC-7**: PASS — `ingest.test.ts`'s AC-7 test asserts the exact event
  shape (`original`, `derived`, `source`) and message string off the
  mocked `childLogger`'s `.info()` call; `source: 'string-heuristic'`
  there (no real git at that path) and `source: 'git-common-dir'`
  independently confirmed in the canary test's real-git scenario (visible
  in that test run's raw log line).
- **AC-9**: PASS — same AC-7 test asserts every string field on the logged
  event contains no `\` or `/`; `cwd` itself is never passed to the logger
  (verified by reading `applyProjectOverride`'s only `log.info(...)` call —
  three fields only, no `cwd`).

## Risks / follow-ups

- **Not independently reviewed yet** — the dispatch's own fallback clause
  applies (no separate `crew:reviewer`/`crew:verifier` dispatch tool
  available in this run); a same-dispatch cold-read review and the run #2
  full-suite validation are written as separate artifacts, same convention
  SLICE-442/443 used.
- `docs/memory.md`'s FEAT-553 bullet is **not** updated by this slice —
  that write-back is SLICE-446's scope (already landed, commit
  `99e9352c` + follow-up fix `0a4d3b31`) and is out of this slice's
  `touches_files` allowlist; flagged, not fixed here.
- `reconcileIngestProject`'s `source` attribution relies on the caller
  passing the RAW git-only signal, not the merged `deriveRepoFromCwd`
  value — if a future call site passes the merged value instead, every
  override would report `source: 'git-common-dir'` even when the string
  heuristic actually answered. The function's own doc comment flags this
  contract explicitly for the next caller.
- SLICE-445 (backfill extension) and SLICE-447 (prod apply) are the
  remaining FEAT-553 slices and depend on this one's `reconcileIngestProject`
  only by convention (DEC-017), not by import — no code coupling to track.

## Suggested next handoff

- `crew:reviewer` (or the same-dispatch fallback) over this diff against
  DEC-017 and AC-1/5/7/9.
- `crew:verifier` / validator: the run #2 (`ASTRA_SKIP_CONSOLIDATE` unset)
  full-suite result, recorded as a separate validation artifact.
- Slice close ceremony (`/devcrew:slice complete --id SLICE-444` or
  equivalent) once review + validation both land PASS.
