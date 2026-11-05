/**
 * runRepoIdentityBackfill — FEAT-484 one-shot re-stamp of memories mis-tagged
 * `repo='agent-<hash>'` (or another worktree-basename shape) by the bug
 * fixed in derive-repo.ts. Extended by FEAT-553 (SLICE-445) to also cover
 * the `project` column and the `sessions` table (see below).
 *
 * Distinct from the FEAT-403 tag-hygiene backfill (src/tag-hygiene/
 * backfill.ts): that one only targets BLANK repo/project (`WHERE repo IS
 * NULL OR TRIM(repo) = ''`), so it never touches these rows — they already
 * carry a (wrong, non-blank) value. This backfill targets rows whose
 * repo/project matches the known-bad SHAPE and re-derives from the
 * session's still-stored `cwd` via the same git-aware resolver used at
 * ingest time (resolveRepoIdentity), with a DEC-017-gated string-heuristic
 * fallback for worktrees git can no longer see (deleted before backfill
 * ran).
 *
 * Idempotent by construction (AC): the WHERE/pattern guard means a row
 * already correctly stamped (column doesn't match the bad-shape pattern) is
 * never selected, so a re-run over an already-fixed corpus is a pure no-op
 * scan. A row is only ever mutated once it stops matching the pattern.
 *
 * MIGRATION HAZARD (heed "verify, don't migrate" / re-stamping changes
 * consolidation grouping keys): this NEVER guesses beyond the DEC-017 trust
 * boundary. If the session's cwd no longer resolves via git AND doesn't
 * structurally match one of the two tool-generated worktree layouts DEC-017
 * trusts, the row is left untouched and reported `unresolved` — there is no
 * "assume it's the one repo this daemon usually serves" fallback, because
 * that would risk merging an unrelated memory into the wrong repo's
 * consolidation group. Every APPLIED row's resolution came from either (a)
 * asking git about that row's own recorded working directory, or (b) a
 * string-derived name for one of the two specific layouts DEC-017 names,
 * never an arbitrary basename guess.
 *
 * `joiningExistingCount` in each candidate surfaces the merge blast radius
 * before you mutate anything (a dry-run reviewer can see how many
 * already-correctly-tagged memories will now group with the row about to be
 * re-stamped) — the guard the FEAT-484 dispatch explicitly asked for.
 *
 * FEAT-553 / DEC-017 extension (SLICE-445):
 *  - `column` selects which of `repo` | `project` is scanned + re-stamped.
 *    Defaults to `'repo'` — calling this with no `column` option reproduces
 *    FEAT-484's exact default behaviour (same column, same candidate shape)
 *    for every row git can resolve; the only behavioural change under the
 *    default is that a row git CANNOT resolve (worktree already deleted) no
 *    longer automatically falls to `unresolved` — it is re-checked against
 *    the DEC-017 trust boundary below first.
 *  - `includeSessions` additionally re-stamps `sessions.<column>` to the
 *    same resolved value for every session touched by an applied (or, in a
 *    dry run, would-apply) candidate — closing the gap where FEAT-484 only
 *    ever touched `memories`, never the `sessions` row that seeded the
 *    mis-tag in the first place.
 *  - The resolver is `resolveRepoIdentity(cwd) ?? (trusted shape ?
 *    deriveWorktreeSafeBasename(cwd) : null)` per DEC-017 rules (1) and (4):
 *    git wins when it can answer; otherwise a string-derived name is
 *    trusted ONLY for the two tool-generated layouts
 *    `<repo>/.claude/worktrees/<x>` and `<repo>-worktrees/<x>` (mirrored
 *    locally as `isTrustedWorktreeCwdShape` below — `cwd-basename.ts` is
 *    out of this slice's touched-files scope, so the structural gate is
 *    duplicated rather than exported from there; a future slice could hoist
 *    a shared `isWorktreeShapedCwd` helper into that module instead). Any
 *    other cwd shape stays `unresolved`, even though
 *    `deriveWorktreeSafeBasename` itself would still return *something*
 *    (its own conservative last-segment passthrough) — that passthrough is
 *    never trusted as a resolution here.
 */
import type { DB } from '../storage/db.js';
import { resolveRepoIdentity } from './repo-identity.js';
import { deriveWorktreeSafeBasename } from '../pipeline/cwd-basename.js';

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
 * scan filter, `runRepoIdentityBackfill` only ever mutates a row when the
 * resolver DISAGREES with the stored value (see the `resolved === row.value`
 * guard below) — a false-positive scan candidate that's actually correct is
 * reported `unresolved` and left untouched.
 *
 * Used for BOTH `repo` and `project` scans (FEAT-553) — the bad-shape
 * catalogue is identical regardless of which column carries it; only the
 * resolver (git identity, then the DEC-017-gated string fallback) differs
 * by row, never the pattern used to select candidates.
 */
export const DEFAULT_BAD_REPO_PATTERN =
  /^(?:agent-[0-9a-f]{6,}|wt-[a-z0-9][a-z0-9-]*|worktree-[a-z0-9][a-z0-9-]*|[a-z]+(?:-[a-z]+){2,3})$/i;

export type RepoIdentityBackfillColumn = 'repo' | 'project';

export interface RepoIdentityBackfillOptions {
  dryRun: boolean;
  limit?: number;
  /** Override the bad-repo-shape guard. Defaults to DEFAULT_BAD_REPO_PATTERN. */
  pattern?: RegExp;
  /** Which `memories` (and, with `includeSessions`, `sessions`) column to
   *  scan + re-stamp. Defaults to `'repo'` (FEAT-484's original target). */
  column?: RepoIdentityBackfillColumn;
  /** When true, also re-stamp `sessions.<column>` to the same resolved
   *  value for every session touched by an applied/would-apply candidate.
   *  Defaults to `false` — FEAT-484 behaviour never touched `sessions`. */
  includeSessions?: boolean;
}

export type RepoIdentityBackfillReason = 'no-session' | 'no-cwd' | 'unresolved';

export interface RepoIdentityBackfillCandidate {
  memoryId: string;
  sessionId: string | null;
  /** The column's current (bad-shape) value on the memories row. */
  currentValue: string;
  cwd: string | null;
  /** The resolved replacement value, or null when unresolved. Always a
   *  repo-root BASENAME, never an absolute path (AC-9) — both resolution
   *  paths (`resolveRepoIdentity`, `deriveWorktreeSafeBasename`) already
   *  return basenames by construction. */
  resolvedValue: string | null;
  /** Count of OTHER memories already stamped with resolvedValue — the
   *  consolidation-grouping blast radius of this re-stamp. 0 when
   *  resolvedValue is null (nothing applied). */
  joiningExistingCount: number;
  applied: boolean;
  reason?: RepoIdentityBackfillReason;
}

export interface RepoIdentityBackfillResult {
  column: RepoIdentityBackfillColumn;
  /** Rows whose current column value matched the bad-shape pattern. */
  scanned: number;
  applied: number;
  unresolved: number;
  dryRun: boolean;
  candidates: RepoIdentityBackfillCandidate[];
  /** Number of DISTINCT `sessions` rows whose `<column>` was (or, in a dry
   *  run, would be) re-stamped to match an applied candidate's resolved
   *  value. Always 0 when `includeSessions` is false. */
  sessionsRestamped: number;
}

interface MemoryRow {
  id: string;
  value: string;
  session_id: string | null;
}

interface SessionRow {
  cwd: string | null;
  value: string | null;
}

/**
 * DEC-017 rule (1): a string-derived (non-git) identity is trusted ONLY for
 * the two tool-generated worktree layouts — the nested
 * `<repo>/.claude/worktrees/<x>` convention (Claude Code's own agent-
 * worktree layout, FEAT-553) and the sibling `<repo>-worktrees/<x>`
 * convention (FEAT-425). This mirrors the structural conditions
 * `deriveWorktreeSafeBasename` (src/pipeline/cwd-basename.ts) uses to
 * decide whether to special-case a cwd, WITHOUT reimplementing that
 * function's basename extraction — it only gates whether THIS caller may
 * trust that function's return value as a genuine resolution, versus its
 * conservative last-segment passthrough for every other shape (which this
 * backfill must never treat as a resolved identity — see AC-4).
 */
function isTrustedWorktreeCwdShape(cwd: string): boolean {
  const trimmed = cwd.replace(/[\\/]+$/, '');
  if (!trimmed) return false;
  const segments = trimmed.split(/[\\/]/).filter(Boolean);

  // Nested shape: <repo>/.claude/worktrees/<x> (depth 3 / depth 2 from the
  // end), with a non-empty repo segment ahead of ".claude".
  if (segments.length >= 4) {
    const maybeClaude = segments[segments.length - 3];
    const maybeWorktrees = segments[segments.length - 2];
    if (maybeClaude === '.claude' && maybeWorktrees === 'worktrees' && segments[segments.length - 4]) {
      return true;
    }
  }

  // Sibling shape: <repo>-worktrees/<x>.
  if (segments.length >= 2) {
    const parent = segments[segments.length - 2];
    if (parent && /^.+-worktrees$/i.test(parent)) return true;
  }

  return false;
}

/**
 * The DEC-017 resolver: git identity first, then a trust-gated string
 * fallback. Returns null (never guesses) when git can't answer AND cwd
 * doesn't structurally match one of the two trusted worktree layouts.
 */
function resolveColumnIdentity(cwd: string): string | null {
  const gitResolved = resolveRepoIdentity(cwd);
  if (gitResolved) return gitResolved;
  if (!isTrustedWorktreeCwdShape(cwd)) return null;
  return deriveWorktreeSafeBasename(cwd);
}

export function runRepoIdentityBackfill(
  db: DB,
  opts: RepoIdentityBackfillOptions,
): RepoIdentityBackfillResult {
  const pattern = opts.pattern ?? DEFAULT_BAD_REPO_PATTERN;
  const column: RepoIdentityBackfillColumn = opts.column ?? 'repo';
  const includeSessions = opts.includeSessions ?? false;

  // Column name is restricted to the 'repo' | 'project' union above (and
  // re-validated by CLI-side argv parsing before this is ever called with a
  // string from outside this process) — never interpolate an unvalidated
  // string into SQL here.
  if (column !== 'repo' && column !== 'project') {
    throw new Error(`runRepoIdentityBackfill: invalid column ${JSON.stringify(column)}`);
  }

  // Pull all non-blank-value rows and filter by `pattern` in JS — SQLite has
  // no portable REGEXP without a loadable extension, and the candidate set
  // (agent-* mis-tags) is small relative to the full memories table.
  const rows = db.prepare(`
    SELECT id, ${column} as value, session_id FROM memories
    WHERE ${column} IS NOT NULL AND TRIM(${column}) != ''
    ORDER BY created_at ASC
  `).all() as MemoryRow[];

  const sessionStmt = db.prepare(`SELECT cwd, ${column} as value FROM sessions WHERE id = ?`);
  const countStmt = db.prepare(`SELECT COUNT(*) as n FROM memories WHERE ${column} = ?`);
  const updateStmt = db.prepare(`UPDATE memories SET ${column} = ?, updated_at = ? WHERE id = ?`);
  const updateSessionStmt = db.prepare(`UPDATE sessions SET ${column} = ? WHERE id = ?`);

  const candidates: RepoIdentityBackfillCandidate[] = [];
  let scanned = 0;
  let applied = 0;
  let unresolved = 0;

  // Sessions queued for a re-stamp, deduped by session id (multiple
  // memories under the same session resolve to the same value, so this
  // only ever needs ONE update + ONE count per session, not per memory).
  const sessionsToRestamp = new Map<string, string>();

  for (const row of rows) {
    if (!pattern.test(row.value)) continue;
    if (opts.limit !== undefined && scanned >= opts.limit) break;
    scanned++;

    if (!row.session_id) {
      candidates.push({
        memoryId: row.id, sessionId: null, currentValue: row.value, cwd: null,
        resolvedValue: null, joiningExistingCount: 0, applied: false, reason: 'no-session',
      });
      unresolved++;
      continue;
    }

    const session = sessionStmt.get(row.session_id) as SessionRow | undefined;
    const cwd = session?.cwd ?? null;
    if (!cwd) {
      candidates.push({
        memoryId: row.id, sessionId: row.session_id, currentValue: row.value, cwd: null,
        resolvedValue: null, joiningExistingCount: 0, applied: false, reason: 'no-cwd',
      });
      unresolved++;
      continue;
    }

    const resolved = resolveColumnIdentity(cwd);
    if (!resolved || resolved === row.value) {
      candidates.push({
        memoryId: row.id, sessionId: row.session_id, currentValue: row.value, cwd,
        resolvedValue: resolved, joiningExistingCount: 0, applied: false, reason: 'unresolved',
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
      memoryId: row.id, sessionId: row.session_id, currentValue: row.value, cwd,
      resolvedValue: resolved, joiningExistingCount, applied: !opts.dryRun,
    });

    if (includeSessions && session && session.value !== resolved) {
      sessionsToRestamp.set(row.session_id, resolved);
    }
  }

  let sessionsRestamped = 0;
  if (includeSessions) {
    for (const [sessionId, resolved] of sessionsToRestamp) {
      sessionsRestamped++;
      if (!opts.dryRun) {
        updateSessionStmt.run(resolved, sessionId);
      }
    }
  }

  return { column, scanned, applied, unresolved, dryRun: opts.dryRun, candidates, sessionsRestamped };
}
