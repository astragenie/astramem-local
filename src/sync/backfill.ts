/**
 * Bulk-promote + payload backfill so existing local memories can sync to the
 * cloud (`astramem-local sync backfill`).
 *
 * Two obstacles this closes:
 *   1. Scope filter (ADR-009): only team/org atoms ship. Personal never does.
 *      `applyBackfill` promotes personal → the chosen tier so they become
 *      shippable. IRREVERSIBLE — scope is upward-only.
 *   2. Empty replicas: `create` events written before the payload fix
 *      (astramem-local#86) carry `payload_json = NULL`, so they materialize
 *      with empty content in the cloud. We backfill content onto every
 *      null-payload, not-yet-shipped create event.
 *
 * Already-synced (synced_at set) events are left alone — the cloud dedups by
 * atom_id, so re-shipping them is a no-op; fixing those needs a cloud-side
 * re-materialize, out of scope here.
 */

import type { DB } from '../storage/db.js';
import { MemoryEventRepo } from '../storage/memory-events.js';
import type { MemoryScope } from '../contracts/index.js';

export interface BackfillOptions {
  /** Promotion target for personal atoms. Upward-only. */
  scope: Extract<MemoryScope, 'team' | 'org'>;
  /** Restrict to a single local project (memories.project); null = all. */
  project?: string | null;
}

export interface BackfillPlan {
  scope: MemoryScope;
  project: string | null;
  /** Personal atoms that would be promoted (and thus start shipping). */
  personalToPromote: number;
  /** Atoms already team/org (already shippable). */
  alreadyShareable: number;
  /** Null-payload, unsynced create events that would be backfilled. */
  createEventsToBackfill: number;
}

export interface BackfillResult {
  promoted: number;
  backfilled: number;
}

function whereProject(project: string | null): { clause: string; bind: Record<string, string> } {
  return project ? { clause: 'AND project = @project', bind: { project } } : { clause: '', bind: {} };
}

/** Read-only: count what an apply would touch. Safe to run against a live DB. */
export function planBackfill(db: DB, opts: BackfillOptions): BackfillPlan {
  const project = opts.project ?? null;
  const { clause, bind } = whereProject(project);
  const count = (sql: string): number => (db.prepare(sql).get(bind) as { n: number }).n;

  return {
    scope: opts.scope,
    project,
    personalToPromote: count(`SELECT COUNT(*) n FROM memories WHERE scope='personal' ${clause}`),
    alreadyShareable: count(`SELECT COUNT(*) n FROM memories WHERE scope IN ('team','org') ${clause}`),
    createEventsToBackfill: count(`
      SELECT COUNT(*) n FROM memory_events e JOIN memories m ON m.id = e.atom_id
      WHERE e.event_type='create' AND e.payload_json IS NULL AND e.synced_at IS NULL
        ${project ? 'AND m.project = @project' : ''}`),
  };
}

/**
 * Apply the promotion + backfill in one transaction. IRREVERSIBLE.
 *   1. Promote personal → target FIRST, so the payload backfill reads the
 *      final scope and the create event materializes at the right cloud tier.
 *   2. Backfill content onto null-payload, unsynced create events for every
 *      now-shareable atom.
 */
export function applyBackfill(db: DB, opts: BackfillOptions): BackfillResult {
  const project = opts.project ?? null;
  const { clause, bind } = whereProject(project);
  const events = new MemoryEventRepo(db);

  const tx = db.transaction((): BackfillResult => {
    const rows = db.prepare(`SELECT id FROM memories WHERE scope='personal' ${clause}`).all(bind) as { id: string }[];
    for (const r of rows) events.promoteScope(r.id, opts.scope);

    const filled = db.prepare(`
      UPDATE memory_events
      SET payload_json = (
        SELECT json_object('text', m.text, 'type', m.type, 'scope', m.scope,
          'importance', m.importance, 'confidence', m.confidence,
          'repo', COALESCE(m.repo, m.project, ''))
        FROM memories m WHERE m.id = memory_events.atom_id)
      WHERE event_type='create' AND payload_json IS NULL AND synced_at IS NULL
        AND atom_id IN (SELECT id FROM memories WHERE scope IN ('team','org') ${clause})
    `).run(bind);

    return { promoted: rows.length, backfilled: filled.changes };
  });
  return tx();
}
