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
import { MemoryEventRepo, type CorrectionSource } from './memory-events.js';

export type UsefulnessSurface = 'mcp' | 'rest' | 'cli';
export type UsefulnessSignal = 'explicit' | 'heuristic';
export type CorrectionAction = 'invalidated' | 'superseded' | 'demoted' | 'edited';
export type { CorrectionSource };

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
  /** issue #190: who decided this correction — defaults to 'external' (a
   *  future demote/edit flow is, like invalidate(), assumed human/API-driven
   *  unless the caller says otherwise). See {@link CorrectionSource}. */
  source?: CorrectionSource;
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
    payload: { family: 'memory_corrected', action: input.action, source: input.source ?? 'external' },
  });
}

/**
 * Per-atom usefulness score for ranking (ADR-010 v1.x). Laplace-smoothed:
 * (used + 1) / (used + corrected + 2) — an atom with no signal scores a
 * neutral 0.5, one explicit recall_used lifts it to 0.67, one correction
 * drops it to 0.33. Every requested id gets an entry so callers never have
 * to special-case missing atoms.
 */
export function usefulnessScores(db: DB, atomIds: string[]): Map<string, number> {
  const scores = new Map<string, number>(atomIds.map(id => [id, 0.5]));
  if (atomIds.length === 0) return scores;

  const ph = atomIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT atom_id,
      SUM(CASE WHEN json_extract(payload_json, '$.family') = 'recall_used' THEN 1 ELSE 0 END) AS used,
      SUM(CASE WHEN json_extract(payload_json, '$.family') = 'memory_corrected' THEN 1 ELSE 0 END) AS corrected
    FROM memory_events
    WHERE event_type = 'usefulness' AND atom_id IN (${ph})
    GROUP BY atom_id
  `).all(...atomIds) as Array<{ atom_id: string; used: number; corrected: number }>;

  for (const r of rows) {
    scores.set(r.atom_id, (r.used + 1) / (r.used + r.corrected + 2));
  }
  return scores;
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

/**
 * Per-atom usefulness rate over a trailing window, for archival eligibility
 * (FEAT-404 AC-2/AC-3 — "rate_7d"). Deliberately distinct from
 * usefulnessRate() above: that DB-wide health-dashboard metric returns
 * `rate: null` when served === 0 to avoid a misleading 0% on the /health
 * surface. Archival eligibility instead needs one comparable number per
 * atom, and "zero recall_served events in the window" is itself evidence
 * the atom isn't earning its keep — so it maps to rate 0 here, not null,
 * making an unsignaled atom exactly as archival-eligible as one with 0%
 * explicit usage. Every requested id gets an entry (default 0) so callers
 * never special-case a missing atom.
 */
export function perAtomUsefulnessRate7d(db: DB, atomIds: string[], sinceMs: number): Map<string, number> {
  const rates = new Map<string, number>(atomIds.map(id => [id, 0]));
  if (atomIds.length === 0) return rates;

  const ph = atomIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT atom_id,
      SUM(CASE WHEN json_extract(payload_json, '$.family') = 'recall_served' THEN 1 ELSE 0 END) AS served,
      SUM(CASE WHEN json_extract(payload_json, '$.family') = 'recall_used' THEN 1 ELSE 0 END) AS used
    FROM memory_events
    WHERE event_type = 'usefulness' AND atom_id IN (${ph}) AND created_at >= ?
    GROUP BY atom_id
  `).all(...atomIds, sinceMs) as Array<{ atom_id: string; served: number; used: number }>;

  for (const r of rows) {
    rates.set(r.atom_id, r.served > 0 ? r.used / r.served : 0);
  }
  return rates;
}

export interface FeedbackLoopSummary {
  servedDistinct: number;
  usedDistinct: number;
  correctedDistinct: number;
  /**
   * issue #190 AC-2: distinct atoms with at least one memory_corrected event
   * tagged `source: 'consolidation_auto'` — the system deduplicating itself,
   * with no human/API decision in the loop (see {@link CorrectionSource}).
   * Not necessarily <= correctedDistinct - correctedExternalDistinct: an atom
   * can carry corrections from BOTH sources over its lifetime and would count
   * in both buckets. Events written before this field existed have no
   * `source` key and count in NEITHER bucket (see correctedUnknownDistinct).
   */
  correctedConsolidationDistinct: number;
  /** Distinct atoms with at least one memory_corrected event explicitly
   *  tagged `source: 'external'` — a human or direct API/MCP caller decided. */
  correctedExternalDistinct: number;
  /** Distinct atoms whose ONLY memory_corrected event(s) predate this field
   *  (no `source` key at all) — cannot be classified either way. Nonzero here
   *  on an existing install is expected and not a bug: it's pre-fix history. */
  correctedUnknownDistinct: number;
}

/**
 * All-time (no sinceMs window) distinct-atom summary across all three
 * usefulness event families. Feeds the doctor "Usefulness feedback loop"
 * canary (src/doctor/checks.ts), which detects the 2026-07-12 production
 * bug class: the mechanism (submit_feedback/mark_memory_used,
 * invalidate_memory/supersede_memory's memory_corrected append,
 * usefulnessScores() itself) is sound, but nothing in real usage ever calls
 * it, leaving every atom pinned at the Laplace prior 0.5 forever. Distinct
 * from usefulnessRate()/usefulnessByType() above, which window to a recency
 * period for the day-to-day dashboard rate — "has this EVER fired, even
 * once" is a different question than "what's this week's rate".
 *
 * issue #190 follow-up: `correctedDistinct` alone is NOT evidence the loop is
 * alive — the 2026-07-13 finding was that all 854 live corrections came from
 * consolidate.ts's own auto-merge, self-referentially, with zero positive
 * signal ever recorded. The three `correctedXDistinct` fields below split
 * that count by who decided (see `CorrectionSource`); doctor's canary now
 * gates purely on `usedDistinct`, never on `correctedDistinct` alone.
 *
 * Split into three-plus per-family queries (not one combined CASE/SELECT) so
 * served/used each ride the migration 019/021/025 partial indexes
 * (idx_memory_events_usefulness_served/used) exactly like usefulnessRate()
 * above — filtering `family` inside a SELECT-list CASE instead of the WHERE
 * clause was the mistake: no index covers a bare `event_type = 'usefulness'`
 * predicate, so that shape forces a full `SCAN memory_events` (every event
 * of every type ever logged), reintroducing the exact perf cliff (21ms ->
 * 1179ms p50, 1k -> 100k rows) migration 019 fixed for usefulnessRate(). No
 * partial index covers `memory_corrected` (only served/used got one in
 * 019/021/025) — that query still scans, but correction volume is far below
 * recall-served volume and this is unbounded/all-time already (see doctor's
 * canary), so it's accepted unindexed rather than adding a migration for it.
 */
export function feedbackLoopSummary(db: DB): FeedbackLoopSummary {
  const servedDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'recall_served'
  `).get() as { n: number }).n;

  const usedDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'recall_used'
  `).get() as { n: number }).n;

  const correctedDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'memory_corrected'
  `).get() as { n: number }).n;

  // issue #190 AC-2: same unindexed-scan tradeoff as correctedDistinct above
  // (no partial index covers memory_corrected — see this function's doc
  // comment) — three more predicates on the same small-volume event family,
  // not a new full-table scan.
  const correctedConsolidationDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'memory_corrected'
      AND json_extract(payload_json, '$.source') = 'consolidation_auto'
  `).get() as { n: number }).n;

  const correctedExternalDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'memory_corrected'
      AND json_extract(payload_json, '$.source') = 'external'
  `).get() as { n: number }).n;

  const correctedUnknownDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'memory_corrected'
      AND json_extract(payload_json, '$.source') IS NULL
      AND atom_id NOT IN (
        SELECT atom_id FROM memory_events
        WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'memory_corrected'
          AND json_extract(payload_json, '$.source') IS NOT NULL
      )
  `).get() as { n: number }).n;

  return {
    servedDistinct, usedDistinct, correctedDistinct,
    correctedConsolidationDistinct, correctedExternalDistinct, correctedUnknownDistinct,
  };
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
