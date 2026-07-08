import { deriveWorktreeSafeBasename } from './cwd-basename.js';

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
 * then a worktree-safe cwd basename as a fallback (FEAT-425 —
 * deriveWorktreeSafeBasename, shared with deriveRepoFromCwd in
 * src/tag-hygiene/derive-repo.ts), else null.
 */
export function deriveProject(
  cwd: string | null | undefined,
  repo: string | null | undefined,
): string | null {
  if (repo) return repo;
  return deriveWorktreeSafeBasename(cwd);
}
