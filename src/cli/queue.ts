/**
 * `astramem-local queue [--json] [--limit N]`
 * `astramem-local queue purge --poison [--json] [--dump-dir PATH]`
 *
 * Shows job-table state counts (pending/running/completed/failed/poison/paused),
 * a pending-jobs breakdown by FEAT-482 priority tier (P1 claimed first —
 * `JobRepo.pendingByPriority()`), plus the most recent failures (state IN
 * ('failed','poison')) with their last_error and priority tier, so an
 * operator can see what's stuck — and how urgent it was — without opening
 * the DB.
 *
 * The `purge --poison` subcommand (FEAT-405) removes poison-marked jobs on
 * demand, ahead of the 30-day auto-purge — see ./queue-purge.ts.
 */

import { openRuntimeDb } from './open-runtime-db.js';
import { queuePurgeCommand } from './queue-purge.js';
import { queueRequeueCommand } from './queue-requeue.js';
import { JobRepo } from '../pipeline/job-repo.js';
import type { JobState } from '../contracts/index.js';
import { parseArg } from './arg-parse.js';

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
  priority: number;
}

interface PriorityCount {
  priority: number;
  n: number;
}

export interface QueueSummary {
  counts: StateCount[];
  recentFailures: RecentFailure[];
  pendingByPriority: PriorityCount[];
}

export async function queueCommand(args: string[]): Promise<void> {
  if (args[0] === 'purge') {
    await queuePurgeCommand(args.slice(1));
    return;
  }

  if (args[0] === 'requeue') {
    await queueRequeueCommand(args.slice(1));
    return;
  }

  const jsonMode = args.includes('--json');
  const limitArg = parseArg(args, '--limit');
  const limit = limitArg ? Math.max(1, Number(limitArg)) : 10;

  // Key-aware + config.yaml-aware open (same resolution as serve/doctor).
  const { db } = openRuntimeDb();

  const counts = db
    .prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state ORDER BY state')
    .all() as StateCount[];

  const recentFailures = db
    .prepare(`
      SELECT id, kind, attempts, last_error, updated_at, priority
      FROM jobs
      WHERE state IN ('failed', 'poison')
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    .all(limit) as RecentFailure[];

  const pendingByPriority = new JobRepo(db).pendingByPriority();

  db.close();

  const summary: QueueSummary = { counts, recentFailures, pendingByPriority };

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
  if (pendingByPriority.length === 0) {
    console.log('  No pending jobs.');
  } else {
    console.log('  Pending by priority tier (P1 claimed first):');
    for (const p of pendingByPriority) {
      console.log(`    P${p.priority}  ${p.n}`);
    }
  }

  console.log('');
  if (recentFailures.length === 0) {
    console.log('  No recent failures.');
  } else {
    console.log(`  Recent failures (last ${recentFailures.length}):`);
    for (const f of recentFailures) {
      const when = new Date(f.updated_at).toISOString();
      const err = (f.last_error ?? '(no error recorded)').slice(0, 160);
      console.log(`    [${when}] ${f.kind} ${f.id} (priority=P${f.priority}, attempts=${f.attempts}): ${err}`);
    }
  }
  console.log('');
}
