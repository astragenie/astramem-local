---
kind: handoff
objective: Wire git post-merge hook activation into init/reinstall (FEAT-439 residual)
owner: builder
worktree: C:\work\mega\astramemory-local-worktrees\w439r
branch: chore/w439r-hook-onboarding
created_at: 2026-07-12
confidence: high
next_handoff: reviewer
---
# Handoff — FEAT-439 residual: hook activation build complete

**Task:** the repo's git post-merge hook
(`scripts/git-hooks/post-merge` → `post-merge-rebuild.mjs`, FEAT-439) was
opt-in-by-comment-only — nothing wired `git config core.hooksPath
scripts/git-hooks` for a fresh checkout, even though the hook is now proven
live (fired on 2026-07-12's merges). Wire the activation into onboarding so
a dev checkout activates it automatically.

## What changed

- **New `src/service/git-hooks-activate.ts`** — `activateGitHooks(repoRoot?)`:
  - Skips silently (`{ status: 'not-a-git-checkout' }`) when `repoRoot` has
    no `.git` or no `scripts/git-hooks` directory — this is what makes it
    safe to call unconditionally for npm-installed users, who have neither.
  - Otherwise idempotently runs `git config core.hooksPath scripts/git-hooks`
    — checks the current value first (`git config --get`) and reports
    `already-set` without re-writing if it already matches, `set` if it
    wrote a new/different value, `error` (with message) if the `git`
    invocation itself failed (missing binary, non-zero exit) — never throws.
  - `repoRoot` defaults to a value derived from this module's own file
    location (`dirname(fileURLToPath(import.meta.url))` + `join(..,'..','..')`),
    the exact convention `service/release.ts`'s `defaultCheckoutDir()` and
    `cli/index.ts`'s package.json lookup already use — so it resolves
    correctly whether running from `dist/service/` (compiled) or `src/service/`
    (vitest, no build step).
  - **Deliberately uses `spawnSync`, not `execSync`/`execFileSync`.**
    `tests/cli/init.test.ts` already fully mocks `node:child_process` down
    to only `{ execSync, execFileSync }` for the Ollama binary/pull checks,
    and asserts `execSyncMock`/`execFileSyncMock` were **not** called in
    several branches (azure-only provider scenarios etc.). Using either of
    those two functions here would have broken those existing assertions
    the moment `init()` called this unconditionally. `spawnSync` is a third,
    unmocked-by-that-factory function — under that test file's mock it comes
    back `undefined`, so a call throws, which this module's internal
    try/catch already treats as a soft `error` result. No existing
    assertion touches this path, and the module has its own dedicated,
    unmocked test coverage (see below) against a real `git` binary.
- **`src/cli/init.ts`** — new step 0 (before "1. Gather answers", so it runs
  regardless of any wizard answer or early-return path): calls
  `activateGitHooks()`, logs `✓ git post-merge hook activated
  (core.hooksPath=scripts/git-hooks)` on `set`, a `⚠` line on `error`,
  nothing on `already-set`/`not-a-git-checkout`. Wrapped in try/catch — can
  never fail `init`.
- **`src/cli/reinstall.ts`** — same call added as a new soft step (6.6,
  between the retention step and the sanity-warnings section) — logged the
  same way, never added to the `steps` array that determines exit code, so
  it can never flip `reinstall`'s exit status.
- **`scripts/git-hooks/post-merge`** — one comment block added noting
  `init`/`reinstall` now auto-activate the hook; the manual `git config`
  one-liner is left in place for anyone on a non-npm/manual path. No
  logic touched (still just imports and calls `main()` from
  `post-merge-rebuild.mjs`, per the "don't touch scripts/git-hooks logic
  itself" constraint).
- **`CLAUDE.md`** — one paragraph added under "Service / upgrade" stating
  both commands now wire the hook, pointing at the new module, and noting
  the npm-install no-op case.
- **New `tests/service/git-hooks-activate.test.ts`** — real fixture git
  repos via `spawnSync('git', ...)` directly (same style as
  `tests/scripts/post-merge-rebuild.test.ts`), no mocking:
  - sets `core.hooksPath` on a fresh checkout that never configured it
  - idempotent: a second call reports `already-set`, doesn't re-write
  - overwrites a stale/different `core.hooksPath` value rather than
    leaving it alone (still converges on the right value)
  - plain non-git directory → silent no-op, no throw
  - a real git repo that just isn't this project (no `scripts/git-hooks`)
    → also a no-op, confirms it never touches an unrelated repo's config
  - a nonexistent directory → no-op, not a throw

## Test evidence

- `bun run build` (`tsc -p .`) — clean, no errors.
- `npx vitest run tests/service/git-hooks-activate.test.ts tests/cli/init.test.ts
  tests/scripts/post-merge-rebuild.test.ts` — **34/34 passed** (confirms the
  new module's own coverage AND that `init.test.ts`'s existing
  `execSyncMock`/`execFileSyncMock` "not called" assertions still hold with
  the new unconditional step 0 in place).
- Full suite: `npx vitest run` — **214 files, 2569 passed, 6 skipped**
  (pre-existing, unrelated), 0 failed.

## Confidence

High. Small, additive, two integration points, both wrapped so a failure to
activate the hook can never fail `init` or `reinstall`. The one design
decision worth a reviewer's eyes is the `spawnSync`-vs-mocked-functions
choice above — flagging it explicitly rather than letting it look like an
arbitrary pick.

## Scope discipline

Touched only `src/service/git-hooks-activate.ts` (new), the two call sites
(`init.ts`, `reinstall.ts`), one comment block in
`scripts/git-hooks/post-merge` (not the `.mjs` logic), `CLAUDE.md`, and the
new test file — did not touch `post-merge-rebuild.mjs`, migrations, redact,
or distill, per the assignment's constraints. Did not touch task #18's
sibling concern (task #18 itself, no other in-flight task) or anything
under `builder-443`'s active file set.

## Suggested next handoff

Reviewer — independent review of `src/service/git-hooks-activate.ts` and
the two call sites, with particular attention to the `spawnSync` choice
above and whether logging placement (step 0 in `init`, step 6.6 in
`reinstall`) is sensible.
