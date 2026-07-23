/**
 * `astramem-local entity-backfill [--dry-run] [--limit N] [--json]`
 *
 * FEAT-402 (W4.2) AC-7 — one-shot entity extraction + linking backfill for
 * memories that predate distill-time entity extraction (migration 012).
 * Extracts entities from existing memory text via the extraction LLM
 * provider and links them; never re-distills or mutates memory text. See
 * src/entity/backfill.ts for the core (DB-only, testable) logic.
 */

import { openRuntimeDb } from './open-runtime-db.js';
import { getProviders } from '../providers/index.js';
import { runEntityBackfill, type EntityBackfillResult } from '../entity/backfill.js';
import { parseArg } from './arg-parse.js';

export async function entityBackfillCommand(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const limitArg = parseArg(args, '--limit');
  const limit = limitArg ? Math.max(1, Number(limitArg)) : undefined;

  const { db, cfg } = openRuntimeDb();
  const provider = getProviders(cfg).llm.extraction;

  const result: EntityBackfillResult = await runEntityBackfill(db, provider, {
    dryRun,
    limit,
    capUsd: cfg.budget.daily_usd,
  });

  db.close();

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('');
  console.log('  AstraMemory Entity Backfill');
  console.log('  ───────────────────────────');
  console.log(`  Scanned: ${result.scanned}`);
  console.log(`  Memories linked: ${result.linked}`);
  console.log(`  Entity links created: ${result.entitiesLinked}`);
  console.log(`  Skipped (no entities found): ${result.skipped}`);
  if (dryRun) {
    console.log('  --dry-run: no rows were mutated.');
  }
  console.log('');
}
