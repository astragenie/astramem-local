/**
 * Recall-usefulness event capture + metric (ADR-010, v1: measure only — the
 * events captured here do NOT feed ranking yet, that's v1.x).
 *
 * Rides the existing memory_events log ('usefulness' event_type, already
 * present in the migration 007 CHECK constraint) — no new migration. Three
 * payload families, distinguished by payload.family:
 *
 *   - recall_served    — one event per atom returned from a search/recall
 *                         surface (REST /search, /recall, /recall/pack; MCP
 *                         search_memory/recall_memory).
 *   - recall_used       — explicit or heuristic signal that a served atom
 *                         mattered. v1 ships the explicit channel only
 *                         (mark_memory_used MCP tool / POST /memory/:id/used).
 *   - memory_corrected  — negative signal: the atom was invalidated,
 *                         superseded, demoted, or edited. Appended directly
 *                         inside MemoryEventRepo.invalidate/supersede's own
 *                         transaction (src/storage/memory-events.ts) — this
 *                         module documents the payload shape those call
 *                         sites use, but does not append on their behalf, to
 *                         avoid a circular import between the two modules.
 *
 * Privacy: the raw query text is NEVER stored — only a truncated sha256 hex
 * digest (hashQuery). Usefulness events inherit the atom's scope (ADR-009)
 * like every other memory_events row.
 */

import { createHash } from 'node:crypto';
import type { DB } from './db.js';
import { MemoryEventRepo } from './memory-events.js';

export type UsefulnessSurface = 'mcp' | 'rest' | 'cli';
export type UsefulnessSignal = 'explicit' | 'heuristic';
export type CorrectionAction = 'invalidated' | 'superseded' | 'demoted' | 'edited';

/** sha256 hex digest of the raw query, truncated to 16 chars — never store the query text itself. */
export function hashQuery(query: string): string {
  return createHash('sha256').update(query).digest('hex').slice(0, 16);
}

export interface RecordRecallServedInput {
  /** Precomputed query hash. Provide this OR `query` (which gets hashed here). */
  queryHash?: string;
  /** Raw query/recall-input text — hashed via hashQuery, never persisted as-is. */
  query?: string;
  atomIds: string[];
  /** Optional per-atom scores, aligned by index with atomIds. */
  scores?: number[];
  surface: UsefulnessSurface;
  /** Free-form label for the recall mode (e.g. 'search', 'recall', 'pack'). */
  mode?: string;
}

/**
 * Append one 'usefulness'/'recall_served' event per served atom, in a single
 * transaction. Cheap by design: one prepared-statement loop, no per-atom
 * round trip beyond the INSERT itself. No-ops on an empty atomIds list.
 */
export function recordRecallServed(db: DB, input: RecordRecallServedInput): void {
  if (input.atomIds.length === 0) return;
  const queryHash = input.queryHash ?? (input.query !== undefined ? hashQuery(input.query) : undefined);
  if (!queryHash) throw new Error('recordRecallServed requires queryHash or query');

  const events = new MemoryEventRepo(db);
  const tx = db.transaction(() => {
    input.atomIds.forEach((atomId, i) => {
      events.append({
        event_type: 'usefulness',
        atom_id: atomId,
        payload: {
          family: 'recall_served',
          query_hash: queryHash,
          score: input.scores?.[i] ?? null,
          surface: input.surface,
          mode: input.mode ?? null,
        },
      });
    });
  });
  tx();
}

export interface RecordRecallUsedInput {
  atomId: string;
  surface: UsefulnessSurface;
  signal: UsefulnessSignal;
}

/** Append one 'usefulness'/'recall_used' event — the atom mattered. */
export function recordRecallUsed(db: DB, input: RecordRecallUsedInput): void {
  new MemoryEventRepo(db).append({
    event_type: 'usefulness',
    atom_id: input.atomId,
    payload: { family: 'recall_used', surface: input.surface, signal: input.signal },
  });
}

export interface RecordMemoryCorrectedInput {
  atomId: string;
  action: CorrectionAction;
}

/**
 * Append one 'usefulness'/'memory_corrected' event — a negative signal.
 * Exposed for direct callers (e.g. future demote/edit flows); the
 * invalidate/supersede lifecycle ops append this shape inline instead of
 * calling this function, to keep memory-events.ts free of a dependency on
 * this module (see file header).
 */
export function recordMemoryCorrected(db: DB, input: RecordMemoryCorrectedInput): void {
  new MemoryEventRepo(db).append({
    event_type: 'usefulness',
    atom_id: input.atomId,
    payload: { family: 'memory_corrected', action: input.action },
  });
}

export interface UsefulnessRateOpts {
  /** Epoch-ms lower bound on created_at. Defaults to 0 (no lower bound). */
  sinceMs?: number;
  surface?: UsefulnessSurface;
}

export interface UsefulnessRate {
  served: number;
  used: number;
  /** used / served; null when served === 0 (avoids divide-by-zero / misleading 0%). */
  rate: number | null;
}

function surfaceFilter(opts: UsefulnessRateOpts, column: string): { clause: string; params: (string | number)[] } {
  if (!opts.surface) return { clause: '', params: [] };
  return { clause: `AND json_extract(${column}, '$.surface') = ?`, params: [opts.surface] };
}

/**
 * recall-usefulness rate = distinct atoms used / distinct atoms served, in
 * the given window (ADR-010's seed metric). Distinct-atom counting avoids
 * double-counting an atom served or used more than once in the window.
 */
export function usefulnessRate(db: DB, opts: UsefulnessRateOpts = {}): UsefulnessRate {
  const since = opts.sinceMs ?? 0;
  const { clause, params } = surfaceFilter(opts, 'payload_json');

  const served = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness'
      AND json_extract(payload_json, '$.family') = 'recall_served'
      AND created_at >= ?
      ${clause}
  `).get(since, ...params) as { n: number }).n;

  const used = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness'
      AND json_extract(payload_json, '$.family') = 'recall_used'
      AND created_at >= ?
      ${clause}
  `).get(since, ...params) as { n: number }).n;

  return { served, used, rate: served > 0 ? used / served : null };
}

export interface UsefulnessByType {
  type: string;
  served: number;
  used: number;
  rate: number | null;
}

/** Same metric, grouped by the served/used atom's current memories.type. */
export function usefulnessByType(db: DB, opts: UsefulnessRateOpts = {}): UsefulnessByType[] {
  const since = opts.sinceMs ?? 0;
  const { clause, params } = surfaceFilter(opts, 'e.payload_json');

  const servedRows = db.prepare(`
    SELECT m.type AS type, COUNT(DISTINCT e.atom_id) AS n
    FROM memory_events e
    JOIN memories m ON m.id = e.atom_id
    WHERE e.event_type = 'usefulness'
      AND json_extract(e.payload_json, '$.family') = 'recall_served'
      AND e.created_at >= ?
      ${clause}
    GROUP BY m.type
  `).all(since, ...params) as Array<{ type: string; n: number }>;

  const usedRows = db.prepare(`
    SELECT m.type AS type, COUNT(DISTINCT e.atom_id) AS n
    FROM memory_events e
    JOIN memories m ON m.id = e.atom_id
    WHERE e.event_type = 'usefulness'
      AND json_extract(e.payload_json, '$.family') = 'recall_used'
      AND e.created_at >= ?
      ${clause}
    GROUP BY m.type
  `).all(since, ...params) as Array<{ type: string; n: number }>;

  const servedMap = new Map(servedRows.map(r => [r.type, r.n]));
  const usedMap = new Map(usedRows.map(r => [r.type, r.n]));
  const types = Array.from(new Set([...servedMap.keys(), ...usedMap.keys()])).sort();

  return types.map(type => {
    const served = servedMap.get(type) ?? 0;
    const used = usedMap.get(type) ?? 0;
    return { type, served, used, rate: served > 0 ? used / served : null };
  });
}
