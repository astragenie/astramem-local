/**
 * runEntityBackfill — FEAT-402 AC-7. One-shot pass that extracts + links
 * entities for the pre-existing corpus WITHOUT re-distilling memory text:
 * memories.text/normalized_text/hash are never touched, only entities +
 * memory_entities rows are written.
 *
 * Candidate selection (`memories NOT IN memory_entities`) makes this
 * idempotent by construction, same shape as the tag-hygiene backfill
 * (src/tag-hygiene/backfill.ts): a memory that already has at least one
 * entity link is never re-selected, so re-running on a fully-linked corpus
 * is a pure no-op scan. A memory whose extraction genuinely found nothing
 * (or failed/was budget-skipped) stays a candidate for the next run since it
 * never received a link — no separate "tried and found nothing" state is
 * needed for slice 1.
 */

import type { DB } from '../storage/db.js';
import type { LLMProvider } from '../contracts/index.js';
import { BudgetTracker } from '../budget/tracker.js';
import { EntityRepo } from '../storage/entities.js';
import { extractEntitiesForText } from './extract-entities.js';

export interface EntityBackfillOptions {
  dryRun: boolean;
  limit?: number;
  capUsd: number;
}

export interface EntityBackfillResult {
  scanned: number;
  linked: number;
  entitiesLinked: number;
  skipped: number;
  dryRun: boolean;
}

interface MemoryRow {
  id: string;
  text: string;
}

export async function runEntityBackfill(
  db: DB,
  provider: LLMProvider,
  opts: EntityBackfillOptions,
): Promise<EntityBackfillResult> {
  const limitClause = opts.limit !== undefined ? ` LIMIT ${Math.max(1, opts.limit)}` : '';
  const rows = db
    .prepare(`
      SELECT m.id, m.text
      FROM memories m
      LEFT JOIN memory_entities me ON me.memory_id = m.id
      WHERE me.memory_id IS NULL
      ORDER BY m.created_at ASC${limitClause}
    `)
    .all() as MemoryRow[];

  const budget = new BudgetTracker(db);
  const entityRepo = new EntityRepo(db);

  let linked = 0;
  let entitiesLinked = 0;
  let skipped = 0;

  for (const row of rows) {
    const entities = await extractEntitiesForText(row.text, provider, budget, opts.capUsd);
    if (entities.length === 0) {
      skipped++;
      continue;
    }
    if (!opts.dryRun) {
      entityRepo.linkEntitiesForMemory(row.id, entities);
    }
    linked++;
    entitiesLinked += entities.length;
  }

  return {
    scanned: rows.length,
    linked,
    entitiesLinked,
    skipped,
    dryRun: opts.dryRun,
  };
}
