/**
 * `astramem-local repo-identity-backfill [--yes] [--limit N] [--pattern REGEX] [--json]`
 *
 * FEAT-484 (issue #177) — one-shot re-stamp of memories mis-tagged
 * `repo='agent-<hash>'` (or another ephemeral worktree-basename shape) by
 * the worktree-basename provenance bug fixed in src/tag-hygiene/derive-repo.ts.
 * See src/tag-hygiene/repo-identity-backfill.ts for the core (DB-only,
 * testable) logic, the DEFAULT_BAD_REPO_PATTERN shape catalogue, and the
 * migration-hazard notes.
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
 */

import { openRuntimeDb } from './open-runtime-db.js';
import {
  runRepoIdentityBackfill,
  type RepoIdentityBackfillResult,
} from '../tag-hygiene/repo-identity-backfill.js';
import { parseArg } from './arg-parse.js';

export function repoIdentityBackfillCommand(args: string[]): void {
  const jsonMode = args.includes('--json');
  const apply = args.includes('--yes');

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
    const result: RepoIdentityBackfillResult = runRepoIdentityBackfill(db, {
      dryRun: !apply,
      limit,
      pattern,
    });

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('');
    console.log('  AstraMemory Repo Identity Backfill');
    console.log('  ───────────────────────────────────');
    console.log(`  Scanned (repo matches bad-shape pattern): ${result.scanned}`);
    console.log(`  ${result.dryRun ? 'Would re-stamp' : 'Re-stamped'}: ${result.applied}`);
    console.log(`  Left unresolved (no session/cwd, or git couldn't resolve): ${result.unresolved}`);
    if (result.dryRun) {
      console.log('  Preview only — no rows were mutated. Pass --yes to apply. Proposed changes:');
      for (const c of result.candidates) {
        if (!c.resolvedRepo || c.resolvedRepo === c.currentRepo) continue;
        const merge = c.joiningExistingCount > 0
          ? ` (joins ${c.joiningExistingCount} existing '${c.resolvedRepo}' memories)`
          : '';
        console.log(`    ${c.memoryId}: repo ${c.currentRepo} -> ${c.resolvedRepo}${merge}`);
      }
      const unresolvedRows = result.candidates.filter(c => c.reason);
      if (unresolvedRows.length > 0) {
        console.log('  Left unresolved:');
        for (const c of unresolvedRows) {
          console.log(`    ${c.memoryId}: repo ${c.currentRepo} — ${c.reason}`);
        }
      }
    }
    console.log('');
  } finally {
    db.close();
  }
}
