/**
 * deriveRepoFromCwd — tier-1 heuristic (FEAT-403 AC-1).
 *
 * Given a session's working directory, derive a repo name as the last path
 * segment. Handles both POSIX and Windows separators (the daemon runs
 * cross-platform — see CLAUDE.md) and trailing slashes. Returns null for
 * empty/root-only paths rather than guessing.
 */
export function deriveRepoFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : null;
}
