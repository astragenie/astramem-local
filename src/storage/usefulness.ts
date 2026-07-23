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
import { safeJsonColumn } from './json-guard.js';

/** issue #190: 'system' covers background/pipeline-originated events (e.g.
 *  `runImplicitPositivePass`'s heuristic grants) — no live request surface
 *  serves those, so tagging them 'cli' (which means "the CLI tool" to every
 *  other reader of this field) would be misleading for observability. */
export type UsefulnessSurface = 'mcp' | 'rest' | 'cli' | 'system';
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
  /**
   * FEAT-477: free-form label distinguishing WHICH heuristic mechanism
   * produced a `signal:'heuristic'` grant — e.g. `runImplicitPositivePass`'s
   * own inline append uses `'no_correction_survival'`, and
   * `src/storage/proxy-turn-correlation.ts`'s independent SECOND heuristic
   * (ADR-010 v1.x) uses `PROXY_TURN_CORRELATION_BASIS`. Omitted for
   * `signal:'explicit'` (a human/API caller needs no mechanism label) and
   * for every pre-FEAT-477 caller — the payload shape is byte-identical to
   * before when this is left undefined.
   */
  basis?: string;
}

/** Append one 'usefulness'/'recall_used' event — the atom mattered. */
export function recordRecallUsed(db: DB, input: RecordRecallUsedInput): void {
  new MemoryEventRepo(db).append({
    event_type: 'usefulness',
    atom_id: input.atomId,
    payload: {
      family: 'recall_used',
      surface: input.surface,
      signal: input.signal,
      ...(input.basis !== undefined ? { basis: input.basis } : {}),
    },
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

/** Default weight applied to a `signal:'heuristic'` recall_used event inside
 *  {@link usefulnessScores}'s Laplace-smoothed sum, when the caller doesn't
 *  supply one explicitly. Mirrors `defaultConfig().search.usefulness.
 *  implicitPositive.weight` (src/config/config.ts) — kept here too so this
 *  module has no hard compile-time dependency on config.ts (avoids a
 *  storage->config import direction this codebase doesn't otherwise have),
 *  while still defaulting to the same value in practice. Real callers
 *  (src/search — wherever usefulnessScores feeds fusion) should thread the
 *  live `config.search.usefulness.implicitPositive.weight` through
 *  explicitly rather than rely on this fallback, per the design doc's "must
 *  NOT silently default inside SQL to avoid drift from the config value"
 *  requirement — this constant exists for callers/tests that have no config
 *  object in hand, not to let production drift from a hand-edited weight. */
export const DEFAULT_IMPLICIT_POSITIVE_WEIGHT = 0.35;

/**
 * Per-atom usefulness score for ranking (ADR-010 v1.x). Laplace-smoothed:
 * (used + 1) / (used + corrected + 2) — an atom with no signal scores a
 * neutral 0.5, one explicit recall_used lifts it to 0.67, one correction
 * drops it to 0.33. Every requested id gets an entry so callers never have
 * to special-case missing atoms.
 *
 * issue #190: `used` is now a WEIGHTED sum, not a raw count — an explicit
 * (`signal:'explicit'`) recall_used event counts as 1.0 exactly as before;
 * a heuristic (`signal:'heuristic'`, the `runImplicitPositivePass` grant)
 * counts as `implicitWeight` (default {@link DEFAULT_IMPLICIT_POSITIVE_WEIGHT},
 * 0.35) — deliberately less than the explicit path's full weight, per the
 * "weak positive" requirement. Every OTHER reader of the recall_used family
 * (usefulnessRate, perAtomUsefulnessRate7d, usefulnessByType,
 * feedbackLoopSummary) stays an unweighted existence/rate count — only this
 * ranking-facing function gets the weighted treatment (see
 * docs/specs/20260714-implicit-usefulness-signal-190.md).
 */
export function usefulnessScores(
  db: DB,
  atomIds: string[],
  implicitWeight: number = DEFAULT_IMPLICIT_POSITIVE_WEIGHT,
): Map<string, number> {
  const scores = new Map<string, number>(atomIds.map(id => [id, 0.5]));
  if (atomIds.length === 0) return scores;

  // Batch the IN() clause. One bound parameter per id overflows SQLite's
  // SQLITE_MAX_VARIABLE_NUMBER (default 999) the moment a consolidation run
  // passes the FULL valid-atom set — on a large corpus that is tens of
  // thousands of ids, which threw "too many SQL variables" and poisoned every
  // consolidate job (2026-07-15). Chunk well under the limit, leaving headroom
  // for the leading implicitWeight bound param.
  const BATCH_SIZE = 900;
  for (let start = 0; start < atomIds.length; start += BATCH_SIZE) {
    const batch = atomIds.slice(start, start + BATCH_SIZE);
    const ph = batch.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT atom_id,
        SUM(CASE
          WHEN json_extract(${safeJsonColumn('payload_json')},'$.family') = 'recall_used'
           AND json_extract(${safeJsonColumn('payload_json')},'$.signal') = 'heuristic' THEN ?
          WHEN json_extract(${safeJsonColumn('payload_json')},'$.family') = 'recall_used' THEN 1.0
          ELSE 0 END) AS used,
        SUM(CASE WHEN json_extract(${safeJsonColumn('payload_json')},'$.family') = 'memory_corrected' THEN 1 ELSE 0 END) AS corrected
      FROM memory_events
      WHERE event_type = 'usefulness' AND atom_id IN (${ph})
      GROUP BY atom_id
    `).all(implicitWeight, ...batch) as Array<{ atom_id: string; used: number; corrected: number }>;

    for (const r of rows) {
      scores.set(r.atom_id, (r.used + 1) / (r.used + r.corrected + 2));
    }
  }
  return scores;
}

export interface ImplicitPositiveOpts {
  /** Trailing lookback, in days, for distinct-query-hash counting. */
  windowDays: number;
  /** Minimum DISTINCT recall_served.query_hash values required in the
   *  window to qualify (anti-pathology safeguard 2: distinct-query
   *  corroboration, not repeat-serve count). */
  minDistinctQueries: number;
  /** Batch cap per sweep — mirrors the contradiction-detection maxPerRun
   *  precedent (FEAT-482 incident): a bounded background pass. */
  maxGrantsPerRun: number;
}

export interface ImplicitPositiveResult {
  /** Atoms that cleared the distinct-query threshold and had no prior
   *  disqualifying correction/grant — i.e. rows the qualifying query
   *  returned, before the maxGrantsPerRun cap. */
  candidates: number;
  /** Atoms that actually received a new heuristic recall_used event this
   *  pass (== candidates, capped at maxGrantsPerRun). */
  granted: number;
}

/**
 * issue #190: "cross-query survival" implicit positive-usefulness sweep.
 * Runs on the cleanup-job cadence (src/pipeline/handlers/cleanup.ts),
 * time-decoupled from any single request (anti-pathology safeguard 3) — see
 * docs/specs/20260714-implicit-usefulness-signal-190.md for the full
 * argument. For every atom with at least `minDistinctQueries` distinct
 * `recall_served.query_hash` values in the trailing `windowDays` window,
 * ZERO `memory_corrected` events ever (any time, not just in-window), and
 * no prior heuristic grant (ever — safeguard 1: once-per-atom, forever),
 * appends exactly one `recall_used`/`signal:'heuristic'` event.
 *
 * Single transaction, capped by `maxGrantsPerRun`. Callers gate this behind
 * `config.search.usefulness.implicitPositive.enabled` (default false) — this
 * function itself has no config dependency and always runs when called,
 * mirroring `runArchivalPass`'s own enabled-check-lives-at-the-call-site
 * shape... except archival checks `enabled` internally; here the check lives
 * in the pipeline handler instead, so this function stays trivially testable
 * without needing a full Config object.
 */
export function runImplicitPositivePass(db: DB, opts: ImplicitPositiveOpts, now: number = Date.now()): ImplicitPositiveResult {
  const windowStartMs = now - opts.windowDays * 24 * 60 * 60 * 1000;
  const payload = safeJsonColumn('payload_json');

  const rows = db.prepare(`
    SELECT atom_id
    FROM memory_events
    WHERE event_type = 'usefulness'
      AND json_extract(${payload},'$.family') = 'recall_served'
      AND created_at >= ?
    GROUP BY atom_id
    HAVING COUNT(DISTINCT json_extract(${payload},'$.query_hash')) >= ?
      AND atom_id NOT IN (
        SELECT atom_id FROM memory_events
        WHERE event_type = 'usefulness' AND json_extract(${payload},'$.family') = 'memory_corrected'
      )
      AND atom_id NOT IN (
        SELECT atom_id FROM memory_events
        WHERE event_type = 'usefulness' AND json_extract(${payload},'$.family') = 'recall_used'
          AND json_extract(${payload},'$.signal') = 'heuristic'
      )
    LIMIT ?
  `).all(windowStartMs, opts.minDistinctQueries, opts.maxGrantsPerRun) as Array<{ atom_id: string }>;

  if (rows.length === 0) return { candidates: 0, granted: 0 };

  const events = new MemoryEventRepo(db);
  const tx = db.transaction(() => {
    for (const row of rows) {
      events.append({
        event_type: 'usefulness',
        atom_id: row.atom_id,
        payload: {
          family: 'recall_used',
          surface: 'system',
          signal: 'heuristic',
          basis: 'no_correction_survival',
        },
        created_at: now,
      });
    }
  });
  tx();

  return { candidates: rows.length, granted: rows.length };
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
  return { clause: `AND json_extract(${safeJsonColumn(column)}, '$.surface') = ?`, params: [opts.surface] };
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
      AND json_extract(${safeJsonColumn('payload_json')},'$.family') = 'recall_served'
      AND created_at >= ?
      ${clause}
  `).get(since, ...params) as { n: number }).n;

  const used = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness'
      AND json_extract(${safeJsonColumn('payload_json')},'$.family') = 'recall_used'
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
      SUM(CASE WHEN json_extract(${safeJsonColumn('payload_json')},'$.family') = 'recall_served' THEN 1 ELSE 0 END) AS served,
      SUM(CASE WHEN json_extract(${safeJsonColumn('payload_json')},'$.family') = 'recall_used' THEN 1 ELSE 0 END) AS used
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
  /** issue #190: distinct atoms with at least one recall_used event tagged
   *  `signal: 'explicit'` — a real client called submit_feedback/
   *  mark_memory_used/POST /memory/:id/used. Unlike the corrected split
   *  below, `signal` has been a required field on every recall_used event
   *  since ADR-010 v1 shipped, so there is no "unknown/pre-fix" bucket here. */
  usedExplicitDistinct: number;
  /** issue #190: distinct atoms with at least one recall_used event tagged
   *  `signal: 'heuristic'` — granted by `runImplicitPositivePass`, not a
   *  real client action. Not necessarily disjoint from usedExplicitDistinct:
   *  an atom can carry both an explicit AND a heuristic grant over its
   *  lifetime. */
  usedHeuristicDistinct: number;
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
    WHERE event_type = 'usefulness' AND json_extract(${safeJsonColumn('payload_json')},'$.family') = 'recall_served'
  `).get() as { n: number }).n;

  const usedDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(${safeJsonColumn('payload_json')},'$.family') = 'recall_used'
  `).get() as { n: number }).n;

  // issue #190 phase 5: split used by signal, same unindexed-scan tradeoff
  // as the corrected split below — small volume relative to served.
  const usedExplicitDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(${safeJsonColumn('payload_json')},'$.family') = 'recall_used'
      AND json_extract(${safeJsonColumn('payload_json')},'$.signal') = 'explicit'
  `).get() as { n: number }).n;

  const usedHeuristicDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(${safeJsonColumn('payload_json')},'$.family') = 'recall_used'
      AND json_extract(${safeJsonColumn('payload_json')},'$.signal') = 'heuristic'
  `).get() as { n: number }).n;

  const correctedDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(${safeJsonColumn('payload_json')},'$.family') = 'memory_corrected'
  `).get() as { n: number }).n;

  // issue #190 AC-2: same unindexed-scan tradeoff as correctedDistinct above
  // (no partial index covers memory_corrected — see this function's doc
  // comment) — three more predicates on the same small-volume event family,
  // not a new full-table scan.
  const correctedConsolidationDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(${safeJsonColumn('payload_json')},'$.family') = 'memory_corrected'
      AND json_extract(${safeJsonColumn('payload_json')},'$.source') = 'consolidation_auto'
  `).get() as { n: number }).n;

  const correctedExternalDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(${safeJsonColumn('payload_json')},'$.family') = 'memory_corrected'
      AND json_extract(${safeJsonColumn('payload_json')},'$.source') = 'external'
  `).get() as { n: number }).n;

  const correctedUnknownDistinct = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type = 'usefulness' AND json_extract(${safeJsonColumn('payload_json')},'$.family') = 'memory_corrected'
      AND json_extract(${safeJsonColumn('payload_json')},'$.source') IS NULL
      AND atom_id NOT IN (
        SELECT atom_id FROM memory_events
        WHERE event_type = 'usefulness' AND json_extract(${safeJsonColumn('payload_json')},'$.family') = 'memory_corrected'
          AND json_extract(${safeJsonColumn('payload_json')},'$.source') IS NOT NULL
      )
  `).get() as { n: number }).n;

  return {
    servedDistinct, usedDistinct, usedExplicitDistinct, usedHeuristicDistinct, correctedDistinct,
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
      AND json_extract(${safeJsonColumn('e.payload_json')},'$.family') = 'recall_served'
      AND e.created_at >= ?
      ${clause}
    GROUP BY m.type
  `).all(since, ...params) as Array<{ type: string; n: number }>;

  const usedRows = db.prepare(`
    SELECT m.type AS type, COUNT(DISTINCT e.atom_id) AS n
    FROM memory_events e
    JOIN memories m ON m.id = e.atom_id
    WHERE e.event_type = 'usefulness'
      AND json_extract(${safeJsonColumn('e.payload_json')},'$.family') = 'recall_used'
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

export interface PruneRecallServedResult {
  /** Rows deleted this pass. */
  pruned: number;
}

/**
 * Retention sweep for the 'usefulness'/'recall_served' event subset ONLY
 * (Wave-3 storage+perf track — real bug: this family is appended once PER
 * SERVED ATOM PER SEARCH, k=15 -> 15 rows/query via {@link recordRecallServed},
 * making it by far the highest-volume writer onto memory_events, and unlike
 * every other event_type nothing has ever pruned it).
 *
 * `memory_events` doubles as the sync queue (src/sync/shipper.ts: "the log
 * IS the queue" — unsynced rows are `synced_at IS NULL`), so an unqualified
 * age-based delete risks eating a row the shipper hasn't shipped yet.
 * HARD INVARIANT, exactly as specified for this track (see the memory_events
 * retention handoff): a row is only ever deleted when ALL of —
 *   - `event_type = 'usefulness'` (never create/invalidate/supersede/
 *     promote_scope/erase_request — those event_types are excluded by this
 *     predicate alone, not by an extra guard)
 *   - `payload_json.family = 'recall_served'` (never `recall_used` or
 *     `memory_corrected` — those lower-volume families feed
 *     {@link usefulnessScores}'s all-time ranking signal and
 *     {@link feedbackLoopSummary}'s all-time canary; `recall_served` rows
 *     feed neither)
 *   - `synced_at IS NOT NULL` (already shipped — never a row the shipper
 *     might still need)
 *   - `created_at < now - retentionDays`
 *
 * KNOWN GAP, deliberately not widened here: `synced_at` is only ever set for
 * a team/org-scoped atom's events (ADR-009 — see shipper.ts's
 * `listUnsynced`). A `private`-scoped atom's recall_served rows — the common
 * case for a single-device install that has never paired sync — never ship,
 * so `synced_at` stays NULL on them forever and this sweep prunes none of
 * them. Widening the predicate to also cover never-shippable private-scope
 * rows would close that gap but changes the safety argument this sweep was
 * reviewed against (no shipper race to reason about, but a bigger diff to
 * the one invariant it exists to keep) — flagged as a follow-up, not done
 * unilaterally.
 */
export function pruneOldRecallServedEvents(
  db: DB,
  retentionDays: number,
  now: number = Date.now(),
): PruneRecallServedResult {
  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  const result = db.prepare(`
    DELETE FROM memory_events
    WHERE event_type = 'usefulness'
      AND json_extract(${safeJsonColumn('payload_json')},'$.family') = 'recall_served'
      AND synced_at IS NOT NULL
      AND created_at < ?
  `).run(cutoffMs);
  return { pruned: result.changes };
}
