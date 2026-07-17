/**
 * `astramem-local repo-identity-backfill [--yes] [--limit N] [--json]`
 *
 * FEAT-484 (issue #177) — one-shot re-stamp of memories mis-tagged
 * `repo='agent-<hash>'` by the worktree-basename provenance bug fixed in
 * src/tag-hygiene/derive-repo.ts. See src/tag-hygiene/repo-identity-backfill.ts
 * for the core (DB-only, testable) logic and the migration-hazard notes.
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

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export function repoIdentityBackfillCommand(args: string[]): void {
  const jsonMode = args.includes('--json');
  const apply = args.includes('--yes');
  const limitArg = parseArg(args, '--limit');
  const limit = limitArg ? Math.max(1, Number(limitArg)) : undefined;

  const { db } = openRuntimeDb();

  const result: RepoIdentityBackfillResult = runRepoIdentityBackfill(db, {
    dryRun: !apply,
    limit,
  });

  db.close();

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
}
