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
   * Transition a running job to failed, record the error, increment attempts.
   * The caller is responsible for deciding whether to then call markPoison.
   */
  fail(id: string, error: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE jobs
      SET state = 'failed', last_error = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ?
    `).run(error, now, id);
  }

  /** Transition a job to the poison state (permanently failed). */
  markPoison(id: string): void {
    this._transition(id, 'poison');
  }

  /** Transition a job to paused (e.g. budget exceeded). */
  pause(id: string): void {
    this._transition(id, 'paused');
  }

  /** Read a single job by id. Returns null if not found. */
  get(id: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
    return row ?? null;
  }

  private _transition(id: string, state: JobState): void {
    const now = Date.now();
    this.db.prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?').run(state, now, id);
  }
}
