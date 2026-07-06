/**
 * Bulk-promote + payload backfill so existing local memories can sync to the
 * cloud (`astramem-local sync backfill`).
 *
 * Two obstacles this closes:
 *   1. Scope filter (ADR-009): only team/org atoms ship. Private never does.
 *      `applyBackfill` promotes private → the chosen tier so they become
 *      shippable. IRREVERSIBLE — scope is upward-only.
 *   2. Empty replicas: `create` events written before the payload fix
 *      (astramem-local#86) carry `payload_json = NULL`, so they materialize
 *      with empty content in the cloud. We backfill content onto every
 *      null-payload, not-yet-shipped create event.
 *
 * Already-synced (synced_at set) events are left alone by `applyBackfill` —
 * the cloud dedups by atom_id, so re-shipping them was historically a no-op.
 *
 * astramem-local#97 / memory#629 close the remaining gap: create events that
 * shipped BEFORE #86 landed already carry `synced_at` but an empty cloud
 * replica (their payload was null at ship time). The cloud now upserts empty
 * content onto a re-shipped create (memory#629, merged), so
 * `planReship`/`applyReship` below backfill the payload onto those
 * already-synced rows AND reset `synced_at = NULL` so the shipper re-sends
 * them — the cloud upsert then fills in the previously-empty replica.
 * Scope-safe (team/org atoms only, matching ADR-009) and idempotent (a row
 * that already carries a payload is never touched, so re-running reships
 * nothing new).
 */

import type { DB } from '../storage/db.js';
import { MemoryEventRepo } from '../storage/memory-events.js';
import type { MemoryScope } from '../contracts/index.js';

export interface BackfillOptions {
  /** Promotion target for private atoms. Upward-only. */
  scope: Extract<MemoryScope, 'team' | 'org'>;
  /** Restrict to a single local project (memories.project); null = all. */
  project?: string | null;
}

export interface BackfillPlan {
  scope: MemoryScope;
  project: string | null;
  /** Private atoms that would be promoted (and thus start shipping). */
  privateToPromote: number;
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
    privateToPromote: count(`SELECT COUNT(*) n FROM memories WHERE scope='private' ${clause}`),
    alreadyShareable: count(`SELECT COUNT(*) n FROM memories WHERE scope IN ('team','org') ${clause}`),
    createEventsToBackfill: count(`
      SELECT COUNT(*) n FROM memory_events e JOIN memories m ON m.id = e.atom_id
      WHERE e.event_type='create' AND e.payload_json IS NULL AND e.synced_at IS NULL
        ${project ? 'AND m.project = @project' : ''}`),
  };
}

/**
 * Apply the promotion + backfill in one transaction. IRREVERSIBLE.
 *   1. Promote private → target FIRST, so the payload backfill reads the
 *      final scope and the create event materializes at the right cloud tier.
 *   2. Backfill content onto null-payload, unsynced create events for every
 *      now-shareable atom.
 */
export function applyBackfill(db: DB, opts: BackfillOptions): BackfillResult {
  const project = opts.project ?? null;
  const { clause, bind } = whereProject(project);
  const events = new MemoryEventRepo(db);

  const tx = db.transaction((): BackfillResult => {
    const rows = db.prepare(`SELECT id FROM memories WHERE scope='private' ${clause}`).all(bind) as { id: string }[];
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

export interface ReshipOptions {
  /** Restrict to one shareable tier; omit to cover both team and org. */
  scope?: Extract<MemoryScope, 'team' | 'org'>;
  /** Restrict to a single local project (memories.project); null = all. */
  project?: string | null;
}

export interface ReshipPlan {
  scope: Extract<MemoryScope, 'team' | 'org'> | 'team+org';
  project: string | null;
  /**
   * Already-synced, null-payload team/org create events that would be
   * backfilled + re-queued for shipping. Distinct from `BackfillPlan`'s
   * `createEventsToBackfill`, which only ever counts UNsynced rows.
   */
  createEventsToBackfillAndReship: number;
}

export interface ReshipResult {
  reshipped: number;
}

function whereScope(scope: Extract<MemoryScope, 'team' | 'org'> | undefined): { clause: string; bind: Record<string, string> } {
  return scope ? { clause: 'scope = @scope', bind: { scope } } : { clause: "scope IN ('team','org')", bind: {} };
}

/**
 * Read-only: count what an `applyReship` would touch. Safe to run against a
 * live DB.
 */
export function planReship(db: DB, opts: ReshipOptions): ReshipPlan {
  const project = opts.project ?? null;
  const { clause: scopeClause, bind: scopeBind } = whereScope(opts.scope);
  const projectClause = project ? 'AND m.project = @project' : '';
  const bind = { ...scopeBind, ...(project ? { project } : {}) };

  const createEventsToBackfillAndReship = (
    db
      .prepare(`
        SELECT COUNT(*) n FROM memory_events e JOIN memories m ON m.id = e.atom_id
        WHERE e.event_type='create' AND e.payload_json IS NULL AND e.synced_at IS NOT NULL
          AND m.${scopeClause} ${projectClause}`)
      .get(bind) as { n: number }
  ).n;

  return {
    scope: opts.scope ?? 'team+org',
    project,
    createEventsToBackfillAndReship,
  };
}

/**
 * Backfill payload onto already-synced, null-payload team/org create events
 * AND reset their `synced_at` to NULL so the shipper re-sends them
 * (astramem-local#97 / memory#629). One transaction.
 *
 * Idempotent: the WHERE clause requires `payload_json IS NULL`, so a row
 * this already touched (payload now non-null) is never matched again — a
 * second call reships nothing new. Scope-safe: only atoms currently
 * team/org are eligible; private atoms are never reset or reshipped here
 * (use `applyBackfill` to promote them first).
 */
export function applyReship(db: DB, opts: ReshipOptions): ReshipResult {
  const project = opts.project ?? null;
  const { clause: scopeClause, bind: scopeBind } = whereScope(opts.scope);
  const projectClause = project ? 'AND project = @project' : '';
  const bind = { ...scopeBind, ...(project ? { project } : {}) };

  const tx = db.transaction((): ReshipResult => {
    const result = db
      .prepare(`
        UPDATE memory_events
        SET payload_json = (
          SELECT json_object('text', m.text, 'type', m.type, 'scope', m.scope,
            'importance', m.importance, 'confidence', m.confidence,
            'repo', COALESCE(m.repo, m.project, ''))
          FROM memories m WHERE m.id = memory_events.atom_id),
          synced_at = NULL
        WHERE event_type='create' AND payload_json IS NULL AND synced_at IS NOT NULL
          AND atom_id IN (SELECT id FROM memories WHERE ${scopeClause} ${projectClause})
      `)
      .run(bind);

    return { reshipped: result.changes };
  });
  return tx();
}
