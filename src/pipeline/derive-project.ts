/**
 * deriveProject — FEAT-423 write-side derivation.
 *
 * Sessions don't always carry an explicit `project` (e.g. plugin clients
 * that only report cwd). Rather than write a null `provenance.project` and
 * rely entirely on the FEAT-403 retag backfill to fix it up later, derive a
 * best-effort project name at ingest time so it's correct from the start.
 *
 * Precedence: explicit `repo` first (FEAT-403 established that an explicit
 * repo column wins over cwd — recall's `project` filter is exact-match, so
 * an inverted precedence fragments recall across git worktrees, where
 * `basename(cwd)` yields the worktree dir name rather than the repo name),
 * then cwd basename as a fallback, else null. Mirrors deriveRepoFromCwd
 * (src/tag-hygiene/derive-repo.ts) for the cross-platform basename logic
 * (the daemon runs on both POSIX and Windows — see CLAUDE.md): split on
 * both `/` and `\`, strip trailing separators, ignore empty segments.
 */
export function deriveProject(
  cwd: string | null | undefined,
  repo: string | null | undefined,
): string | null {
  if (repo) return repo;
  if (cwd) {
    const trimmed = cwd.replace(/[\\/]+$/, '');
    if (trimmed) {
      const segments = trimmed.split(/[\\/]/).filter(Boolean);
      const last = segments[segments.length - 1];
      // Known limitation (follow-up FEAT-425): a worktree cwd such as
      // .../my-repo-worktrees/wt-foo yields "wt-foo", not "my-repo" —
      // worktree-safe project identity (stripping -worktrees/wt-* or
      // resolving to the canonical repo name) is out of scope here.
      if (last) return last;
    }
  }
  return null;
}
