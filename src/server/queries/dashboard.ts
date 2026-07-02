/**
 * Read-only queries powering the /dashboard HTML endpoint.
 * Extracted here so tests can exercise them independently of the route layer.
 */

import type { DB } from '../../storage/db.js';

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
}

export interface JobStateCount {
  state: string;
  count: number;
}

export interface HourlyThroughput {
  hour: string;
  count: number;
}

export interface ProviderRow {
  provider: string;
  model: string;
  dim: number | null;
  last_health_ok: number;
  last_check_at: number | null;
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
  hourlyThroughput: HourlyThroughput[];
  providers: ProviderRow[];
  todaySpend: BudgetSpendRow | null;
  mtdSpend: number;
  mtdCalls: number;
  pendingDir: { count: number; oldestAgeMs: number | null };
}

// ---------------------------------------------------------------------------
// Query implementations
// ---------------------------------------------------------------------------

export function queryMemoryCounts(db: DB): MemoryCountByType[] {
  return db.prepare<[], MemoryCountByType>(
    'SELECT type, COUNT(*) as count FROM memories GROUP BY type ORDER BY 2 DESC',
  ).all() as MemoryCountByType[];
}

export function queryRecentMemories(db: DB): RecentMemory[] {
  return db.prepare<[], RecentMemory>(`
    SELECT id, type, text, importance, confidence, session_id, created_at
    FROM memories
    ORDER BY created_at DESC
    LIMIT 25
  `).all() as RecentMemory[];
}

export function queryJobStates(db: DB): JobStateCount[] {
  return db.prepare<[], JobStateCount>(
    'SELECT state, COUNT(*) as count FROM jobs GROUP BY state',
  ).all() as JobStateCount[];
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

export function queryProviders(db: DB): ProviderRow[] {
  return db.prepare<[], ProviderRow>(
    'SELECT provider, model, dim, last_health_ok, last_check_at FROM provider_state',
  ).all() as ProviderRow[];
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

/**
 * Scan %APPDATA%\Astramem\pending\ (Windows) for pending capture files.
 * Returns count + oldest age in ms. Wrapped in try/catch — dir may not exist.
 */
export async function queryPendingDir(): Promise<{ count: number; oldestAgeMs: number | null }> {
  try {
    const { readdir, stat } = await import('node:fs/promises');
    const appData = process.env['APPDATA'];
    if (!appData) return { count: 0, oldestAgeMs: null };

    const pendingDir = `${appData}\\Astramem\\pending`;
    let files: string[];
    try {
      files = await readdir(pendingDir);
    } catch {
      // Dir does not exist — normal on fresh installs
      return { count: 0, oldestAgeMs: null };
    }

    if (files.length === 0) return { count: 0, oldestAgeMs: null };

    const now = Date.now();
    let oldestMtime = now;
    for (const f of files) {
      try {
        const s = await stat(`${pendingDir}\\${f}`);
        if (s.mtimeMs < oldestMtime) oldestMtime = s.mtimeMs;
      } catch {
        // skip unreadable entry
      }
    }

    return { count: files.length, oldestAgeMs: now - oldestMtime };
  } catch {
    return { count: 0, oldestAgeMs: null };
  }
}

/** Run all dashboard queries in a single synchronous pass (except pendingDir which is async). */
export async function queryDashboard(db: DB): Promise<DashboardData> {
  const memoryCounts = queryMemoryCounts(db);
  const recentMemories = queryRecentMemories(db);
  const jobStates = queryJobStates(db);
  const hourlyThroughput = queryHourlyThroughput(db);
  const providers = queryProviders(db);
  const budget = queryBudget(db);
  const pendingDir = await queryPendingDir();

  return {
    memoryCounts,
    recentMemories,
    jobStates,
    hourlyThroughput,
    providers,
    todaySpend: budget.today,
    mtdSpend: budget.mtdUsd,
    mtdCalls: budget.mtdCalls,
    pendingDir,
  };
}
