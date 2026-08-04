/**
 * Memory-health score (FEAT-444) — read-only per-store health metrics shared
 * by three surfaces: the `doctor` CLI row, `GET /health`'s `memory_health`
 * detail block, and the `astramem-local memory health` CLI report. One
 * `MemoryHealthReport` shape, built here, consumed by all three — mirrors
 * how `SessionDigest` (this same directory, provenance.ts) is the one shape
 * shared between the HTTP digest route and the MCP `session_digest` tool.
 *
 * BINDING split from the 2026-07-08 design review (design-review artifact,
 * FEAT-444 section): `GET /health` regressed to an accidental O(N) full
 * scan once already this week (migration 019 fixed `usefulnessRate()`'s
 * unindexed `memory_events` scan) — this module must not repeat that
 * mistake on the same endpoint in the same week. So there are two tiers:
 *
 *  - `buildMemoryHealthCheap()` — O(1)/index-backed ONLY. Every query here
 *    rides an existing index (idx_memories_archival_candidates,
 *    idx_memory_events_usefulness_served/used from migration 019,
 *    idx_memory_events_correction_type from migration 020, idx_jobs_state
 *    from 001-init) — no new migration needed, no per-request full table
 *    scan, no similarity computation. This is the ONLY tier `/health` may
 *    use (AC-2).
 *  - `buildMemoryHealthFull()` — adds byType/byScope breakdowns and the
 *    staleness distribution, which have no covering index and are
 *    genuinely O(N) group-bys. Fine for `doctor` (AC-1) and the CLI report
 *    (AC-3) — both are operator-invoked, off the hot path, read-only.
 *
 * Deep metrics (near-duplicate estimate, junk heuristic, optional
 * LLM-judged sample) are CLI-only and live in memory-health-deep.ts — never
 * wired into `/health` or `doctor`'s default (non---deep) pass.
 *
 * Every function here is read-only: no INSERT/UPDATE/DELETE against
 * memories, memory_events, jobs, or consolidation_proposals (AC-1/AC-3).
 */

import type { DB } from '../../storage/db.js';
import { usefulnessRate } from '../../storage/usefulness.js';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface UsefulnessCoverage {
  /** Distinct active atoms that have ever been served (recall_served event). */
  served: number;
  /** Distinct active atoms that have ever been explicitly used (recall_used event). */
  used: number;
  /** served / activeCount — fraction of active atoms ever surfaced by a
   *  recall/search surface. null when activeCount === 0 (avoids a
   *  misleading 0%, same convention as usefulnessRate()). */
  coverageRate: number | null;
}

export interface CorrectionStats {
  /** Distinct atoms with an invalidate or supersede event, ever. */
  corrected: number;
  /** corrected / (activeCount + corrected) — approximates "share of
   *  ever-known atoms that got corrected". null when the denominator is 0. */
  rate: number | null;
}

export interface StalenessBucket {
  /** Human label, e.g. "0-7d". */
  label: string;
  /** Inclusive upper bound in days; null for the open-ended last bucket. */
  maxDays: number | null;
  count: number;
}

/** One row per (repo ?? '', type) group — mirrors consolidate.ts's own
 *  grouping key so the deep near-duplicate scan (memory-health-deep.ts)
 *  samples the exact same population consolidation would compare. */
export interface MemoryHealthCounts {
  active: number;
  archived: number;
  byType: Record<string, number>;
  byScope: Record<string, number>;
}

export interface MemoryHealthReport {
  generatedAt: number;
  /** Always present — index-backed (idx_memories_archival_candidates). */
  activeCount: number;
  archivedCount: number;
  /** null on the /health cheap subset; populated by buildMemoryHealthFull()
   *  for doctor/CLI (no covering index for a type/scope group-by — a
   *  genuine O(N) scan, acceptable off the /health hot path only). */
  counts: MemoryHealthCounts | null;
  staleness: StalenessBucket[] | null;
  /** Always present — rides migration 019's partial indexes. */
  usefulness: UsefulnessCoverage;
  /** Always present — rides migration 020's partial index. */
  corrections: CorrectionStats;
  /** Distinct sessions with at least one permanently-failed ('poison')
   *  distill job — index-backed via idx_jobs_state (state='poison' is the
   *  equality prefix; scoped further to kind='distill' in-query). Always
   *  present. */
  poisonDistillSessions: number;
}

// ---------------------------------------------------------------------------
// Cheap tier — index-backed only, safe for the /health hot path
// ---------------------------------------------------------------------------

/**
 * Active/archived counts via idx_memories_archival_candidates(archived,
 * valid_to, created_at) — archived is the index's leading column, so
 * `WHERE archived = 0/1 AND valid_to IS NULL/NOT NULL` (well, active is
 * archived=0 AND valid_to IS NULL; archived here just means archived=1) is
 * an index-only range scan bounded by the matching partition's row count,
 * never a scan of the whole memories table.
 */
function countActiveAndArchived(db: DB): { active: number; archived: number } {
  const active = (db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE archived = 0 AND valid_to IS NULL`,
  ).get() as { n: number }).n;
  const archived = (db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE archived = 1`,
  ).get() as { n: number }).n;
  return { active, archived };
}

/**
 * Usefulness coverage: distinct served/used atom counts (all-time).
 * Delegates to storage/usefulness.ts's usefulnessRate() rather than
 * re-implementing the same two queries — that function's `created_at >= ?`
 * predicate (sinceMs defaults to 0, i.e. all-time here) is exactly what
 * makes the query planner pick migration 019's partial covering indexes
 * (idx_memory_events_usefulness_served/used); a query without that
 * predicate falls back to a worse index (idx_memory_events_atom_seq), which
 * is why this reuses the verified helper instead of hand-rolling the SQL a
 * second time. See tests/storage/migrate.test.ts's own EXPLAIN QUERY PLAN
 * assertion against this exact query shape.
 */
function usefulnessCoverage(db: DB, activeCount: number): UsefulnessCoverage {
  const rate = usefulnessRate(db, {});
  return { served: rate.served, used: rate.used, coverageRate: activeCount > 0 ? rate.served / activeCount : null };
}

/**
 * Correction count via idx_memory_events_correction_type (migration 020):
 * (event_type, created_at DESC, atom_id) WHERE event_type IN ('invalidate',
 * 'supersede') — an index range scan bounded by the correction-event count,
 * not the full memory_events table.
 */
function correctionStats(db: DB, activeCount: number): CorrectionStats {
  const corrected = (db.prepare(`
    SELECT COUNT(DISTINCT atom_id) AS n
    FROM memory_events
    WHERE event_type IN ('invalidate', 'supersede')
  `).get() as { n: number }).n;

  const denom = activeCount + corrected;
  return { corrected, rate: denom > 0 ? corrected / denom : null };
}

/**
 * Distinct sessions with a permanently-failed distill job. Index-backed —
 * bounded by poison-job count, never a scan of the full jobs table.
 * Migration 060 (2026-08-02 poison-metric-window fix) added
 * idx_jobs_distill_terminal_window (state, updated_at) WHERE kind =
 * 'distill', which is a tighter match for this query's `state = 'poison'
 * AND kind = 'distill'` shape than the older idx_jobs_state (state,
 * created_at) — SQLite's planner now picks the newer partial index instead
 * (verified via EXPLAIN QUERY PLAN); either is index-backed, so this is a
 * plan-choice detail, not a behavior change.
 */
function poisonDistillSessionCount(db: DB): number {
  try {
    return (db.prepare(`
      SELECT COUNT(DISTINCT json_extract(payload_json, '$.session_id')) AS n
      FROM jobs
      WHERE state = 'poison' AND kind = 'distill'
    `).get() as { n: number }).n;
  } catch {
    return 0; // jobs table absent (bare test DB) — degrade, never throw.
  }
}

// ---------------------------------------------------------------------------
// Distill-session poison rate (ADR-015 rule 6/2, A2-lite) — doctor-only, NOT
// wired into buildMemoryHealthCheap()/`/health`'s cheap DB fields (see file
// header: the cheap tier is index-backed-only). It IS read by /health's
// separately-refreshed `distill_poison_rate` block (FEAT-538,
// src/server/routes/health.ts) on the same 30s off-request-path cadence as
// everything else there — see that file for how the two co-exist without
// putting a heavier query on the hot request path. checkMemoryHealth
// (src/doctor/checks/memory-health.ts) already calls buildMemoryHealthFull(),
// so this is a second read alongside that, not a replacement for it.
// ---------------------------------------------------------------------------

/**
 * Rolling window (days) `distillSessionStats()` counts terminal/poison
 * distill sessions over (2026-08-02 poison-metric-window fix). Deliberately
 * NOT the same denominator as `poisonDistillSessionCount()`/
 * `MemoryHealthReport.poisonDistillSessions` above, which stay a lifetime
 * count for informational display — a lifetime poison RATE can only ever
 * heal once the retention sweep eventually purges the offending rows
 * (POISON_JOB_RETENTION_DAYS, job-repo.ts — 90 days), leaving the
 * POISON_RATE_ALARM doctor/`/health` alarm stuck red for weeks after the
 * underlying cause has already cleared (e.g. a one-off metered-provider
 * quota burst). Windowing to the last 7 days makes the alarm answer "is
 * extraction healthy RIGHT NOW", which is what an operator actually wants
 * to know when this goes red. 7 days (not, say, 1) still gives
 * MEANINGFUL_USAGE_THRESHOLD (20 terminal sessions) a realistic chance to
 * accumulate on a normal-traffic install before the alarm can fire at all.
 */
export const DISTILL_POISON_RATE_WINDOW_DAYS = 7;

export interface DistillSessionStats {
  /** The rolling window (days) `terminal`/`poison`/`poisonRate` below were
   *  computed over — see DISTILL_POISON_RATE_WINDOW_DAYS. Echoed back so a
   *  consumer (doctor message, /health wire field) can state it without
   *  re-importing the constant. */
  windowDays: number;
  /** Distinct session_id values among distill jobs that reached a terminal
   *  state (completed or poison) within the last `windowDays` days (by
   *  `updated_at`, i.e. when the job actually transitioned, not when it was
   *  enqueued). Pending/running/retrying('failed') jobs are excluded — they
   *  have not concluded yet, so counting them would move the denominator
   *  under a still-running backlog rather than reflecting outcomes. */
  terminal: number;
  /** Distinct session_id values among distill jobs that transitioned to the
   *  'poison' state (permanently failed after exhausting retries,
   *  JobRepo.markPoison) within the same `windowDays`-day window. */
  poison: number;
  /** poison / terminal. null when terminal === 0 (nothing concluded yet in
   *  the window to judge a rate from — mirrors the null convention
   *  usefulnessRate() and correctionStats() above already use for an empty
   *  denominator). */
  poisonRate: number | null;
}

/**
 * The ADR-015 rule 6 "state the denominator" counter checkMemoryHealth was
 * missing — its only return path was `{ok: true}`; a 100% poison rate still
 * reported "memory health: OK" (see checks.ts's doc comment on
 * checkMemoryHealth). Both queries below ride idx_jobs_distill_terminal_window
 * (migration 060, partial `WHERE kind = 'distill'` indexed on (state,
 * updated_at)) — see that migration's comment for why neither pre-existing
 * jobs index (idx_jobs_state, idx_jobs_distill_session) covers this shape.
 * Degrades to a null rate rather than throwing on a bare/pre-migration test
 * DB (e.g. no `jobs` table at all).
 */
export function distillSessionStats(db: DB, opts: { windowDays?: number } = {}): DistillSessionStats {
  const windowDays = opts.windowDays ?? DISTILL_POISON_RATE_WINDOW_DAYS;
  try {
    const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const terminalRow = db.prepare(`
      SELECT COUNT(DISTINCT json_extract(payload_json, '$.session_id')) AS n
      FROM jobs
      WHERE kind = 'distill' AND state IN ('completed', 'poison') AND updated_at >= ?
    `).get(cutoffMs) as { n: number };
    const poisonRow = db.prepare(`
      SELECT COUNT(DISTINCT json_extract(payload_json, '$.session_id')) AS n
      FROM jobs
      WHERE kind = 'distill' AND state = 'poison' AND updated_at >= ?
    `).get(cutoffMs) as { n: number };
    const terminal = terminalRow.n;
    const poison = poisonRow.n;
    return { windowDays, terminal, poison, poisonRate: terminal > 0 ? poison / terminal : null };
  } catch {
    // jobs table absent (bare test DB) — degrade, never throw.
    return { windowDays, terminal: 0, poison: 0, poisonRate: null };
  }
}

/**
 * The ONLY builder `GET /health` (src/server/routes/health.ts) may call —
 * every query above is index-backed; none scans the full memories or
 * memory_events table. `counts`/`staleness` are null here by design (see
 * file header) — populate them via buildMemoryHealthFull() for doctor/CLI.
 */
export function buildMemoryHealthCheap(db: DB): MemoryHealthReport {
  const { active, archived } = countActiveAndArchived(db);
  return {
    generatedAt: Date.now(),
    activeCount: active,
    archivedCount: archived,
    counts: null,
    staleness: null,
    usefulness: usefulnessCoverage(db, active),
    corrections: correctionStats(db, active),
    poisonDistillSessions: poisonDistillSessionCount(db),
  };
}

// ---------------------------------------------------------------------------
// Full tier — adds O(N) group-bys, for doctor (AC-1) and the CLI (AC-3) only
// ---------------------------------------------------------------------------

const STALENESS_BUCKETS: Array<{ label: string; maxDays: number | null }> = [
  { label: '0-7d', maxDays: 7 },
  { label: '8-30d', maxDays: 30 },
  { label: '31-90d', maxDays: 90 },
  { label: '91-180d', maxDays: 180 },
  { label: '180d+', maxDays: null },
];

function bucketForAgeDays(ageDays: number): string {
  for (const b of STALENESS_BUCKETS) {
    if (b.maxDays === null || ageDays <= b.maxDays) return b.label;
  }
  return STALENESS_BUCKETS[STALENESS_BUCKETS.length - 1]!.label;
}

/** Age buckets over `valid_from` (falls back to `created_at` for legacy rows
 *  with no valid_from) for currently-active memories. Genuinely O(active
 *  count) — no covering index for a bucketed age distribution exists, so
 *  this is reserved for the full (doctor/CLI) tier, never /health. */
function stalenessDistribution(db: DB): StalenessBucket[] {
  const rows = db.prepare(`
    SELECT COALESCE(valid_from, created_at) AS ts
    FROM memories
    WHERE archived = 0 AND valid_to IS NULL
  `).all() as Array<{ ts: number }>;

  const counts = new Map<string, number>(STALENESS_BUCKETS.map(b => [b.label, 0]));
  const now = Date.now();
  for (const r of rows) {
    const ageDays = (now - r.ts) / (24 * 60 * 60 * 1000);
    const label = bucketForAgeDays(ageDays);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return STALENESS_BUCKETS.map(b => ({ label: b.label, maxDays: b.maxDays, count: counts.get(b.label) ?? 0 }));
}

/** type/scope breakdown, active memories only. O(N) group-by (no covering
 *  index) — reserved for the full (doctor/CLI) tier. */
function countsByTypeAndScope(db: DB): MemoryHealthCounts {
  const active = (db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE archived = 0 AND valid_to IS NULL`,
  ).get() as { n: number }).n;
  const archived = (db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE archived = 1`,
  ).get() as { n: number }).n;

  const byTypeRows = db.prepare(`
    SELECT type, COUNT(*) AS n FROM memories
    WHERE archived = 0 AND valid_to IS NULL
    GROUP BY type
  `).all() as Array<{ type: string; n: number }>;
  const byType: Record<string, number> = {};
  for (const r of byTypeRows) byType[r.type] = r.n;

  const byScopeRows = db.prepare(`
    SELECT scope, COUNT(*) AS n FROM memories
    WHERE archived = 0 AND valid_to IS NULL
    GROUP BY scope
  `).all() as Array<{ scope: string; n: number }>;
  const byScope: Record<string, number> = {};
  for (const r of byScopeRows) byScope[r.scope] = r.n;

  return { active, archived, byType, byScope };
}

/**
 * Full report: the cheap tier plus byType/byScope + staleness. Used by
 * `doctor` (AC-1) and `astramem-local memory health` (AC-3) — both
 * operator-invoked and off the /health hot path, so the extra O(N)
 * group-bys are acceptable here per the design review's recommendation.
 */
export function buildMemoryHealthFull(db: DB): MemoryHealthReport {
  const cheap = buildMemoryHealthCheap(db);
  return {
    ...cheap,
    counts: countsByTypeAndScope(db),
    staleness: stalenessDistribution(db),
  };
}
