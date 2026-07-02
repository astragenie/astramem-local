/**
 * `astramem-local queue [--json] [--limit N]`
 *
 * Shows job-table state counts (pending/running/completed/failed/poison/paused)
 * plus the most recent failures (state IN ('failed','poison')) with their
 * last_error, so an operator can see what's stuck without opening the DB.
 */

import { join } from 'node:path';
import { openDb } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import { defaultConfig } from '../config/config.js';
import type { JobState } from '../contracts/index.js';

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

interface StateCount {
  state: JobState;
  n: number;
}

interface RecentFailure {
  id: string;
  kind: string;
  attempts: number;
  last_error: string | null;
  updated_at: number;
}

export interface QueueSummary {
  counts: StateCount[];
  recentFailures: RecentFailure[];
}

export async function queueCommand(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const limitArg = parseArg(args, '--limit');
  const limit = limitArg ? Math.max(1, Number(limitArg)) : 10;

  const cfg = defaultConfig();
  const dataDir = process.env.ASTRA_MEMORY_DATADIR ?? cfg.dataDir;
  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'memory.sqlite');

  const db = openDb(dbPath);
  migrate(db);

  const counts = db
    .prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state ORDER BY state')
    .all() as StateCount[];

  const recentFailures = db
    .prepare(`
      SELECT id, kind, attempts, last_error, updated_at
      FROM jobs
      WHERE state IN ('failed', 'poison')
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    .all(limit) as RecentFailure[];

  db.close();

  const summary: QueueSummary = { counts, recentFailures };

  if (jsonMode) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('');
  console.log('  AstraMemory Job Queue');
  console.log('  ──────────────────────────────');
  if (counts.length === 0) {
    console.log('  (no jobs yet)');
  } else {
    const total = counts.reduce((sum, c) => sum + c.n, 0);
    for (const c of counts) {
      console.log(`  ${c.state.padEnd(10)} ${c.n}`);
    }
    console.log(`  ${'total'.padEnd(10)} ${total}`);
  }

  console.log('');
  if (recentFailures.length === 0) {
    console.log('  No recent failures.');
  } else {
    console.log(`  Recent failures (last ${recentFailures.length}):`);
    for (const f of recentFailures) {
      const when = new Date(f.updated_at).toISOString();
      const err = (f.last_error ?? '(no error recorded)').slice(0, 160);
      console.log(`    [${when}] ${f.kind} ${f.id} (attempts=${f.attempts}): ${err}`);
    }
  }
  console.log('');
}
