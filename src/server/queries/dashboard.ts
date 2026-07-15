/**
 * Read-only queries powering the /dashboard HTML endpoint.
 * Extracted here so tests can exercise them independently of the route layer.
 */

import { statfsSync } from 'node:fs';
import type { DB } from '../../storage/db.js';
import { usefulnessRate, type UsefulnessRate } from '../../storage/usefulness.js';
import { ProposalRepo } from '../../consolidate/proposals.js';
import type { HealthState } from '../health-state.js';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface MemoryCountByType {
  type: string;
  count: number;
}

export interface RecentMemory {
  id: string;
  type: string;
  text: string;
  importance: number;
  confidence: number;
  session_id: string | null;
  created_at: number;
  /** `memories.project` — nullable, rendered as '—' when absent. */
  project: string | null;
  /** Best-effort extraction-profile provenance — see
   *  `queryExtractProfilesBySession`'s doc comment for exactly what this is
   *  (and is not) derived from. `null` when session_id is null, no
   *  transcript row exists for that session, or the envelope never set
   *  extract_profile. */
  profile: string | null;
}

export interface JobStateCount {
  state: string;
  count: number;
}

/** FEAT-410: job counts grouped by (kind, state) — distinguishes e.g.
 *  distill:poison=2 from reembed:poison=1, which the state-only
 *  `queryJobStates` cannot. */
export interface JobStateByKind {
  kind: string;
  state: string;
  count: number;
}

/** FEAT-410: pending consolidation-proposal count + oldest created_at. */
export interface ConsolidationSummary {
  count: number;
  oldest: number | null;
}

/** FEAT-410: a failed/poison job row with its error text, for the
 *  "what failed and why" surface. */
export interface RecentFailedJob {
  id: string;
  kind: string;
  state: string;
  last_error: string | null;
  updated_at: number;
}

/** FEAT-410: entity-linking pipeline-stage visibility. */
export interface EntityLinkage {
  entityCount: number;
  unlinkedMemoryCount: number;
}

/** FEAT-410: subsystem health rolled up from the boot-time HealthState —
 *  reuses the same instance /health reads instead of recomputing anything. */
export interface DashboardHealth {
  status: ReturnType<HealthState['status']>;
  uptimeSeconds: number;
  embed: {
    ok: boolean | null;
    lastOkAt: number | null;
    lastError: string | null;
    attempts: number;
  };
  worker: {
    alive: boolean;
    lastTickAt: number | null;
    lastTickAgoMs: number | null;
  };
  diskFreeBytes: number | null;
}

export interface HourlyThroughput {
  hour: string;
  count: number;
}

export interface BudgetSpendRow {
  day: string;
  usd_total: number;
  calls: number;
}

export interface DashboardData {
  memoryCounts: MemoryCountByType[];
  recentMemories: RecentMemory[];
  jobStates: JobStateCount[];
  jobStatesByKind: JobStateByKind[];
  hourlyThroughput: HourlyThroughput[];
  todaySpend: BudgetSpendRow | null;
  mtdSpend: number;
  mtdCalls: number;
  usefulness: UsefulnessRate;
  consolidation: ConsolidationSummary;
  recentFailedJobs: RecentFailedJob[];
  entityLinkage: EntityLinkage;
  /** null when no HealthState was wired in (e.g. bare test apps) — callers
   *  degrade the same way /health does when this field is absent. */
  health: DashboardHealth | null;
  /** project/profile filters actually applied to `recentMemories` this
   *  render — echoed back so the renderer can mark the active `<select>`
   *  option and preserve the filter across pagination links. */
  memoryFilters: MemoryListFilters;
  /** Distinct values available to filter on, for populating the `<select>`
   *  dropdowns — independent of `recentMemories`' own LIMIT 25 window so an
   *  option doesn't disappear just because its rows fell off the recent
   *  window. */
  filterOptions: { projects: string[]; profiles: string[] };
}

/**
 * project/profile filter state for the recent-memories listing.
 * `undefined` = no filter on that dimension (matches everything).
 * `null` = the '—'/"none" filter option — match rows where the value is
 * NULL/undeterminable (no `memories.project`, or no derivable profile).
 * A `string` = exact match on that value.
 */
export interface MemoryListFilters {
  project?: string | null;
  profile?: string | null;
}

/** Query-param sentinel for "match NULL/undeterminable rows" — the '—'
 *  option in the filter `<select>` elements. Case-insensitive on the way in. */
export const NONE_FILTER_VALUE = 'none';

/** Parses one raw `?project=`/`?profile=` query value into a MemoryListFilters
 *  field: missing/blank -> `undefined` (no filter), the `NONE_FILTER_VALUE`
 *  sentinel -> `null` (match NULL rows), anything else -> the trimmed literal
 *  value to match exactly. */
export function parseMemoryFilterParam(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.toLowerCase() === NONE_FILTER_VALUE) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Query implementations
// ---------------------------------------------------------------------------

export function queryMemoryCounts(db: DB): MemoryCountByType[] {
  return db.prepare<[], MemoryCountByType>(
    'SELECT type, COUNT(*) as count FROM memories GROUP BY type ORDER BY 2 DESC',
  ).all() as MemoryCountByType[];
}

/**
 * Best-effort extraction-profile provenance for a batch of memory
 * session_ids (dashboard "profile" column). `memories` carries no profile
 * column of its own — FEAT-479 (D3 §3.2) put the per-ingest override on
 * `transcripts.extract_profile`, one level up — and the pipeline's actually
 * *resolved* profile (`env override > transcripts.extract_profile > config
 * default > 'engineering'`, see `resolvedExtractProfile` in
 * src/distill/pipeline.ts) is never persisted anywhere queryable; it only
 * reaches a pino log line. This derives the closest available proxy: the
 * `extract_profile` column of the MOST RECENT transcript row in the
 * memory's own session (ties broken by `ingested_at DESC`) — exact whenever
 * a session ingests once, or ingests repeatedly with a stable per-session
 * extract_profile (the common case), and can silently disagree with the
 * true resolved value only when (a) a session's transcripts genuinely used
 * different extract_profile envelope values across ingests, or (b) an env
 * override was active at distill time. Both are edge cases, not the default
 * path — treat this as "recorded provenance", not "guaranteed resolved
 * value".
 *
 * One batched IN-clause query regardless of caller row count — never N+1.
 */
export function queryExtractProfilesBySession(db: DB, sessionIds: Array<string | null>): Map<string, string | null> {
  const distinct = [...new Set(sessionIds.filter((s): s is string => s !== null))];
  const result = new Map<string, string | null>();
  if (distinct.length === 0) return result;

  const placeholders = distinct.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT session_id, extract_profile
    FROM transcripts
    WHERE session_id IN (${placeholders})
    ORDER BY ingested_at DESC
  `).all(...distinct) as Array<{ session_id: string; extract_profile: string | null }>;

  for (const row of rows) {
    if (!result.has(row.session_id)) result.set(row.session_id, row.extract_profile);
  }
  return result;
}

/**
 * Recent memories for the dashboard activity feed, optionally filtered by
 * project (real `memories.project` column) and/or profile (the same
 * derived-from-transcripts value `queryExtractProfilesBySession` computes,
 * pushed into a correlated subquery here so filtering doesn't require
 * fetching every memory and filtering in JS — this route only ever wants
 * the top 25 MATCHING rows, and filtering after a LIMIT would silently
 * under-fetch).
 */
export function queryRecentMemories(db: DB, filters: MemoryListFilters = {}): RecentMemory[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.project !== undefined) {
    if (filters.project === null) {
      conditions.push('project IS NULL');
    } else {
      conditions.push('project = ?');
      params.push(filters.project);
    }
  }

  if (filters.profile !== undefined) {
    if (filters.profile === null) {
      conditions.push(`(
        session_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.session_id = memories.session_id)
        OR (SELECT t.extract_profile FROM transcripts t WHERE t.session_id = memories.session_id ORDER BY t.ingested_at DESC LIMIT 1) IS NULL
      )`);
    } else {
      conditions.push(`(
        SELECT t.extract_profile FROM transcripts t
        WHERE t.session_id = memories.session_id
        ORDER BY t.ingested_at DESC LIMIT 1
      ) = ?`);
      params.push(filters.profile);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT id, type, text, importance, confidence, session_id, created_at, project
    FROM memories
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT 25
  `).all(...params) as Array<Omit<RecentMemory, 'profile'>>;

  const profileBySession = queryExtractProfilesBySession(db, rows.map(r => r.session_id));
  return rows.map(r => ({
    ...r,
    profile: r.session_id !== null ? profileBySession.get(r.session_id) ?? null : null,
  }));
}

/** Distinct `memories.project` values, for populating the filter `<select>`.
 *  Independent of the LIMIT 25 recent-memories window. */
export function queryProjectOptions(db: DB): string[] {
  const rows = db.prepare(
    'SELECT DISTINCT project FROM memories WHERE project IS NOT NULL ORDER BY project',
  ).all() as Array<{ project: string }>;
  return rows.map(r => r.project);
}

/** Distinct `transcripts.extract_profile` values, for populating the filter
 *  `<select>`. Same caveat as `queryExtractProfilesBySession`: this is the
 *  raw per-ingest envelope value, not necessarily every value the pipeline
 *  ever resolved to. */
export function queryProfileOptions(db: DB): string[] {
  const rows = db.prepare(
    'SELECT DISTINCT extract_profile FROM transcripts WHERE extract_profile IS NOT NULL ORDER BY extract_profile',
  ).all() as Array<{ extract_profile: string }>;
  return rows.map(r => r.extract_profile);
}

export function queryJobStates(db: DB): JobStateCount[] {
  return db.prepare<[], JobStateCount>(
    'SELECT state, COUNT(*) as count FROM jobs GROUP BY state',
  ).all() as JobStateCount[];
}

/** FEAT-410 AC-1: job counts grouped by kind AND state. */
export function queryJobStatesByKind(db: DB): JobStateByKind[] {
  return db.prepare<[], JobStateByKind>(
    'SELECT kind, state, COUNT(*) as count FROM jobs GROUP BY kind, state',
  ).all() as JobStateByKind[];
}

/** FEAT-410 AC-3/AC-4: pending proposal count + oldest created_at (via the
 *  existing ProposalRepo — no new table scan). Never throws on an empty
 *  queue; ProposalRepo.list('pending') already orders by created_at ASC so
 *  the first row is the oldest. */
export function queryConsolidationSummary(db: DB): ConsolidationSummary {
  const pending = new ProposalRepo(db).list('pending');
  if (pending.length === 0) return { count: 0, oldest: null };
  return { count: pending.length, oldest: pending[0]!.created_at };
}

/** FEAT-410 AC-5: most recent failed/poison jobs with their error text,
 *  newest-updated first. */
export function queryRecentFailedJobs(db: DB, limit = 10): RecentFailedJob[] {
  return db.prepare<[number], RecentFailedJob>(`
    SELECT id, kind, state, last_error, updated_at
    FROM jobs
    WHERE state IN ('failed', 'poison')
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as RecentFailedJob[];
}

/** FEAT-410: entity count + unlinked-memory count (currently-valid,
 *  not-archived memories with no memory_entities row) for the entity-link
 *  pipeline stage. Same "currently valid" predicate used by archival.ts. */
export function queryEntityLinkage(db: DB): EntityLinkage {
  const entityCount = (db.prepare(
    'SELECT COUNT(*) as n FROM entities',
  ).get() as { n: number }).n;

  const unlinkedMemoryCount = (db.prepare(`
    SELECT COUNT(*) as n
    FROM memories m
    WHERE valid_to IS NULL AND archived = 0
      AND NOT EXISTS (SELECT 1 FROM memory_entities me WHERE me.memory_id = m.id)
  `).get() as { n: number }).n;

  return { entityCount, unlinkedMemoryCount };
}

/** Generous liveness window: the worker stamps lastTickAt at tick START, so
 *  a single long-running job (LLM distill can take up to the 60s chat
 *  timeout) must not read as "worker dead". Mirrors health.ts's own
 *  WORKER_ALIVE_WINDOW_MS — duplicated locally by design (same precedent as
 *  the stub pages' local auth check) to avoid a routes/health.ts <->
 *  queries/dashboard.ts import cycle. */
const WORKER_ALIVE_WINDOW_MS = 90_000;

function diskFreeBytes(dataDir: string): number | null {
  try {
    const s = statfsSync(dataDir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/** FEAT-410: merge the boot-time HealthState (built for /health) into
 *  DashboardData instead of recomputing subsystem health from scratch. */
export function buildDashboardHealth(healthState: HealthState): DashboardHealth {
  const lastTick = healthState.worker.lastTickAt;
  return {
    status: healthState.status(),
    uptimeSeconds: healthState.uptimeSeconds(),
    embed: { ...healthState.embed },
    worker: {
      alive: lastTick !== null && Date.now() - lastTick < WORKER_ALIVE_WINDOW_MS,
      lastTickAt: lastTick,
      lastTickAgoMs: lastTick === null ? null : Date.now() - lastTick,
    },
    diskFreeBytes: healthState.dataDir ? diskFreeBytes(healthState.dataDir) : null,
  };
}

export function queryHourlyThroughput(db: DB): HourlyThroughput[] {
  const since24hMs = Date.now() - 24 * 60 * 60 * 1000;
  return db.prepare<[number], HourlyThroughput>(`
    SELECT
      strftime('%Y-%m-%d %H', datetime(created_at / 1000, 'unixepoch')) AS hour,
      COUNT(*) AS count
    FROM memories
    WHERE created_at > ?
    GROUP BY hour
    ORDER BY hour
  `).all(since24hMs) as HourlyThroughput[];
}

export function queryBudget(db: DB): { today: BudgetSpendRow | null; mtdUsd: number; mtdCalls: number } {
  const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const monthPrefix = todayKey.slice(0, 7); // YYYY-MM

  const today = db.prepare<[string], BudgetSpendRow>(
    'SELECT day, usd_total, calls FROM budget_spend WHERE day = ?',
  ).get(todayKey) as BudgetSpendRow | undefined ?? null;

  const mtd = db.prepare<[string], { usd_total: number; calls: number }>(
    "SELECT COALESCE(SUM(usd_total), 0) AS usd_total, COALESCE(SUM(calls), 0) AS calls FROM budget_spend WHERE day LIKE ? || '%'",
  ).get(monthPrefix) as { usd_total: number; calls: number } | undefined;

  return {
    today,
    mtdUsd: mtd?.usd_total ?? 0,
    mtdCalls: mtd?.calls ?? 0,
  };
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** ADR-010 recall-usefulness rate, last 7 days. Per-type breakdown is
 *  intentionally not part of the dashboard primary path (FEAT-410 design:
 *  real product-quality signal, but not an operational glance-screen
 *  signal) — see storage/usefulness.ts's usefulnessByType for that data. */
export function queryUsefulness(db: DB): UsefulnessRate {
  const since = Date.now() - SEVEN_DAYS_MS;
  return usefulnessRate(db, { sinceMs: since });
}

/**
 * Run all dashboard queries in a single pass. `healthState` is the same
 * instance built at boot for GET /health (FEAT-410) — when omitted (bare
 * test apps), `health` is null and callers degrade the same way /health
 * does without it. `memoryFilters` (project/profile) is applied server-side
 * to `recentMemories`' SQL — see `queryRecentMemories`.
 */
export async function queryDashboard(db: DB, healthState?: HealthState, memoryFilters: MemoryListFilters = {}): Promise<DashboardData> {
  const memoryCounts = queryMemoryCounts(db);
  const recentMemories = queryRecentMemories(db, memoryFilters);
  const jobStates = queryJobStates(db);
  const jobStatesByKind = queryJobStatesByKind(db);
  const hourlyThroughput = queryHourlyThroughput(db);
  const budget = queryBudget(db);
  const usefulness = queryUsefulness(db);
  const consolidation = queryConsolidationSummary(db);
  const recentFailedJobs = queryRecentFailedJobs(db);
  const entityLinkage = queryEntityLinkage(db);
  const health = healthState ? buildDashboardHealth(healthState) : null;
  const filterOptions = { projects: queryProjectOptions(db), profiles: queryProfileOptions(db) };

  return {
    memoryCounts,
    recentMemories,
    jobStates,
    jobStatesByKind,
    hourlyThroughput,
    todaySpend: budget.today,
    mtdSpend: budget.mtdUsd,
    mtdCalls: budget.mtdCalls,
    usefulness,
    consolidation,
    memoryFilters,
    filterOptions,
    recentFailedJobs,
    entityLinkage,
    health,
  };
}
