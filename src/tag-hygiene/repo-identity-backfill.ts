/**
 * runRepoIdentityBackfill — FEAT-484 one-shot re-stamp of memories mis-tagged
 * `repo='agent-<hash>'` (or another worktree-basename shape) by the bug
 * fixed in derive-repo.ts.
 *
 * Distinct from the FEAT-403 tag-hygiene backfill (src/tag-hygiene/
 * backfill.ts): that one only targets BLANK repo/project (`WHERE repo IS
 * NULL OR TRIM(repo) = ''`), so it never touches these rows — they already
 * carry a (wrong, non-blank) value. This backfill targets rows whose repo
 * matches the known-bad SHAPE and re-derives from the session's still-stored
 * `cwd` via the same git-aware resolver used at ingest time
 * (resolveRepoIdentity).
 *
 * Idempotent by construction (AC): the WHERE/pattern guard means a row
 * already correctly stamped (repo doesn't match the bad-shape pattern) is
 * never selected, so a re-run over an already-fixed corpus is a pure no-op
 * scan. A row is only ever mutated once it stops matching the pattern.
 *
 * MIGRATION HAZARD (heed "verify, don't migrate" / re-stamping changes
 * consolidation grouping keys): this NEVER guesses. If the session's cwd no
 * longer resolves (worktree already deleted, git unavailable, no session /
 * no cwd on record) the row is left untouched and reported `unresolved` —
 * there is no "assume it's the one repo this daemon usually serves"
 * fallback, because that would risk merging an unrelated memory into the
 * wrong repo's consolidation group. Every APPLIED row's resolution came from
 * asking git about that row's own recorded working directory.
 *
 * `joiningExistingCount` in each candidate surfaces the merge blast radius
 * before you mutate anything (a dry-run reviewer can see how many
 * already-correctly-tagged memories will now group with the row about to be
 * re-stamped) — the guard the FEAT-484 dispatch explicitly asked for.
 */
import type { DB } from '../storage/db.js';
import { resolveRepoIdentity } from './repo-identity.js';

/**
 * Matches the known ephemeral worktree-basename shapes this daemon's
 * ecosystem actually produces under the NESTED `.claude/worktrees/<name>`
 * convention (parent segment `worktrees`, not `<repo>-worktrees` — the one
 * shape `deriveWorktreeSafeBasename`'s string heuristic can't recognize; see
 * derive-repo.ts). Observed on disk (2026-07-17):
 *   - `agent-ac72934b8fdc982ea` — runner-plugin agent worktrees (issue #177,
 *     the originally-reported shape): `agent-` + a hex id.
 *   - `wt-387fix`, `wt-484-recover`, `worktree-foo` — short "wt-"/"worktree-"
 *     prefixed ephemeral names some tooling nests directly under
 *     `.claude/worktrees/` instead of a sibling `<repo>-worktrees/` dir.
 *   - `memoized-jumping-elephant` — the memorable-random-name generator
 *     (adjective-adjective-noun, 3-4 lowercase words) some worktree tooling
 *     uses in place of a hash.
 * Deliberately still guarded: every branch requires a specific PREFIX or a
 * minimum 3-word random-name shape, so a legitimately-named repo (e.g.
 * `agent-tools`, `astramemory-local`, `runner-plugin` — 1-2 real words) is
 * never swept up by accident. Even if a false positive slips through the
 * scan filter, `runRepoIdentityBackfill` only ever mutates a row when git's
 * own resolution DISAGREES with the stored value (see the `resolved ===
 * row.repo` guard below) — a false-positive scan candidate that's actually
 * correct is reported `unresolved` and left untouched.
 */
export const DEFAULT_BAD_REPO_PATTERN =
  /^(?:agent-[0-9a-f]{6,}|wt-[a-z0-9][a-z0-9-]*|worktree-[a-z0-9][a-z0-9-]*|[a-z]+(?:-[a-z]+){2,3})$/i;

export interface RepoIdentityBackfillOptions {
  dryRun: boolean;
  limit?: number;
  /** Override the bad-repo-shape guard. Defaults to DEFAULT_BAD_REPO_PATTERN. */
  pattern?: RegExp;
}

export type RepoIdentityBackfillReason = 'no-session' | 'no-cwd' | 'unresolved';

export interface RepoIdentityBackfillCandidate {
  memoryId: string;
  sessionId: string | null;
  currentRepo: string;
  cwd: string | null;
  resolvedRepo: string | null;
  /** Count of OTHER memories already stamped with resolvedRepo — the
   *  consolidation-grouping blast radius of this re-stamp. 0 when
   *  resolvedRepo is null (nothing applied). */
  joiningExistingCount: number;
  applied: boolean;
  reason?: RepoIdentityBackfillReason;
}

export interface RepoIdentityBackfillResult {
  /** Rows whose current repo matched the bad-shape pattern. */
  scanned: number;
  applied: number;
  unresolved: number;
  dryRun: boolean;
  candidates: RepoIdentityBackfillCandidate[];
}

interface MemoryRow {
  id: string;
  repo: string;
  session_id: string | null;
}

export function runRepoIdentityBackfill(
  db: DB,
  opts: RepoIdentityBackfillOptions,
): RepoIdentityBackfillResult {
  const pattern = opts.pattern ?? DEFAULT_BAD_REPO_PATTERN;

  // Pull all non-blank-repo rows and filter by `pattern` in JS — SQLite has
  // no portable REGEXP without a loadable extension, and the candidate set
  // (agent-* mis-tags) is small relative to the full memories table.
  const rows = db.prepare(`
    SELECT id, repo, session_id FROM memories
    WHERE repo IS NOT NULL AND TRIM(repo) != ''
    ORDER BY created_at ASC
  `).all() as MemoryRow[];

  const sessionStmt = db.prepare('SELECT cwd FROM sessions WHERE id = ?');
  const countStmt = db.prepare('SELECT COUNT(*) as n FROM memories WHERE repo = ?');
  const updateStmt = db.prepare('UPDATE memories SET repo = ?, updated_at = ? WHERE id = ?');

  const candidates: RepoIdentityBackfillCandidate[] = [];
  let scanned = 0;
  let applied = 0;
  let unresolved = 0;

  for (const row of rows) {
    if (!pattern.test(row.repo)) continue;
    if (opts.limit !== undefined && scanned >= opts.limit) break;
    scanned++;

    if (!row.session_id) {
      candidates.push({
        memoryId: row.id, sessionId: null, currentRepo: row.repo, cwd: null,
        resolvedRepo: null, joiningExistingCount: 0, applied: false, reason: 'no-session',
      });
      unresolved++;
      continue;
    }

    const session = sessionStmt.get(row.session_id) as { cwd: string | null } | undefined;
    const cwd = session?.cwd ?? null;
    if (!cwd) {
      candidates.push({
        memoryId: row.id, sessionId: row.session_id, currentRepo: row.repo, cwd: null,
        resolvedRepo: null, joiningExistingCount: 0, applied: false, reason: 'no-cwd',
      });
      unresolved++;
      continue;
    }

    const resolved = resolveRepoIdentity(cwd);
    if (!resolved || resolved === row.repo) {
      candidates.push({
        memoryId: row.id, sessionId: row.session_id, currentRepo: row.repo, cwd,
        resolvedRepo: resolved, joiningExistingCount: 0, applied: false, reason: 'unresolved',
      });
      unresolved++;
      continue;
    }

    const joiningExistingCount = (countStmt.get(resolved) as { n: number }).n;

    if (!opts.dryRun) {
      updateStmt.run(resolved, Date.now(), row.id);
    }
    applied++;
    candidates.push({
      memoryId: row.id, sessionId: row.session_id, currentRepo: row.repo, cwd,
      resolvedRepo: resolved, joiningExistingCount, applied: !opts.dryRun,
    });
  }

  return { scanned, applied, unresolved, dryRun: opts.dryRun, candidates };
}
