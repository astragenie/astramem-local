/**
 * Memory TTL / archival tiers policy pass (FEAT-404, W4.4).
 *
 * Runs on the cleanup job's cadence (src/pipeline/handlers/cleanup.ts).
 * Both conditions are required to archive an atom (AC-2/AC-3):
 *   - older than config.archival.ageThresholdDays (measured from created_at)
 *   - trailing-7-day usefulness rate at/below config.archival.usefulnessFloor
 *
 * Non-destructive (AC-5): every archived row survives — MemoryEventRepo.archive
 * sets valid_to + archived/archived_at in the same transaction supersede()/
 * invalidate() already established, restorable via MemoryEventRepo.restore().
 * Off by default (AC-1): config.archival.enabled === false is a hard no-op.
 */

import type { DB } from './db.js';
import type { Config } from '../config/config.js';
import { MemoryEventRepo } from './memory-events.js';
import { perAtomUsefulnessRate7d } from './usefulness.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * DAY_MS;

export interface ArchivalRunResult {
  /** Number of memories archived by this pass. */
  archived: number;
  /** Number of memories that met the age threshold and were evaluated
   *  against the usefulness floor (archived + age-eligible-but-protected). */
  candidates: number;
}

/**
 * Select every currently-valid, not-yet-archived memory older than the age
 * threshold, evaluate each against the usefulness floor, and archive the
 * ones that clear both bars. Returns { archived: 0, candidates: 0 }
 * immediately when the policy is disabled (AC-1).
 */
export function runArchivalPass(db: DB, config: Config, now: number = Date.now()): ArchivalRunResult {
  if (!config.archival.enabled) return { archived: 0, candidates: 0 };

  const ageCutoffMs = now - config.archival.ageThresholdDays * DAY_MS;
  const candidateRows = db.prepare(`
    SELECT id FROM memories
    WHERE valid_to IS NULL AND archived = 0 AND created_at < ?
  `).all(ageCutoffMs) as Array<{ id: string }>;

  if (candidateRows.length === 0) return { archived: 0, candidates: 0 };

  const candidateIds = candidateRows.map(r => r.id);
  const rates = perAtomUsefulnessRate7d(db, candidateIds, now - SEVEN_DAYS_MS);
  const events = new MemoryEventRepo(db);

  let archived = 0;
  for (const id of candidateIds) {
    const rate = rates.get(id) ?? 0;
    if (rate <= config.archival.usefulnessFloor) {
      events.archive(id, 'ttl-policy');
      archived++;
    }
  }

  return { archived, candidates: candidateIds.length };
}
