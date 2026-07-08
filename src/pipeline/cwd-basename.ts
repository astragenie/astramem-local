/**
 * deriveWorktreeSafeBasename — shared cwd-basename heuristic (FEAT-425).
 *
 * Both deriveProject (this dir) and deriveRepoFromCwd
 * (src/tag-hygiene/derive-repo.ts) fall back to the last path segment of a
 * session's cwd when no explicit repo/project signal is available. A plain
 * basename is worktree-unsafe: a cwd like
 * `.../astramemory-local-worktrees/wt-423b` yields `wt-423b`, not
 * `astramemory-local`, which fragments recall — the same logical project
 * gets a different `project`/`repo` value per worktree, and recall's filter
 * is exact-match (src/search/search.ts).
 *
 * Heuristic is string-only by design (FEAT-425 AC-3): the daemon may run on
 * a different machine/time than the client's actual working tree, so no
 * `git`/`fs.stat` calls are added here. It keys off the *parent* segment of
 * the worktree directory matching the `<repo>-worktrees` convention (e.g.
 * `astramemory-local-worktrees`) established by this repo's own worktree
 * layout (see CLAUDE.md) — not off the child segment's naming (`wt-*`,
 * a branch-derived name, etc.), since that varies. When the convention
 * matches, resolves to the captured repo name instead of the worktree
 * subdirectory name. Any cwd that doesn't match the convention is returned
 * unchanged (conservative — AC-2: non-worktree paths unaffected).
 *
 * Handles both POSIX and Windows separators (the daemon runs cross-platform)
 * and trailing slashes. Returns null for empty/root-only paths.
 */
const WORKTREES_PARENT = /^(.+)-worktrees$/i;

export function deriveWorktreeSafeBasename(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return null;

  if (segments.length >= 2) {
    const parent = segments[segments.length - 2];
    const match = parent ? WORKTREES_PARENT.exec(parent) : null;
    if (match?.[1]) return match[1];
  }

  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : null;
}
