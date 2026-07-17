import { deriveWorktreeSafeBasename } from '../pipeline/cwd-basename.js';
import { resolveRepoIdentity } from './repo-identity.js';

/**
 * deriveRepoFromCwd — tier-1 heuristic (FEAT-403 AC-1).
 *
 * Given a session's working directory, derive a repo name.
 *
 * FEAT-484 (issue #177): tries git identity resolution FIRST
 * (resolveRepoIdentity — `git rev-parse --git-common-dir`, which maps a
 * worktree back to its main checkout regardless of naming convention).
 * That closes the gap the FEAT-425 string heuristic left open — a worktree
 * nested at `<repo>/.claude/worktrees/<name>` (parent segment `worktrees`,
 * not `<repo>-worktrees`) fell through the old regex to the raw basename
 * (`agent-<hash>`).
 *
 * Falls back to the pre-existing string-only heuristic
 * (deriveWorktreeSafeBasename, src/pipeline/cwd-basename.ts) whenever git
 * can't answer — non-git directory, git unavailable, path no longer exists,
 * or timeout — preserving prior behavior for anything git can't resolve.
 * Handles both POSIX and Windows separators (the daemon runs cross-platform
 * — see CLAUDE.md) and trailing slashes. Returns null for empty/root-only
 * paths rather than guessing.
 */
export function deriveRepoFromCwd(cwd: string | null | undefined): string | null {
  return resolveRepoIdentity(cwd) ?? deriveWorktreeSafeBasename(cwd);
}
