/**
 * `astramem-local repo-identity-backfill [--yes] [--column repo|project|all]
 *   [--sessions] [--limit N] [--pattern REGEX] [--json]`
 *
 * FEAT-484 (issue #177) — one-shot re-stamp of memories mis-tagged
 * `repo='agent-<hash>'` (or another ephemeral worktree-basename shape) by
 * the worktree-basename provenance bug fixed in src/tag-hygiene/derive-repo.ts.
 * Extended by FEAT-553 (SLICE-445, DEC-017) to also cover the `project`
 * column and the `sessions` table. See src/tag-hygiene/repo-identity-backfill.ts
 * for the core (DB-only, testable) logic, the DEFAULT_BAD_REPO_PATTERN shape
 * catalogue, and the migration-hazard notes.
 *
 * `--column` selects which column(s) to scan + re-stamp: `repo` (default,
 * FEAT-484's original target), `project`, or `all` (runs both, one pass
 * each, reported separately — never merged into one pass, so each column's
 * scanned/applied/unresolved counts stay independently auditable).
 *
 * `--sessions` additionally re-stamps `sessions.<column>` for every session
 * touched by an applied re-stamp (FEAT-553) — FEAT-484 never touched
 * `sessions`, only `memories`.
 *
 * `--pattern` overrides DEFAULT_BAD_REPO_PATTERN with a custom regex (case
 * -insensitive, anchored the same way the caller writes it — no implicit
 * `^`/`$` are added) for a shape this daemon's ecosystem hasn't seen yet.
 * Invalid regex syntax fails loudly (non-zero exit) rather than silently
 * falling back to the default — a mistyped flag must never silently widen
 * (or narrow) the scan to something the operator didn't ask for.
 *
 * Preview is the DEFAULT (mirrors entity-purge-junk's --yes gate) — a data
 * migration that changes consolidation grouping keys must never run
 * unattended by accident. `--yes` is required to actually mutate rows.
 *
 * AC-9 posture: this command never prints a raw filesystem path. Every
 * value shown (current or resolved) is a repo-root BASENAME by
 * construction of the core resolver — `candidate.cwd` (the full path) is
 * part of the returned data shape for callers that need it (tests, `--json`
 * consumers performing their own redaction) but is never written to the
 * human-readable console output here.
 */

import { openRuntimeDb } from './open-runtime-db.js';
import {
  runRepoIdentityBackfill,
  type RepoIdentityBackfillColumn,
  type RepoIdentityBackfillResult,
} from '../tag-hygiene/repo-identity-backfill.js';
import { parseArg, hasFlag } from './arg-parse.js';

const VALID_COLUMN_ARGS = ['repo', 'project', 'all'] as const;
type ColumnArg = typeof VALID_COLUMN_ARGS[number];

function printResult(result: RepoIdentityBackfillResult): void {
  console.log('');
  console.log(`  AstraMemory Repo Identity Backfill — column: ${result.column}`);
  console.log('  ───────────────────────────────────');
  console.log(`  Scanned (${result.column} matches bad-shape pattern): ${result.scanned}`);
  console.log(`  ${result.dryRun ? 'Would re-stamp' : 'Re-stamped'}: ${result.applied}`);
  console.log(`  Left unresolved (no session/cwd, or unresolvable): ${result.unresolved}`);
  console.log(
    `  Sessions ${result.dryRun ? 'that would be re-stamped' : 're-stamped'}: ${result.sessionsRestamped}`,
  );
  if (result.dryRun) {
    console.log('  Preview only — no rows were mutated. Pass --yes to apply. Proposed changes:');
    for (const c of result.candidates) {
      if (!c.resolvedValue || c.resolvedValue === c.currentValue) continue;
      const merge = c.joiningExistingCount > 0
        ? ` (joins ${c.joiningExistingCount} existing '${c.resolvedValue}' memories)`
        : '';
      console.log(`    ${c.memoryId}: ${result.column} ${c.currentValue} -> ${c.resolvedValue}${merge}`);
    }
    const unresolvedRows = result.candidates.filter(c => c.reason);
    if (unresolvedRows.length > 0) {
      console.log('  Left unresolved:');
      for (const c of unresolvedRows) {
        console.log(`    ${c.memoryId}: ${result.column} ${c.currentValue} — ${c.reason}`);
      }
    }
  }
  console.log('');
}

export function repoIdentityBackfillCommand(args: string[]): void {
  const jsonMode = args.includes('--json');
  const apply = args.includes('--yes');
  const includeSessions = hasFlag(args, '--sessions');

  const columnArg = (parseArg(args, '--column') ?? 'repo') as string;
  if (!VALID_COLUMN_ARGS.includes(columnArg as ColumnArg)) {
    console.error(
      `repo-identity-backfill: --column must be one of ${VALID_COLUMN_ARGS.join('|')}, got ${JSON.stringify(columnArg)}`,
    );
    process.exitCode = 1;
    return;
  }
  const columns: RepoIdentityBackfillColumn[] =
    columnArg === 'all' ? ['repo', 'project'] : [columnArg as RepoIdentityBackfillColumn];

  const limitArg = parseArg(args, '--limit');
  let limit: number | undefined;
  if (limitArg !== undefined) {
    const parsedLimit = Number(limitArg);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      console.error(`repo-identity-backfill: --limit must be a positive number, got ${JSON.stringify(limitArg)}`);
      process.exitCode = 1;
      return;
    }
    limit = Math.max(1, Math.floor(parsedLimit));
  }

  const patternArg = parseArg(args, '--pattern');
  let pattern: RegExp | undefined;
  if (patternArg !== undefined) {
    try {
      pattern = new RegExp(patternArg, 'i');
    } catch (err) {
      console.error(`repo-identity-backfill: --pattern is not a valid regex: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
  }

  const { db } = openRuntimeDb();
  try {
    const results: Partial<Record<RepoIdentityBackfillColumn, RepoIdentityBackfillResult>> = {};
    for (const column of columns) {
      results[column] = runRepoIdentityBackfill(db, {
        dryRun: !apply,
        limit,
        pattern,
        column,
        includeSessions,
      });
    }

    if (jsonMode) {
      console.log(JSON.stringify(columns.length === 1 ? results[columns[0]!] : results, null, 2));
      return;
    }

    for (const column of columns) {
      printResult(results[column]!);
    }
  } finally {
    db.close();
  }
}
