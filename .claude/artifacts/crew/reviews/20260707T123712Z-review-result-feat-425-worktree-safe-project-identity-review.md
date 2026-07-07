---
findings: "🔴:0,🟡:1,❓:0"
status: completed
decision: approved_with_notes
---
# Review Result: FEAT-425 worktree-safe project identity review

- Created: 2026-07-07T12:41:40.276Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: FEAT-425 correctly makes the cwd-basename fallback worktree-safe via a new shared helper; repo-wins precedence preserved, build clean, 45 scoped tests pass (matches claim) plus full suite (147 files/1558 tests) green; one MEDIUM test-adequacy gap on the FEAT's own flagged coincidence-collision risk.
- Evidence Checked:
  - git diff main -- src/pipeline/derive-project.ts src/tag-hygiene/derive-repo.ts tests/pipeline/derive-project.test.ts shows deriveProject's 'if (repo) return repo;' line unchanged (repo-wins precedence intact
  - confirms FEAT-423 behavior untouched); new src/pipeline/cwd-basename.ts::deriveWorktreeSafeBasename keys off WORKTREES_PARENT=/^(.+)-worktrees$/i on the immediate parent segment only (verified via Read); bun run build -> tsc clean exit; bunx vitest run tests/pipeline/cwd-basename.test.ts tests/pipeline/derive-project.test.ts tests/tag-hygiene/derive-repo.test.ts tests/tag-hygiene/backfill.test.ts -> 4 files / 45 tests passed (matches agent's claim exactly); bunx vitest run tests/ -> 147 files / 1558 passed
  - 4 skipped
  - 0 failed.
- Files Reviewed:
  - src/pipeline/cwd-basename.ts (new)
  - src/pipeline/derive-project.ts
  - src/tag-hygiene/derive-repo.ts
  - tests/pipeline/cwd-basename.test.ts (new)
  - tests/pipeline/derive-project.test.ts
  - tests/tag-hygiene/derive-repo.test.ts (new)
- Test Adequacy: 12 new/changed unit tests directly exercise the helper: null/empty/root-only, non-worktree POSIX+Windows basename (regression), trailing-separator, worktree-shaped POSIX+Windows, subdir-naming-independence, and two boundary cases (-worktrees as last segment, non-adjacent -worktrees ancestor); AC-1/AC-2/AC-3 from FEAT-425 are each covered, but the FEAT's own pm_risks note asking for a literal regression test of a non-worktree dir that coincidentally sits under an X-worktrees-named parent is not present (see MEDIUM finding).
- Risks: MEDIUM: the parent-segment match (WORKTREES_PARENT regex) fires on ANY child segment name once the parent ends in '-worktrees', not just wt-*-style names — broader than the FEAT-425 body's literal '-worktrees/wt-*' example. This is an intentional, documented widening (child-segment names vary), but it also means a real non-worktree subdirectory living under a literally-named '<name>-worktrees' parent (e.g. a repo genuinely named 'foo-worktrees' with an unrelated 'config' or 'docs' child dir) would be silently mis-derived to 'foo', merging with a hypothetical unrelated 'foo' project. FEAT-425's own pm_risks explicitly flagged this coincidence scenario and asked for 'a literal regression test, not just a stated intent' — the shipped test suite's 'non-worktree unaffected' cases only cover paths with no '-worktrees' segment at all, so the specific coincidence case remains untested. Low real-world likelihood (repos named literally '*-worktrees' are rare) and only applies when no repo signal exists at all (fallback of a fallback), so not blocking.
- Required Follow-up: Optional low-cost follow-up: add one regression test asserting a non-worktree child under a literally-named '<x>-worktrees' parent still resolves per current (documented) behavior, or add an explicit code comment acknowledging the residual false-positive risk so a future reader doesn't need to re-derive it. Not required before merge.

