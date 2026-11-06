# Handoff: SLICE-445 (FEAT-553) — Extend backfill core to the project column and the sessions table, dry-run only

> **Fix-pass addendum (2026-11-05, post-independent-verification):**
> independent verifiers refuted the original builder pass on four grounds —
> AC-8 had no test evidence at all (neither the GLOB-count property nor the
> dashboard-dropdown half); AC-6's named "two consecutive dry-runs produce
> identical counts" property had no test performing it (every existing
> idempotent-second-run test uses `dryRun: false` twice, not `dryRun: true`
> twice — the Validation artifact's claim otherwise was inaccurate and is
> corrected there); the CLI entry point (`repoIdentityBackfillCommand`) had
> zero automated coverage of `--column`/`--sessions`/`--yes`/`--json`
> wiring; and the Review artifact's "all 6 original tests pass unmodified...
> renamed fields only" overclaimed (base file had 7, one — MIGRATION HAZARD
> guard — was intentionally inverted per DEC-017 rule 4, not preserved).
>
> This fix pass closes all four within the SAME `touches_files` scope (no
> new file, no new allowance) by extending
> `tests/tag-hygiene/repo-identity-backfill.test.ts` with 14 new cases: 2
> for AC-6 (true two-consecutive-`dryRun:true` core tests, repo-default and
> project+`--sessions`), 3 for AC-8 (repo-column and project-column
> GLOB-count parity on both `memories` and `sessions`; a dashboard-dropdown
> test that imports the real, unmodified `queryProjectOptions` read-only —
> `src/server/queries/dashboard.ts` is still untouched), and a new
> `repoIdentityBackfillCommand` CLI-layer describe block (9 cases) run
> against a file-backed temp datadir via `ASTRA_MEMORY_DATADIR` (the same
> safe pattern `tests/cli/queue-purge.test.ts` already uses for a sibling
> `openRuntimeDb()`-based command — never the production datadir). The
> Review and Validation artifacts carry their own addenda correcting the
> specific inaccurate claims rather than silently rewriting history. See the
> updated "Evidence" and "AC checklist" sections below (marked inline) and
> the slice file's own in-scope bullet, corrected to state the DEC-017
> rule-(4) default-column behavior change precisely instead of the
> inaccurate blanket "byte-identical" phrasing.
>
> Not addressed by this fix pass (orchestration/ceremony concerns, outside
> a fix-agent's scope): the slice file itself is still in `pending/` with
> `status: pending` and `wave_attempts: 0`; `FEAT-553.md`'s
> `slices_complete` still omits SLICE-445; no `final-synthesis` artifact
> exists for this slice. The `/devcrew:slice complete` ceremony (moving the
> slice file, updating the feature file, writing final-synthesis) was not
> run here — that is the lead/orchestrator's step, not a code-correctness
> fix. Likewise, review and validation remain builder/fix-pass
> self-performed (no independently-dispatched reviewer/validator subagent
> ran in this session) — that governance gap is unchanged by this pass.

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
- (plus this handoff / review / validation artifact under `.claude/artifacts/crew/`,
  and — fix pass only — the slice file itself under
  `.claude/artifacts/loop/ai-loop/slices/pending/`, text-only, to correct
  the inaccurate "byte-identical" in-scope claim; no frontmatter/ceremony
  field touched)

`git status --porcelain` at original commit time showed exactly those 4
source/test files — nothing else was touched. A `bun run test` side effect
that rewrites `scripts/eval/consolidation-bench/results/latest-run.json`'s
`generatedAt` timestamp (the same pre-existing non-idempotent-suite issue
SLICE-443's handoff flagged) was reverted with `git checkout --` before
commit. The fix pass additionally touches the test file plus these three
artifact files and the slice file — still within the same `touches_files`
+ artifacts/slice-file allowance given to the fix agent.

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

**Fix-pass evidence (2026-11-05)**, additive to the above:

- `bun run build` (`tsc -p .`) — clean.
- `npx tsc -p tsconfig.tests.json --noEmit` — 0 errors.
- `bunx vitest run tests/tag-hygiene/repo-identity-backfill.test.ts` —
  **35/35 passed** (was 21/21; 14 new: 2 AC-6 core, 3 AC-8 core/dashboard, 9
  CLI-layer).
- `env -u ASTRA_SKIP_CONSOLIDATE bunx vitest run tests/tag-hygiene
  tests/cli` — **315/315 passed** (33 files — broader regression check
  than the sibling-module-only check above, covering every tag-hygiene and
  CLI test in the repo).
- `node contracts/validate.mjs` — 58/58.
- `git status --porcelain` — exactly
  `tests/tag-hygiene/repo-identity-backfill.test.ts` plus this handoff /
  the review / validation artifacts / the slice file (in-scope text
  correction) — no other file touched; no stray side-effect files from any
  test run.

## AC checklist (ACs scoped to this slice per the slice file: AC-4, AC-6, AC-8, AC-9)

- **AC-4** (no-session / no-cwd / unresolved never-guess guard preserved):
  PASS — three dedicated tests, one per reason; the genuinely-untrusted-
  shape case proves the DEC-017 trust boundary is enforced structurally,
  not by incidental string equality. Evidence: the "AC-4" describe block,
  3/3 passing.
- **AC-6** (preview is default, `--yes` required to mutate, preview
  reports scanned/would-re-stamp/unresolved + `joiningExistingCount`, two
  dry runs are byte-identical): **PASS, with a real test for the named
  property** (fix-pass, 2026-11-05) — two new core-level tests call
  `runRepoIdentityBackfill` with `dryRun: true` TWICE in a row against the
  same unmodified DB and assert `toEqual` on the full result (repo-default
  and project+`--sessions`); a new CLI-level test does the same through
  `repoIdentityBackfillCommand` with no `--yes`, asserting the printed
  preview text is byte-identical across both calls. `--yes`-gating is now
  exercised by an automated CLI-level test too (see "AC checklist" below,
  Known gap section updated).
- **AC-8** (post-apply counts match reported `unresolved` on BOTH
  `memories` and `sessions`; dashboard dropdown lists only resolvable names
  plus the explicitly-unresolved remainder): **PASS, now with direct tests
  for the full AC text** (fix-pass, 2026-11-05) — two new core-level tests
  assert the literal GLOB-count equality AC-8 names (`SELECT COUNT(*) ...
  WHERE <column> GLOB 'agent-*'` on both `memories` and `sessions`, both
  equal to `result.unresolved`) for the repo and project columns; a third
  imports the real, unmodified `queryProjectOptions`
  (`src/server/queries/dashboard.ts` — still untouched, read-only import)
  and asserts its post-apply output against a seeded mix of
  resolvable/unresolvable/already-correct rows. The earlier "PASS by
  construction... dashboard-side half... out of this slice's scope"
  framing is superseded — the independent verifiers correctly read the
  slice's own frontmatter ("ACs scoped to this slice: AC-4, AC-6, AC-8,
  AC-9", no partial qualifier) as not actually carving out the
  dashboard-dropdown half, and that half is now covered without any change
  to `dashboard.ts`.
- **AC-9** (preview output / override log never shows an absolute path,
  only a repo-root basename): PASS — the CLI's human-readable output path
  was audited line-by-line; the only values printed are
  `currentValue`/`resolvedValue` (basenames by construction of the
  resolver) and ids; `candidate.cwd` (the one full-path field in the data
  shape) is never written to console output. Documented explicitly in the
  CLI file's header comment. The AC-7 override-log-event half belongs to
  sibling SLICE-444.

## Known gap — CLOSED by fix pass (2026-11-05)

- ~~There is no CLI-level test file for this command...~~ Closed without a
  new file: `tests/tag-hygiene/repo-identity-backfill.test.ts` (already in
  this slice's `touches_files` allowlist) gained a
  `repoIdentityBackfillCommand` CLI-layer `describe` block (9 cases) that
  calls the command directly against a file-backed temp datadir via
  `ASTRA_MEMORY_DATADIR` — the same safe-isolation pattern
  `tests/cli/queue-purge.test.ts` already uses for a sibling
  `openRuntimeDb()`-based command, never the production datadir. Covered:
  `--column` validation (invalid value → exit 1, no db opened), default
  dry-run (zero mutations, preview text), a second identical dry-run
  (byte-identical preview), `--yes` apply, `--column project`, `--column
  all` (via `--json`, both columns reported independently), `--sessions`
  wired through (and NOT wired through when omitted — the FEAT-484
  byte-identical default), and AC-9's no-absolute-path claim asserted
  against real captured console output rather than a static read-through.
  The remaining non-blocking note from the original gap — hoisting a
  DB-injectable seam into `openRuntimeDb`/`repoIdentityBackfillCommand` for
  every `src/cli/*.ts` command in this shape — still stands as a future-
  slice follow-up; it was not needed to close THIS gap because seeding the
  file-backed datadir directly (open, migrate, insert, close — before the
  command opens its own connection to the same file) was sufficient.

## Confidence level

High. The core logic change is small and well-isolated (one resolver
function, one new local trust-shape check, straightforward column/session
generalisation of an existing, already-reviewed loop); every behavioural
claim above is backed by a passing test in the same commit; the full
suite is at documented baseline health.

## Risks / open questions

- ~~The `--column all` CLI composition and `--sessions`/`--yes` CLI-layer
  argument handling are verified by code review... not by an automated CLI
  test~~ — **closed by the fix pass**: now covered by automated tests (see
  "Known gap", now marked CLOSED).
- `isTrustedWorktreeCwdShape()` duplicates ~15 lines of structural logic
  that conceptually belongs in `cwd-basename.ts` (out of scope here) — a
  future slice could hoist a shared, exported predicate there instead.
- **Still open, outside a fix-agent's scope**: the slice-close ceremony
  (`/devcrew:slice complete`) has not run — the slice file is still
  `pending/` with `status: pending`, `FEAT-553.md`'s `slices_complete`
  still omits SLICE-445, and no `final-synthesis` artifact exists for this
  slice. Review and validation remain builder/fix-pass self-performed, not
  independently dispatched. Both are lead/orchestrator concerns to pick up
  next, not code-correctness gaps this pass could close.

## Suggested next handoff

- SLICE-447 (operator-gated prod apply): can proceed once this slice's
  review/validation land — it should call `runRepoIdentityBackfill` with
  `column: 'all'`-equivalent (two calls) and `includeSessions: true`
  against a real (backed-up) datadir, using the preview output's
  `sessionsRestamped` + `joiningExistingCount` figures as its own
  pre-apply sign-off evidence.
