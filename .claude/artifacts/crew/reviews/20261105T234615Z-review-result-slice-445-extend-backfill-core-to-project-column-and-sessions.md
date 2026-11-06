---
decision: approved
not_checked: []
fix_pass: 20261105T235959Z
---

> **Fix-pass addendum (2026-11-05, post-independent-verification):** three
> claims below did not hold up and are corrected here rather than silently
> rewritten in place, so the original review text stays legible as what was
> actually said at the time:
>
> 1. **"all 6 original tests pass unmodified in behavior, renamed fields
>    only"** (Summary, below) is wrong on two counts: the base file
>    (`a40d1d39`) had **7** tests in that `describe` block, not 6, and one of
>    them — `MIGRATION HAZARD guard` — was **not** preserved unmodified; its
>    assertions were inverted (dry-run default-column resolution on a
>    deleted-but-trusted-shape worktree: was `applied:0/unresolved:1`, is now
>    `applied:1/unresolved:0`). This IS the correct, DEC-017 rule-(4)-
>    authorized behavior (`.claude/artifacts/loop/decisions/DEC-017.md`,
>    "repo gets parity with project") — the handoff's own "Design decision"
>    section already said this plainly ("intentionally changed, not just
>    renamed"); this review's Summary line should have matched that instead
>    of asserting unmodified-behavior equivalence. No code or test change
>    follows from this — it is a documentation-accuracy fix only.
> 2. **The "not_checked" CLI-argv-parsing gap is now closed.** A new
>    `describe('repoIdentityBackfillCommand — CLI layer ...')` block (9
>    cases) was added to `tests/tag-hygiene/repo-identity-backfill.test.ts`,
>    exercising `repoIdentityBackfillCommand` directly against a file-backed
>    temp datadir via `ASTRA_MEMORY_DATADIR` (the same safe-isolation pattern
>    `tests/cli/queue-purge.test.ts` already uses for a sibling
>    `openRuntimeDb()`-based command — never the production datadir):
>    `--column` validation, default-is-dry-run, `--yes` gating, `--column
>    project`, `--column all` (via `--json`), `--sessions` wiring (on and
>    off), and the AC-9 no-absolute-path assertion against actual
>    console.log output (not just a static read-through). `not_checked`
>    above is cleared accordingly.
> 3. **AC-6's named property — "two consecutive dry-runs produce identical
>    counts" — now has a real test**, not just dry-run-then-apply idempotency
>    (which is a different property). Two new core-level tests call
>    `runRepoIdentityBackfill` with `dryRun: true` **twice in a row** against
>    the same unmodified DB and assert `toEqual` on the full result
>    (including the candidate list), for both the `repo` default and the
>    `project` + `--sessions` combination; a CLI-level test does the same
>    through `repoIdentityBackfillCommand` twice with no `--yes`. The
>    Validation artifact's claim of having verified this via "the
>    idempotent-second-run tests" was inaccurate (those call `dryRun: false`
>    twice — apply, then apply again — not `dryRun: true` twice); corrected
>    there too.
> 4. **AC-8's dashboard-dropdown half is now covered**, without touching
>    `src/server/queries/dashboard.ts` (still out of this slice's
>    `touches_files` scope): a new test imports the real, unmodified
>    `queryProjectOptions` read-only and asserts its post-apply output
>    against a seeded mix of resolvable/unresolvable/already-correct rows.
>    Two more new tests assert the GLOB-count equality AC-8 names literally
>    (`SELECT COUNT(*) ... WHERE <column> GLOB 'agent-*'` on BOTH `memories`
>    and `sessions`, both equal to `result.unresolved`).
>
> Evidence for all of the above: `bun run build` clean; `npx tsc -p
> tsconfig.tests.json --noEmit` 0 errors; `bunx vitest run
> tests/tag-hygiene/repo-identity-backfill.test.ts` **35/35 passed** (was
> 21/21 before this fix pass — 14 new cases: 2 AC-6, 3 AC-8, 9 CLI-layer);
> `env -u ASTRA_SKIP_CONSOLIDATE bunx vitest run tests/tag-hygiene tests/cli`
> **315/315 passed** (33 files, no regression); `node contracts/validate.mjs`
> 58/58. This review is still a builder/fix-pass self-review, not an
> independently-dispatched reviewer pass — that governance gap is unchanged
> by this addendum and is called out again in the handoff.
# Review Result: SLICE-445: Extend backfill core to the project column and the sessions table — review

- Created: 2026-11-05T23:46:15.000Z
- Reviewer: builder self-review (fallback path — `crew:orchestrate-slice` was
  not separately dispatched to an independent reviewer subagent in this
  session; the dispatch instructions' explicit fallback is "perform the
  equivalent yourself", which includes writing this artifact). Treated with
  the same rigor as an independent pass: re-read the full diff line by line
  after the implementing session, specifically hunting for the failure
  modes DEC-017 and AC-4 call out (silent guessing, column cross-talk,
  session double-counting), not just re-confirming intent.
- Decision: approved
- Summary: Generalises `runRepoIdentityBackfill` (FEAT-484) from a
  repo-only, memories-only backfill to a `column: 'repo'|'project'` +
  `includeSessions` tool per the slice's in-scope bullets, using the
  DEC-017 resolver (git first, then a trust-gated string fallback). The one
  judgment call beyond a literal reading of the slice text — gating the
  string fallback behind an explicit `isTrustedWorktreeCwdShape()` check
  rather than relying on the pre-existing `resolved === row.value` equality
  guard to catch untrusted shapes — is correct and better matches AC-4's
  independent "no recoverable segment" condition; verified this doesn't
  regress any FEAT-484 case (all 6 original tests pass unmodified in
  behavior, renamed fields only).
- Evidence checked:
  - `git status --porcelain` → exactly
    `src/cli/index.ts`, `src/cli/repo-identity-backfill.ts`,
    `src/tag-hygiene/repo-identity-backfill.ts`,
    `tests/tag-hygiene/repo-identity-backfill.test.ts` modified; nothing
    else. Matches the dispatch's scope guard exactly.
  - `grep -rn "repo-identity-backfill\|runRepoIdentityBackfill"
    src/server src/pipeline` (outside the 4 scoped files) → no hit; this
    slice's sibling SLICE-444 (`src/server/routes/ingest.ts`,
    `src/pipeline/derive-project.ts`) was not touched.
  - Read `src/pipeline/cwd-basename.ts` and `src/tag-hygiene/
    repo-identity.ts` in full (both out-of-scope, read-only) to confirm
    the new `isTrustedWorktreeCwdShape()` helper's two branches exactly
    mirror `deriveWorktreeSafeBasename`'s own nested/sibling detection
    conditions (segment depth, `.claude`/`worktrees` literal match,
    `-worktrees$` suffix) — a mismatch here would silently widen or
    narrow the trust boundary without any test catching it structurally
    (only by coincidence). Confirmed byte-for-byte equivalent conditions.
  - Manually traced the "counts each session only ONCE" scenario by hand
    against the code (3 memories, 1 session, `sessionsToRestamp` is a
    `Map` keyed by session id so repeated `.set()` calls with the same key
    across the 3 loop iterations collapse to size 1) — matches the test's
    assertion and is NOT merely an artifact of the test happening to pass;
    the dedup is structural (a `Map`), not probabilistic.
  - Confirmed `countStmt`/`updateStmt`/`updateSessionStmt`/`sessionStmt`
    are all freshly `db.prepare()`d per call with `column` already
    validated against the literal union (defense in depth beyond the TS
    type) before any interpolation — no SQL-injection-shaped risk even
    though the only caller is this same process.
  - Confirmed the CLI's human-readable preview path (`printResult`) never
    references `candidate.cwd` (the AC-9 posture) — read every `console.log`
    call in `src/cli/repo-identity-backfill.ts` individually.
  - `node contracts/validate.mjs` → 58/58.
  - `bunx vitest run tests/tag-hygiene/repo-identity-backfill.test.ts` →
    21/21.
  - `bunx vitest run tests/tag-hygiene/repo-identity.test.ts
    tests/pipeline/cwd-basename.test.ts tests/tag-hygiene/derive-repo.test.ts`
    → 31/31 (confirms the out-of-scope modules this slice imports from are
    unaffected).
  - `npx tsc -p tsconfig.tests.json --noEmit` → 0 errors (tests are NOT
    included in the main `tsconfig.json`'s `tsc -p .` build gate, so this
    extra check was run specifically to type-check the new test code,
    since vitest's esbuild transform alone would not have caught a type
    error).
  - `env -u ASTRA_SKIP_CONSOLIDATE bun run test` → 5819 passed, 3 failed
    (pre-existing `tests/service/shim.test.ts` Windows subprocess-timing
    flakes, matching docs/memory.md's already-documented baseline), 19
    skipped. Confirmed the plain `bun run test` 88-failure signal is the
    separately-documented `ASTRA_SKIP_CONSOLIDATE=1` operator-shell env
    trap, not a regression from this diff — none of the 88 originally-
    failing tests live in a file that imports anything this slice edited.
- Files reviewed: `src/tag-hygiene/repo-identity-backfill.ts`,
  `src/cli/repo-identity-backfill.ts`, `src/cli/index.ts`,
  `tests/tag-hygiene/repo-identity-backfill.test.ts` (all 4, full diff);
  `src/pipeline/cwd-basename.ts`, `src/tag-hygiene/repo-identity.ts`,
  `src/pipeline/derive-project.ts`, `src/tag-hygiene/derive-repo.ts`
  (read-only, for resolver/trust-shape consistency).
- Test adequacy: strong for the core function (21 cases covering every
  branch: both columns, both reasons families, sessions on/off, dedup,
  no-spurious-write, column isolation, the deleted-worktree-but-trusted-
  shape case that changes behavior from FEAT-484, and the genuinely-
  untrusted-shape never-guess case). Weak for the CLI layer specifically
  (`--column`/`--sessions`/`--yes` argv handling, `--column all`'s report-
  twice behavior) — no automated test exists at that layer for this
  command (not even pre-existing for FEAT-484's `repo`-only CLI), because
  `repoIdentityBackfillCommand` opens the real runtime DB directly with no
  injection seam, and adding one + a new CLI test file is outside this
  slice's `touches_files` allowlist. Mitigated by static review + an
  isolated parsing-logic check + a real `--help` render (see handoff
  "Evidence" and "Known gap"), not by an automated regression test — flagged
  as `not_checked` above and in the handoff's "Risks" section rather than
  silently assumed covered.
- Non-code review: no — this is a full source + test review.
- Not checked:
  - CLI-level argv parsing (see "Test adequacy" above and the frontmatter
    `not_checked` field).
  - The dashboard-side half of AC-8 (`queryProjectOptions`,
    `src/server/queries/dashboard.ts`) — explicitly out of this slice's
    scope per the slice file's own AC framing.
  - AC-7's override-log-event (sibling SLICE-444's scope).
- Risks: the CLI-layer gap above should be closed (or explicitly accepted)
  before SLICE-447 (operator-gated prod apply) runs `--yes --column all
  --sessions` against the real datadir — that is the first time this
  exact flag combination executes against data that matters. Recommend
  SLICE-447's own validation step smoke-test the flag parsing against a
  throwaway copy of the datadir before the real `--yes` run, even without
  a permanent automated CLI test.
- Required follow-up: none blocking. Two non-blocking notes carried into
  the handoff: (1) hoist `isTrustedWorktreeCwdShape`'s structural check
  into `cwd-basename.ts` as a shared, exported predicate in a future
  slice, instead of the local duplicate kept here for scope reasons; (2)
  add a DB-injectable seam + test file for `repoIdentityBackfillCommand`
  (and ideally every `src/cli/*.ts` command in the same shape) in a future
  slice, not scoped to FEAT-553.
