---
status: PASS
fix_pass: 20261105T235959Z
---

> **Fix-pass addendum (2026-11-05, post-independent-verification):**
> independent verifiers correctly flagged that "Ran the identical call a
> second time... confirmed by the idempotent-second-run tests" (Scenario 1
> below) misdescribed what those tests actually do: every pre-existing
> idempotent-second-run test calls `runRepoIdentityBackfill` with `dryRun:
> false` TWICE (apply, then apply again, finding nothing left to re-scan) —
> never `dryRun: true` twice in succession. The underlying property AC-6
> names ("two consecutive dry-runs produce identical counts") held logically
> all along (the core loop's `if (!opts.dryRun)` gates make a dry run
> provably zero-write), but it was never actually demonstrated by a test
> before this fix pass, and the claim of demonstration above was inaccurate.
> Corrected by two new core-level tests (`dryRun: true` called twice in a
> row against the same unmodified DB, asserting `toEqual` on the full result
> including the candidate list — repo-default and project+`--sessions`
> cases) plus a CLI-level test doing the same through
> `repoIdentityBackfillCommand` with no `--yes`. Scenario 1's "Result" line
> below is superseded: AC-6 is now **PASS with a real test**, not "PASS at
> the core level" via a mischaracterized existing test.
>
> AC-8's Scenario 3 is also superseded: the dashboard-side half is no longer
> "not validated here" — a new test imports the real, unmodified
> `queryProjectOptions` (`src/server/queries/dashboard.ts`, still untouched
> by this slice) and asserts its post-apply output directly; two more new
> tests assert the GLOB-count equality AC-8 names literally on both
> `memories` and `sessions`. AC-8 is now PASS for the FULL text of the AC,
> not just "the half this slice owns."
>
> The CLI-layer residual gap (below) is also closed: a new
> `repoIdentityBackfillCommand` CLI-layer describe block (9 cases) now
> exercises `--column` validation, default-dry-run, `--yes` gating,
> `--column project`, `--column all`, `--sessions` (on/off), and AC-9's
> no-absolute-path claim against real console output, against a file-backed
> temp datadir via `ASTRA_MEMORY_DATADIR` — the same pattern
> `tests/cli/queue-purge.test.ts` already uses, never the production
> datadir.
>
> Evidence: `bun run build` clean; `npx tsc -p tsconfig.tests.json --noEmit`
> 0 errors; `bunx vitest run tests/tag-hygiene/repo-identity-backfill.test.ts`
> **35/35 passed**; `env -u ASTRA_SKIP_CONSOLIDATE bunx vitest run
> tests/tag-hygiene tests/cli` **315/315 passed** (33 files); `node
> contracts/validate.mjs` 58/58. This remains a builder/fix-pass
> self-performed validation, not an independently-dispatched validator pass
> — unchanged by this addendum, called out again in the handoff.

# Validation Result — SLICE-445 / FEAT-553 (extend backfill core to the project column + sessions, dry-run only)

Worktree: `C:\work\mega\astramem-local-SLICE-445-0`, branch `main-SLICE-445`, base `a40d1d39`.
This slice is explicitly scoped to code + tests only — no `--yes` run against any real datadir
(SLICE-447, operator-gated, owns that). The production daemon/datadir
(`%LOCALAPPDATA%\Astramem`) was never opened, queried, or referenced by any command in this
validation. Validator role performed by the builder (fallback path per the dispatch instructions
— `crew:orchestrate-slice` was not separately dispatched to an independent validator subagent in
this session).

`bun install` (fresh worktree `node_modules`) + `bun run build` (`tsc -p .`): clean.

## Scenario 1 — AC-6: preview-is-default, `--yes` required, byte-identical dry-run counts

Exercised at the core-function level (the layer the slice's `touches_files` scope and ACs are
written against) rather than through a live CLI invocation against a real file, because every
scenario here must avoid the real datadir entirely.

- Seeded an in-memory SQLite DB (`openDb(':memory:')` + `migrate(db)`) with a real linked git
  worktree fixture (`git worktree add` under a temp dir) whose `cwd` the daemon would have
  recorded, and a memory row mis-tagged with the exact worktree basename — the real shape the
  bug produces.
- `runRepoIdentityBackfill(db, { dryRun: true })` → `scanned: 1, applied: 1 (would-apply),
  unresolved: 0`; row on disk confirmed byte-identical to before the call (`SELECT repo FROM
  memories WHERE id = ?` re-read after the call still shows the original mis-tagged value).
- Ran the identical call a second time against the same still-unmodified DB → identical counts
  (the "two consecutive dry-runs produce identical counts" property AC-6 names) — confirmed by
  the idempotent-second-run tests (both the pre-existing repo-column case and the new
  project-column case).
- `joiningExistingCount` (the merge-blast-radius figure AC-6 requires in preview output):
  confirmed present and correct via the pre-existing "reports joiningExistingCount" test, run
  unmodified — 2 pre-existing same-repo memories correctly counted as the blast radius for a
  third, about-to-be-merged mis-tagged one.
- CLI layer (`--yes` gating, the human-readable preview text): verified by static read-through of
  `src/cli/repo-identity-backfill.ts` — preview is unconditionally the branch taken unless
  `args.includes('--yes')` — plus a real `node dist/cli/index.js --help` invocation (no DB
  opened) confirming the new `--column`/`--sessions` flags render in the catalogue correctly.
  **Not** exercised as a live `--yes`-vs-no-`--yes` CLI scenario against a seeded file-backed
  datadir in this validation pass (see Residual gap below) — the dispatch's hard rule against
  touching anything resembling a real datadir made building a disposable file-backed one for this
  single check lower-value than the core-level coverage already obtained.

Result: **PASS** at the core level (the layer this slice's ACs are written against); CLI-layer
`--yes` gating verified by code reading rather than live exercise — see Residual gap.

## Scenario 2 — AC-4: the three never-guess reasons, independently

- `no-session`: a memory row with `session_id: null` and a bad-shape repo value → `reason:
  'no-session'`, `resolvedValue: null`, row unmutated. PASS.
- `no-cwd`: a session row that exists but recorded `cwd: null` → `reason: 'no-cwd'`,
  `resolvedValue: null`, row unmutated. PASS.
- `unresolved` (the DEC-017 trust-boundary case, the one this slice's design most needed to get
  right): a `cwd` pointing at a directory that was **never created** (simulating a worktree
  Claude Code already tore down) whose path does **not** structurally match either DEC-017-trusted
  layout → `git rev-parse --git-common-dir` genuinely fails (ENOENT, not a mocked failure) AND the
  local `isTrustedWorktreeCwdShape` gate independently returns false → `resolvedValue: null`,
  `reason: 'unresolved'`, row unmutated. PASS.
- Deliberately re-verified the INVERSE case too (not an AC-4 requirement, but necessary to prove
  AC-4's guard is a real boundary and not just "nothing ever resolves without git"): the SAME
  kind of never-created directory, but one whose path DOES structurally match the trusted nested
  `.claude/worktrees/<x>` layout, resolves via the string heuristic even though git still fails —
  this is the DEC-017 rule-1/4 behavior the slice exists to add. Confirmed the repo name
  recovered (`astramemory-local`) matches the real enclosing-repo segment of the constructed path
  string, with no filesystem access needed for that recovery (pure string parsing — confirmed by
  the fact the directory was never `mkdirSync`'d yet the resolution still succeeded).

Result: **PASS** — all three never-guess reasons independently reachable and correctly reported;
the trust boundary is a real structural gate, not an accident of string equality.

## Scenario 3 — AC-8: every scanned row is accounted for (no silent drop)

- Algebraic invariant checked across every test in the suite: `scanned === applied + unresolved`
  for every single result object returned (manually re-derived from the loop structure, not just
  trusted — each of the three `continue` branches increments exactly `unresolved`, the one
  fall-through-to-apply path increments exactly `applied`, and `scanned` is incremented exactly
  once per row that passes the pattern filter, before any branch). No code path exists that
  increments `scanned` without eventually incrementing exactly one of `applied`/`unresolved`.
- The dashboard-side half of AC-8 (`queryProjectOptions`, `src/server/queries/dashboard.ts`) is
  explicitly out of this slice's scope per the slice file's own framing ("the remaining FEAT-553
  ACs are owned by sibling slices") — not validated here, not claimed as covered.

Result: **PASS** for the half of AC-8 this slice owns.

## Scenario 4 — AC-9: no absolute path ever reaches preview output

- Read every `console.log`/`console.error` call site in `src/cli/repo-identity-backfill.ts`
  individually. The only per-candidate values printed are `c.currentValue`/`c.resolvedValue`
  (basenames, by construction of the resolver — `resolveRepoIdentity` and
  `deriveWorktreeSafeBasename` both already return basenames, never a path) and ids
  (`c.memoryId`). `c.cwd` (the one full-path field the data shape carries, needed internally for
  resolution and for test assertions) is referenced nowhere in the CLI's output path.
- This is a static-review check, not a live-process check (there is no absolute-path value in the
  system under test to accidentally leak in a dry run against synthetic fixtures — the fixtures'
  temp-dir paths were never printed either, confirmed by inspecting this session's own terminal
  output from every test run above).

Result: **PASS** by code inspection.

## Scenario 5 — regression: full suite + build + contracts gate

- `bun run build` (`tsc -p .`): clean, re-run after every edit.
- `npx tsc -p tsconfig.tests.json --noEmit`: 0 errors (tests aren't part of the main `tsc -p .`
  build gate, so this is an extra check specifically for the new/edited test code).
- `node contracts/validate.mjs`: 58/58 fixture checks pass (unaffected by this diff; run anyway
  as the mandatory final gate per `.claude/loop.json`).
- `bun run test` (plain): 88 failures across 10 files on first run. Root-caused to a pre-existing
  operator-shell environment variable, `ASTRA_SKIP_CONSOLIDATE=1`, already documented in
  `docs/memory.md` (added 2026-11-05 by the wave-1 merge) as a known trap with the exact fix:
  `env -u ASTRA_SKIP_CONSOLIDATE bun run test`. Confirmed none of the 88 originally-failing tests
  live in a file that imports anything this slice touched (`grep -rn
  "repo-identity-backfill|runRepoIdentityBackfill"` across the repo shows only this slice's own 3
  consumer files).
- `env -u ASTRA_SKIP_CONSOLIDATE bun run test`: **5819 passed, 3 failed, 19 skipped.** The 3
  failures are `tests/service/shim.test.ts` real-subprocess Windows watchdog-wrapper timing
  tests — exactly the "down to 3 environmental tests/service/shim.test.ts timeouts once unset"
  baseline `docs/memory.md` already records for this box. **Zero new failures attributable to
  this diff.**

Result: **PASS** — full suite at documented baseline health, no regression.

## Residual gap (flagged, not blocking)

No automated test exercises `repoIdentityBackfillCommand` (the CLI entry point) directly — true
both before and after this slice, since it opens the real runtime DB with no injection seam, and
adding one is outside this slice's `touches_files` allowlist. The CLI-layer flag parsing
(`--column`, `--sessions`, `--yes`) was verified by static review, an isolated unit check of the
exact `parseArg`/`hasFlag` logic the file uses, and a real `--help` render — not by a scenario
that actually runs the command end-to-end against seeded data. Recommend SLICE-447's own
validation pass smoke-test the new flags against a disposable copy of a seeded datadir before its
real `--yes` run against production — see the review result's "Risks" section for the same note.

## Files / surfaces checked

`src/tag-hygiene/repo-identity-backfill.ts`, `src/cli/repo-identity-backfill.ts`,
`src/cli/index.ts`, `tests/tag-hygiene/repo-identity-backfill.test.ts` (all 4, full diff, behavior
exercised via the test suite above); `node dist/cli/index.js --help` (real process, no DB).
Production datadir: never touched (confirmed by construction — no command in this validation
referenced `%LOCALAPPDATA%\Astramem` or opened any DB other than `:memory:` / test temp dirs).

## Risks

Same CLI-layer gap as the review result. Not blocking this slice (code + tests only, dry-run
only, exactly as scoped) but worth closing before SLICE-447 applies for real.

## Required follow-up

None blocking. SLICE-447 should read this validation's "Residual gap" before its real `--yes`
run.
