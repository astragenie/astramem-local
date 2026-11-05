# Handoff: SLICE-445 (FEAT-553) — Extend backfill core to the project column and the sessions table, dry-run only

- **Objective**: generalise `runRepoIdentityBackfill` (FEAT-484) so it can
  scan + re-stamp `memories.project` (not just `repo`) and, optionally, the
  originating `sessions.<column>` row too, using the DEC-017 trust-gated
  resolver (`resolveRepoIdentity(cwd)` first, then a string-heuristic
  fallback trusted ONLY for the two tool-generated worktree layouts). This
  slice is code + tests only — no production datadir apply (SLICE-447 owns
  that, operator-gated).
- **Owner**: builder (this dispatch, wave 2)
- **Worktree**: `C:\work\mega\astramem-local-SLICE-445-0`
- **Branch**: `main-SLICE-445`
- **Base**: `main` @ `a40d1d39`

## Allowed scope (per slice `touches_files`) — respected exactly

- `src/tag-hygiene/repo-identity-backfill.ts`
- `src/cli/repo-identity-backfill.ts`
- `src/cli/index.ts`
- `tests/tag-hygiene/repo-identity-backfill.test.ts`
- (plus this handoff / review / validation artifact under `.claude/artifacts/crew/`)

`git status --porcelain` at commit time shows exactly those 4 source/test
files — nothing else was touched. A `bun run test` side effect that
rewrites `scripts/eval/consolidation-bench/results/latest-run.json`'s
`generatedAt` timestamp (the same pre-existing non-idempotent-suite issue
SLICE-443's handoff flagged) was reverted with `git checkout --` before
commit.

## Forbidden scope — respected

- `src/server/routes/ingest.ts` and `src/pipeline/derive-project.ts` (owned
  by sibling SLICE-444, dispatched in parallel against a separate
  worktree) — not touched.
- No migration file — no schema change was made or needed.
- No `--yes` run against any real datadir, and the production
  `%LOCALAPPDATA%\Astramem` dir was never opened or referenced by any test
  or manual command run in this session.
- `src/pipeline/cwd-basename.ts` was read but NOT edited — the trust-shape
  check needed for DEC-017 rule (1) is reimplemented locally in
  `repo-identity-backfill.ts` (see "Design decision" below) specifically
  because that file is out of this slice's touched-files scope.

## Deliverable — what changed and why

### `src/tag-hygiene/repo-identity-backfill.ts` (core, generalised)

- `RepoIdentityBackfillOptions` gained `column?: 'repo' | 'project'`
  (default `'repo'`) and `includeSessions?: boolean` (default `false`).
  Calling with neither option reproduces FEAT-484's exact default target
  and never touches `sessions` — existing callers are unaffected.
- `RepoIdentityBackfillCandidate` fields `currentRepo`/`resolvedRepo` were
  renamed to `currentValue`/`resolvedValue` (column-generic — the type now
  serves either column). `joiningExistingCount`, `applied`, `reason` are
  unchanged in meaning.
- `RepoIdentityBackfillResult` gained `column` (echoes the option actually
  used) and `sessionsRestamped` (count of DISTINCT `sessions` rows that
  were, or in a dry run would be, re-stamped — always `0` when
  `includeSessions` is `false`).
- The resolver is now `resolveRepoIdentity(cwd) ?? (trusted-shape ?
  deriveWorktreeSafeBasename(cwd) : null)` — git identity wins when it can
  answer (unchanged from FEAT-484); when it can't (most commonly a worktree
  already deleted by the time backfill runs), a string-derived name is
  trusted ONLY when `cwd` structurally matches one of the two DEC-017-named
  layouts (`<repo>/.claude/worktrees/<x>`, `<repo>-worktrees/<x>`) — see
  "Design decision" below for why this is an explicit gate rather than
  relying on the pre-existing `resolved === row.value` equality guard.
- `sessions.<column>` re-stamping piggybacks on memory candidates: for
  every applied/would-apply candidate whose session's own `<column>`
  value still differs from the resolved value, that session id is queued
  (deduped — one update per session, however many memories share it) and,
  outside dry-run, updated with one `UPDATE sessions SET <column> = ?
  WHERE id = ?` per queued session.
- `column` is validated against the `'repo' | 'project'` union at runtime
  (not just by the TS type) before being interpolated into any SQL string
  — defensive, since this is a maintenance tool that mutates the DB.

### Design decision: explicit trust-shape gate, not implicit equality

The slice text's resolver formula (`resolveRepoIdentity(cwd) ??
deriveWorktreeSafeBasename(cwd)`) is unconditional — `cwd-basename.ts`'s
plain-last-segment passthrough fires for ANY unrecognised shape, not just
the two trusted ones. In the real-world case this is harmless (the stored
bad value was itself captured as `basename(cwd)`, so the passthrough
always reproduces the SAME string and the pre-existing `resolved ===
row.value` guard catches it as `unresolved`), but that safety is
*incidental*, not structural — a row whose current value doesn't happen to
equal `basename(cwd)` could otherwise be silently "resolved" to an
untrustworthy guess. AC-4 explicitly names "cwd contains no recoverable
`.claude/worktrees/<x>` or `<name>-worktrees/<x>` segment" as its own
`unresolved` condition (independent of the no-session/no-cwd conditions),
so this implementation adds `isTrustedWorktreeCwdShape()` — a local,
read-only structural check mirroring (not reimplementing the extraction
logic of) `deriveWorktreeSafeBasename`'s two special-cased branches — and
only calls that function's result "resolved" when the shape check passes.
`cwd-basename.ts` is out of this slice's touched-files scope, so the check
is duplicated rather than exported from there; a natural follow-up (not
taken here, to respect scope) would hoist a shared `isWorktreeShapedCwd`
helper into `cwd-basename.ts` for both callers to import.

### `src/cli/repo-identity-backfill.ts`

- New flags: `--column repo|project|all` (invalid value exits 1 with a
  clear message, matching the existing `--limit`/`--pattern` validation
  style) and `--sessions` (boolean, via the existing `hasFlag` helper).
  `--column all` runs two independent single-column passes (repo, then
  project) and reports each separately — never merges their counts, so
  each stays independently auditable (this is the composition the new
  "`--column all` composition" test in the core test file documents and
  exercises at the `runRepoIdentityBackfill` level, since the CLI itself
  opens the real runtime DB and has no existing test harness — see
  "Known gap" below).
- `--json` output: single column (the default) still returns the bare
  `RepoIdentityBackfillResult` object exactly as before (byte-compatible
  for existing scripts); `--column all` returns `{ repo: {...}, project:
  {...} }`.
- Human-readable preview output gained a `Sessions
  (would be/were) re-stamped: N` line and is now column-labelled; it still
  **never prints `candidate.cwd`** (the only full filesystem path the data
  shape carries) — only resolved/current values, which are basenames by
  construction. This is the AC-9 posture; see the file's own header
  comment for the explicit statement.

### `src/cli/index.ts`

- Updated the `repo-identity-backfill` case's inline usage comment and the
  `--help` catalogue entry to document `--column`/`--sessions` and the
  DEC-017-gated fallback. No behavioural change in this file beyond the
  doc text — the dispatch still just forwards `rest` to
  `repoIdentityBackfillCommand`.

### `tests/tag-hygiene/repo-identity-backfill.test.ts`

Rewritten with the renamed field names and extended with (grouped by
`describe` block):

- **repo column (default)** — the 6 pre-existing FEAT-484 cases, updated
  to the new field names; behaviour is unchanged for every one of them
  (all use REAL git worktrees that still exist on disk, so git resolution
  wins and the new fallback path is never reached).
- **AC-4 no-session / no-cwd / unresolved** — three new, explicit cases,
  one per reason. The pre-existing "MIGRATION HAZARD guard" case (a
  deleted-worktree cwd that happens to structurally match the trusted
  nested layout) was **intentionally changed**, not just renamed: under
  DEC-017 that case must now RESOLVE via the string heuristic rather than
  stay `unresolved` — the test's expectations were updated to assert the
  new, correct behaviour, and a separate genuinely-untrusted-shape case
  was added to cover the old test's original intent.
- **project column** — dry-run, apply, idempotent-second-run, and a
  column-isolation case (operating on `project` never touches `repo` on
  the same row, and vice versa).
- **includeSessions re-stamp** — dry-run (no mutation), apply for both
  columns, a dedup case (3 memories sharing 1 session → `sessionsRestamped
  === 1`, not 3), a default-off case (byte-identical to FEAT-484 when the
  option is omitted), and a no-spurious-count case (a session already
  carrying the resolved value is not re-counted or rewritten).
- **`--column all` composition** — a single test proving the two
  single-column passes the CLI composes are independent (repo- and
  project-mis-tagged rows in the same DB, each column's pass only ever
  touches its own column).

## Evidence

- `bun install` — 297 packages, clean (fresh `node_modules` in this
  worktree, not shared with the main checkout, per the dispatch's HARD
  RULE).
- `bun run build` (`tsc -p .`) — clean, no output, after every edit.
- `bunx vitest run tests/tag-hygiene/repo-identity-backfill.test.ts` —
  **21/21 passed** (was 7 tests pre-slice; 14 new).
- `bunx vitest run tests/tag-hygiene/repo-identity.test.ts
  tests/pipeline/cwd-basename.test.ts tests/tag-hygiene/derive-repo.test.ts`
  — **31/31 passed** (sibling modules this slice imports from but does not
  edit — confirmed no regression).
- `node contracts/validate.mjs` — 58/58 fixture checks pass.
- `bun run test` (full suite, `vitest run`) — first pass surfaced 88
  failures across 10 files; root cause confirmed to be a **pre-existing
  operator-shell environment variable, `ASTRA_SKIP_CONSOLIDATE=1`**, NOT
  this slice's change (none of the 10 failing files import anything this
  slice touches — confirmed by `grep -rn "repo-identity-backfill"` showing
  only the 3 scoped consumers). `docs/memory.md` already documents this
  exact trap and its workaround (added by SLICE-443's wave, 2026-11-05):
  `env -u ASTRA_SKIP_CONSOLIDATE bun run test`. Re-run that way: **5819
  passed, 3 failed, 19 skipped** — the 3 failures are
  `tests/service/shim.test.ts` Windows real-subprocess watchdog-wrapper
  timing tests, exactly the "down to 3 environmental
  tests/service/shim.test.ts timeouts once unset" baseline docs/memory.md
  already records. This slice introduces **zero new test failures**.
- `git status --porcelain` — exactly the 4 scoped source/test files
  modified; the known non-idempotent
  `scripts/eval/consolidation-bench/results/latest-run.json` side effect
  from running the full suite was reverted with `git checkout --` before
  commit (same issue SLICE-443's handoff flagged, same fix).

## AC checklist (ACs scoped to this slice per the slice file: AC-4, AC-6, AC-8, AC-9)

- **AC-4** (no-session / no-cwd / unresolved never-guess guard preserved):
  PASS — three dedicated tests, one per reason; the genuinely-untrusted-
  shape case proves the DEC-017 trust boundary is enforced structurally,
  not by incidental string equality. Evidence: the "AC-4" describe block,
  3/3 passing.
- **AC-6** (preview is default, `--yes` required to mutate, preview
  reports scanned/would-re-stamp/unresolved + `joiningExistingCount`, two
  dry runs are byte-identical): PASS at the core-function level — every
  new test calls the core with `dryRun: true` first and asserts zero
  mutation, and the pre-existing `joiningExistingCount` test is unchanged
  and still passes. `--yes`-gating and the CLI's preview text were
  extended (see "Deliverable" above) but not exercised by a new automated
  CLI-level test — see "Known gap" below for why and the mitigation
  (manual verification done in this session).
- **AC-8** (post-apply counts match reported `unresolved`, nothing
  silently left behind): PASS by construction — `scanned = applied +
  unresolved` is an algebraic invariant of the loop (every scanned row
  takes exactly one of the three paths), verified across every test's
  assertions; no test found a row unaccounted for. The dashboard-side half
  of this AC (`queryProjectOptions`, `src/server/queries/dashboard.ts`) is
  untouched — out of this slice's scope by the slice's own text ("the
  remaining FEAT-553 ACs are owned by sibling slices").
- **AC-9** (preview output / override log never shows an absolute path,
  only a repo-root basename): PASS — the CLI's human-readable output path
  was audited line-by-line; the only values printed are
  `currentValue`/`resolvedValue` (basenames by construction of the
  resolver) and ids; `candidate.cwd` (the one full-path field in the data
  shape) is never written to console output. Documented explicitly in the
  CLI file's header comment. The AC-7 override-log-event half belongs to
  sibling SLICE-444.

## Known gap (flagged, not fixed — out of this slice's scope)

- There is no CLI-level (`tests/cli/repo-identity-backfill.test.ts`) test
  file for this command — not for FEAT-484 either, and still not after
  this slice, because `repoIdentityBackfillCommand` calls
  `openRuntimeDb()` directly (no DB-injection seam) and the slice's
  `touches_files` allowlist does not include a new CLI test file. `--yes`
  gating, `--column all`'s two-pass composition, and the new preview text
  were verified by (a) static code review, (b) a tiny isolated Node script
  exercising the exact `parseArg`/`hasFlag` logic copied into the CLI file
  (confirmed `--column`/`--sessions` parsing matches intent), and (c)
  running `node dist/cli/index.js --help` to confirm the help text renders
  correctly — not by an automated CLI-level test. A future slice adding a
  DB-injectable seam to `repoIdentityBackfillCommand` (and the matching
  test file) would close this gap for every command in `src/cli/`, not
  just this one — worth a backlog note, not filed as a new FEAT by this
  slice (same posture SLICE-443's handoff took for its own non-blocking
  follow-up).

## Confidence level

High. The core logic change is small and well-isolated (one resolver
function, one new local trust-shape check, straightforward column/session
generalisation of an existing, already-reviewed loop); every behavioural
claim above is backed by a passing test in the same commit; the full
suite is at documented baseline health.

## Risks / open questions

- The `--column all` CLI composition and `--sessions`/`--yes` CLI-layer
  argument handling are verified by code review + the isolated parsing
  check above, not by an automated CLI test (see "Known gap"). Reviewer
  should re-check that reading if closing this gap is wanted before
  SLICE-447 (the operator-gated prod apply) runs against real data.
- `isTrustedWorktreeCwdShape()` duplicates ~15 lines of structural logic
  that conceptually belongs in `cwd-basename.ts` (out of scope here) — a
  future slice could hoist a shared, exported predicate there instead.

## Suggested next handoff

- SLICE-447 (operator-gated prod apply): can proceed once this slice's
  review/validation land — it should call `runRepoIdentityBackfill` with
  `column: 'all'`-equivalent (two calls) and `includeSessions: true`
  against a real (backed-up) datadir, using the preview output's
  `sessionsRestamped` + `joiningExistingCount` figures as its own
  pre-apply sign-off evidence.
