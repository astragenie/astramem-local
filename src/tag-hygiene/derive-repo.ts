import { deriveWorktreeSafeBasename } from '../pipeline/cwd-basename.js';

/**
 * deriveRepoFromCwd — tier-1 heuristic (FEAT-403 AC-1).
 *
 * Given a session's working directory, derive a repo name as the last path
 * segment. Handles both POSIX and Windows separators (the daemon runs
 * cross-platform — see CLAUDE.md) and trailing slashes. Returns null for
 * empty/root-only paths rather than guessing.
 *
 * Worktree-safe (FEAT-425): a cwd shaped like
 * `.../my-repo-worktrees/wt-foo` resolves to `my-repo`, not `wt-foo` — see
 * deriveWorktreeSafeBasename (src/pipeline/cwd-basename.ts) for the shared
 * heuristic, also used by deriveProject's cwd fallback.
 */
export function deriveRepoFromCwd(cwd: string | null | undefined): string | null {
  return deriveWorktreeSafeBasename(cwd);
}
