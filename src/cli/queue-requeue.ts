/**
 * `astramem-local queue requeue --poison [--kind KIND] [--limit N] [--json]`
 *
 * The operational counterpart to `queue purge --poison`: instead of discarding
 * poison-marked jobs, move a BOUNDED batch back to `pending` so the worker
 * retries them. Use after fixing a transient external cause (e.g. an expired
 * provider token or an exhausted quota that has since recovered) — the poison
 * jobs retain their original `payload_json`, so a retry re-runs the same work.
 *
 * BOUNDED by design: `--limit N` (default: all) requeues at most N so an operator
 * can drain in monitored batches and stop if the underlying cause recurs (jobs
 * re-poison). `--kind` filters to one job kind (e.g. `distill`). The single-lane
 * worker naturally throttles the actual re-processing.
 *
 * Note: requeueing a job whose `attempts` already hit the poison threshold gives
 * it exactly ONE more attempt — it completes if the transient cause is gone, and
 * re-poisons (a clear STOP signal) if not.
 *
 * Exit codes: 0 = success (including the zero-poison no-op), 1 = usage error.
 */
import { openRuntimeDb } from './open-runtime-db.js';
import { JobRepo } from '../pipeline/job-repo.js';
import { parseArg } from './arg-parse.js';

export interface RequeueResult {
  requeued: number;
  remaining: number;
  kind: string | null;
}

export async function queueRequeueCommand(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');

  if (!args.includes('--poison')) {
    console.error('queue requeue: only --poison is supported (usage: `queue requeue --poison [--kind KIND] [--limit N]`)');
    process.exit(1);
    return;
  }

  const kind = parseArg(args, '--kind') ?? null;
  const limitArg = parseArg(args, '--limit');
  const limit = limitArg !== undefined ? Math.max(1, Number(limitArg)) : Number.POSITIVE_INFINITY;
  if (limitArg !== undefined && !Number.isFinite(Number(limitArg))) {
    console.error(`queue requeue: --limit must be a positive number (got ${JSON.stringify(limitArg)})`);
    process.exit(1);
    return;
  }

  const { db } = openRuntimeDb();
  const repo = new JobRepo(db);

  const poison = repo.listPoison().filter((j) => (kind ? j.kind === kind : true));
  const batch = poison.slice(0, Number.isFinite(limit) ? limit : poison.length);
  for (const j of batch) repo.requeueForRetry(j.id);

  db.close();

  const result: RequeueResult = { requeued: batch.length, remaining: poison.length - batch.length, kind };
  if (jsonMode) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`queue requeue: moved ${batch.length} poison${kind ? ` ${kind}` : ''} job(s) → pending.`);
    console.log(`  remaining poison${kind ? ` ${kind}` : ''}: ${result.remaining}`);
    if (result.remaining > 0) console.log('  (re-run with the same --limit to drain the next batch; stop if poison climbs = cause recurred)');
  }
}
