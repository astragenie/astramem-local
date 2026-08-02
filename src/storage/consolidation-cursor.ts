/**
 * Persisted resumable cursor for consolidation's candidate-selection group
 * scheduling (P2.1 stabilization, migration 050). Single-row table (id=1
 * enforced) — mirrors `sync_pull_state`'s shape (migration 010).
 *
 * Originally only meaningful when `consolidation.maxCandidatePairsPerRun`
 * is set (an opt-in pair-budget ceiling, default null/off) — see
 * `src/consolidate/consolidate.ts`'s group-ordering doc comment for why a
 * plain Map-insertion-order (or raw SQL scan order) truncation would
 * permanently starve whichever (repo,type) groups sort last every run.
 *
 * FEAT-482 review fix (PR #463): also written/read regardless of
 * `maxCandidatePairsPerRun` whenever a run stops early for ANY reason
 * (ceiling hit, `setupBudgetExceeded`, or `preemptIfHigherPriorityPending`)
 * — the same starvation risk applies to those early-abort paths under the
 * shipped default (no ceiling) config, and preemption in particular can
 * fire far more easily than the old ceiling/budget triggers ever did. A
 * row only ever exists once some pass has stopped early at least once;
 * `getConsolidationCursor` still returns `null` (not `{groupKey: null}`)
 * for an install that has never hit any early-abort path.
 */
import type { DB } from './db.js';

export interface ConsolidationCursor {
  /** (repo,type) group key to resume scanning from on the next run. `null`
   *  means "start from the beginning" — either no cursor has ever been
   *  persisted, or the last run completed a full sweep and reset it. */
  groupKey: string | null;
}

/** `null` when no cursor row has ever been written (equivalent to
 *  `{ groupKey: null }` — callers can treat both the same way). */
export function getConsolidationCursor(db: DB): ConsolidationCursor | null {
  const row = db.prepare('SELECT group_key FROM consolidation_cursor WHERE id = 1').get() as
    { group_key: string | null } | undefined;
  if (!row) return null;
  return { groupKey: row.group_key };
}

export function setConsolidationCursor(db: DB, cursor: ConsolidationCursor): void {
  db.prepare(`
    INSERT INTO consolidation_cursor (id, group_key, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET group_key = excluded.group_key, updated_at = excluded.updated_at
  `).run(cursor.groupKey, Date.now());
}
