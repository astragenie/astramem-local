import { randomUUID } from 'node:crypto';
import type { DB } from '../storage/db.js';
import type { Job, JobKind, JobState } from '../contracts/index.js';

/**
 * Data-access object for the jobs table.
 * All methods are synchronous (better-sqlite3 is sync).
 */
export class JobRepo {
  constructor(private readonly db: DB) {}

  /** Insert a new job in pending state, return its generated id. */
  enqueue(kind: JobKind, payload: unknown): string {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO jobs (id, kind, payload_json, state, attempts, last_error, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?)
    `).run(id, kind, JSON.stringify(payload), now, now);
    return id;
  }

  /**
   * Atomically claim the oldest pending job: pending → running.
   * Returns the updated Job row, or null if the queue is empty.
   * Uses a CTE-based UPDATE so only one concurrent caller wins the row.
   */
  claimPending(): Job | null {
    // SQLite does not support UPDATE ... RETURNING with a subquery on some versions,
    // so we use a transaction: SELECT the candidate, then UPDATE if still pending.
    const claim = this.db.transaction((): Job | null => {
      const candidate = this.db.prepare(`
        SELECT * FROM jobs
        WHERE state = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
      `).get() as Job | undefined;

      if (!candidate) return null;

      const now = Date.now();
      const changes = this.db.prepare(`
        UPDATE jobs
        SET state = 'running', updated_at = ?
        WHERE id = ? AND state = 'pending'
      `).run(now, candidate.id).changes;

      if (changes === 0) return null; // race: another worker grabbed it

      return { ...candidate, state: 'running' as JobState, updated_at: now };
    });

    return claim();
  }

  /** Transition a running job to completed. */
  complete(id: string): void {
    this._transition(id, 'completed');
  }

  /**
   * Record a handler failure: increment attempts and record the error.
   * The new state is 'failed'. The worker checks attempts after this call
   * and either re-enqueues (back to 'pending') or calls markPoison.
   */
  fail(id: string, error: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE jobs
      SET state = 'failed', last_error = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ?
    `).run(error, now, id);
  }

  /**
   * Move a failed job back to pending so the worker will retry it.
   * Only call this when attempts < MAX_ATTEMPTS.
   */
  requeueForRetry(id: string): void {
    this._transition(id, 'pending');
  }

  /** Transition a job to the poison state (permanently failed). */
  markPoison(id: string): void {
    this._transition(id, 'poison');
  }

  /** Transition a job to paused (e.g. budget exceeded). */
  pause(id: string): void {
    this._transition(id, 'paused');
  }

  /**
   * Record a non-failure note on the job (e.g. budget pause reason) without
   * touching `attempts`. Use for state transitions that are not handler errors.
   */
  setLastError(id: string, note: string): void {
    const now = Date.now();
    this.db.prepare('UPDATE jobs SET last_error = ?, updated_at = ? WHERE id = ?').run(note, now, id);
  }

  /** Read a single job by id. Returns null if not found. */
  get(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
    return row ?? null;
  }

  /**
   * Boot-time crash recovery. Call once at daemon start, before the worker.
   *
   * - 'running' jobs are orphans: the previous process died mid-handle (on
   *   Windows, schtasks /end and Task Manager kills bypass the SIGTERM
   *   handler entirely). Requeue them.
   * - 'failed' jobs with attempts < maxAttempts were waiting on an IN-MEMORY
   *   retry timer (worker.ts setTimeout) that died with the process — without
   *   this they are stranded in 'failed' forever. Requeue them too.
   *
   * `attempts` is preserved in both cases so poison thresholds still apply.
   * Handlers must tolerate re-execution of partially-applied work (distill/
   * reembed write via idempotent upserts; a rare duplicate memory from a
   * mid-write crash is deduped downstream by consolidation).
   */
  recoverOrphans(maxAttempts = 3): { requeuedRunning: number; requeuedFailed: number } {
    const now = Date.now();
    const requeuedRunning = this.db.prepare(`
      UPDATE jobs SET state = 'pending', updated_at = ?
      WHERE state = 'running'
    `).run(now).changes;
    const requeuedFailed = this.db.prepare(`
      UPDATE jobs SET state = 'pending', updated_at = ?
      WHERE state = 'failed' AND attempts < ?
    `).run(now, maxAttempts).changes;
    return { requeuedRunning, requeuedFailed };
  }

  /**
   * Retention purge: completed jobs are transient bookkeeping (7d), poison
   * jobs are kept longer (30d) for `queue` command forensics. Other states
   * are never touched.
   */
  purgeOld(opts: { completedDays?: number; poisonDays?: number } = {}): { completed: number; poison: number } {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const completedCutoff = now - (opts.completedDays ?? 7) * dayMs;
    const poisonCutoff = now - (opts.poisonDays ?? 30) * dayMs;
    const completed = this.db.prepare(
      `DELETE FROM jobs WHERE state = 'completed' AND updated_at < ?`,
    ).run(completedCutoff).changes;
    const poison = this.db.prepare(
      `DELETE FROM jobs WHERE state = 'poison' AND updated_at < ?`,
    ).run(poisonCutoff).changes;
    return { completed, poison };
  }

  /** State → count map for /health queue reporting. */
  stateCounts(): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT state, COUNT(*) AS n FROM jobs GROUP BY state`,
    ).all() as Array<{ state: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  private _transition(id: string, state: JobState): void {
    const now = Date.now();
    this.db.prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?').run(state, now, id);
  }
}
