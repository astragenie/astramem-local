/**
 * deriveWorktreeSafeBasename — shared cwd-basename heuristic (FEAT-425,
 * extended FEAT-553).
 *
 * Both deriveProject (this dir) and deriveRepoFromCwd
 * (src/tag-hygiene/derive-repo.ts) fall back to the last path segment of a
 * session's cwd when no explicit repo/project signal is available. A plain
 * basename is worktree-unsafe in TWO recognised shapes:
 *
 * 1. Sibling convention (FEAT-425): `.../astramemory-local-worktrees/wt-423b`
 *    yields `wt-423b`, not `astramemory-local`.
 * 2. Nested convention (FEAT-553): Claude Code's own agent-worktree layout,
 *    `<repo>/.claude/worktrees/agent-<hash>`, yields `agent-<hash>`, not
 *    `<repo>` — this is the shape every astramem-plugin capture hook
 *    actually runs under (`basename "$CWD"` inside an agent worktree), and
 *    it's what leaked ~15% of memories' `project`/`repo` columns as
 *    `agent-<hash>` before this fix (see docs/memory.md FEAT-553).
 *
 * Either case fragments recall — the same logical project gets a different
 * `project`/`repo` value per worktree, and recall's filter is exact-match
 * (src/search/search.ts).
 *
 * Heuristic is STRING-ONLY by design (FEAT-425 AC-3, reaffirmed FEAT-553
 * AC-2): the daemon may run on a different machine/time than the client's
 * actual working tree (or the worktree may already be deleted by ingest
 * time), so no `git`/`fs.stat` calls are added here — git-aware resolution
 * lives separately in src/tag-hygiene/repo-identity.ts for callers that can
 * afford it. Both rules key off *fixed structural segments* of the path
 * (parent segment name, or the literal `.claude/worktrees` pair), never off
 * the worktree's own subdirectory naming (`wt-*`, `agent-<hash>`, a
 * branch-derived name, etc.), since that varies freely.
 *
 * Evaluation order: nested rule (2) first, then sibling rule (1), then
 * plain basename passthrough. Any cwd that doesn't match either convention
 * is returned unchanged (conservative — AC-2/AC-3: non-worktree paths
 * unaffected, and every pre-existing FEAT-425 case is unmodified).
 *
 * Handles both POSIX and Windows separators (the daemon runs cross-platform)
 * and trailing slashes. Returns null for empty/root-only paths.
 */
const WORKTREES_PARENT = /^(.+)-worktrees$/i;
const CLAUDE_SEGMENT = '.claude';
const WORKTREES_SEGMENT = 'worktrees';

export function deriveWorktreeSafeBasename(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (!trimmed) return null;
  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return null;

  // Nested shape (FEAT-553): <repo>/.claude/worktrees/<x> — Claude Code's
  // agent-worktree layout. Requires the repo segment ahead of ".claude" to
  // exist (length >= 4); a bare ".claude/worktrees/<x>" with nothing before
  // it has no repo name to recover and falls through below. ".claude" and
  // "worktrees" must be exactly the third- and second-from-last segments
  // (depth 3 / depth 2 from the end) — anything else (e.g. an extra nested
  // segment pushing ".claude" to depth 4) is a passthrough, not a match.
  if (segments.length >= 4) {
    const maybeClaude = segments[segments.length - 3];
    const maybeWorktrees = segments[segments.length - 2];
    if (maybeClaude === CLAUDE_SEGMENT && maybeWorktrees === WORKTREES_SEGMENT) {
      const repo = segments[segments.length - 4];
      if (repo) return repo;
    }
  }

  // Sibling shape (FEAT-425): <repo>-worktrees/<x>.
  if (segments.length >= 2) {
    const parent = segments[segments.length - 2];
    const match = parent ? WORKTREES_PARENT.exec(parent) : null;
    if (match?.[1]) return match[1];
  }

  const last = segments[segments.length - 1];
  return last && last.length > 0 ? last : null;
}
