import { randomUUID } from 'node:crypto';
import type { DB } from '../storage/db.js';
import type { Job, JobKind, JobState } from '../contracts/index.js';

/**
 * Priority tiers (FEAT-482 fold, worker-starvation wave, item 1 of 3).
 * LOWER number is claimed FIRST — `enqueue()` stamps the tier for a job's
 * `kind` onto the row at insert time, so `claimPending()`'s ORDER BY never
 * needs a per-call kind lookup.
 *
 * P1 — distill / distill-events: the user-facing extract/compact/embed
 *      pipeline. Recall correctness depends on this landing promptly.
 * P2 — reembed / transcribe: backfill-shaped maintenance (re-index one
 *      memory, convert one queued audio file) — async by design, but still
 *      wants to drain ahead of pure housekeeping.
 * P3 — consolidate: the merge/propose (+ optional contradiction/dup-judge)
 *      sweep. Also the DEFAULT_JOB_PRIORITY fallback below.
 * P4 — reserved, no JobKind maps here today. contradiction-judge/dup-judge
 *      calls happen INSIDE a `consolidate` job, not as their own row —
 *      kept as a numbered gap so a future standalone job kind for that
 *      work slots in without renumbering every tier below it.
 * P5 — cleanup: pure housekeeping, lowest urgency.
 */
export const JOB_PRIORITY: Readonly<Record<JobKind, number>> = {
  distill: 1,
  'distill-events': 1,
  reembed: 2,
  transcribe: 2,
  consolidate: 3,
  cleanup: 5,
};

/** Fallback tier for any row without a `JOB_PRIORITY` entry — in practice
 *  only a pre-058 legacy row (migration 058's own `DEFAULT 3`) or a raw
 *  insert that bypassed `enqueue()`; `JobKind` is a closed union, so every
 *  kind enqueue() actually sees already has a real entry above. Mid-tier —
 *  same value migration 058 backfills existing rows to — so a legacy row
 *  neither jumps ahead of nor starves forever behind newly tiered work (the
 *  aging term in `claimPending()` bounds "forever" regardless). */
export const DEFAULT_JOB_PRIORITY = 3;

/**
 * Job kinds whose handler never makes a network/LLM/embed call — pure local
 * SQLite reads/writes (see handlers/cleanup.ts: DB deletes + local sweeps
 * only). Reserved for the worker's lane-0 preferential claim (`worker.ts`'s
 * `RESERVED_LOCAL_LANE_ID`, `backpressure.ts`) so a local-only job — e.g.
 * cleanup's own vec-index-retry sweep — can't get stuck behind a long
 * network-bound distill/consolidate job occupying every other lane, which is
 * exactly the failure mode `queue-liveness-starvation.test.ts` documents in
 * the opposite direction (a slow job starving everything else).
 *
 * Deliberately conservative/static — classified by KIND, not by runtime
 * config — mirrors `backpressure.ts`'s `EMBED_HEAVY_KINDS` classification
 * style. `consolidate` is NOT included even though its default merge/propose
 * pass is itself local-only: contradiction-detection/dup-judge config can
 * turn any given consolidate run into a network-bound one, and a per-kind
 * static set can't see that at claim time.
 */
export const LOCAL_SQLITE_KINDS: readonly JobKind[] = ['cleanup'];

/**
 * Anti-starvation aging (FEAT-482 fold, item 3 of 3). Every `AGING_STEP_MS`
 * a pending job has waited knocks one full tier off its EFFECTIVE priority
 * for claim-ordering purposes only — the stored `priority` column itself is
 * never mutated, so `queue`/doctor forensics still show the job's real tier.
 *
 * A tier-5 (cleanup) job ages past tier-1 after 4 elapsed steps, and below
 * EVERY possible fresh arrival (which always starts at its own base tier,
 * age ~0) after 5 — so a low-priority job is GUARANTEED to eventually win a
 * claim race against a continuous stream of fresh P1 arrivals, not merely
 * "sometimes get lucky" on a quiet tick. See job-repo.test.ts's fairness
 * test for the selection-OUTCOME proof (not just the SQL shape — aging is
 * easy to get backwards in a way no test of the expression alone catches).
 */
export const AGING_STEP_MS = 120_000;

/** SQL fragment computing a row's claim-time EFFECTIVE priority: its stored
 *  tier minus one full tier per `AGING_STEP_MS` elapsed since `created_at`.
 *  Integer division truncates toward zero, which is floor() here since
 *  `created_at` can never be after the bound `now` parameter (age >= 0).
 *  Bind order for each occurrence: (nowMs, AGING_STEP_MS). */
const EFFECTIVE_PRIORITY_SQL = `(priority - ((? - created_at) / ?))`;

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
    const priority = JOB_PRIORITY[kind] ?? DEFAULT_JOB_PRIORITY;
    this.db.prepare(`
      INSERT INTO jobs (id, kind, payload_json, state, attempts, last_error, priority, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?, ?)
    `).run(id, kind, JSON.stringify(payload), priority, now, now);
    return id;
  }

  /**
   * Atomically claim the highest-EFFECTIVE-priority pending job (tier, aged
   * by wait time — see `AGING_STEP_MS`; ties broken oldest-`created_at`-
   * first): pending → running. Returns the updated Job row, or null if the
   * queue (or, with `preferKinds` set, the preferred-kind subset of it) is
   * empty.
   *
   * `preferKinds`, when non-empty, first tries to claim among ONLY those
   * kinds; if none are pending it falls through to a normal claim across
   * every kind. Used by `worker.ts`'s lane-0 reservation
   * (`LOCAL_SQLITE_KINDS`) so a local-only job always gets first refusal on
   * that lane without ever leaving it idle when no local-only job is
   * waiting. Omitted entirely (every pre-existing caller) is byte-identical
   * to claiming across all kinds.
   *
   * Uses a CTE-based UPDATE so only one concurrent caller wins the row.
   */
  claimPending(opts: { preferKinds?: readonly JobKind[] } = {}): Job | null {
    // SQLite does not support UPDATE ... RETURNING with a subquery on some versions,
    // so we use a transaction: SELECT the candidate, then UPDATE if still pending.
    const claim = this.db.transaction((): Job | null => {
      const now = Date.now();
      let candidate: Job | undefined;

      if (opts.preferKinds && opts.preferKinds.length > 0) {
        const placeholders = opts.preferKinds.map(() => '?').join(',');
        candidate = this.db.prepare(`
          SELECT * FROM jobs
          WHERE state = 'pending' AND kind IN (${placeholders})
          ORDER BY ${EFFECTIVE_PRIORITY_SQL} ASC, created_at ASC
          LIMIT 1
        `).get(...opts.preferKinds, now, AGING_STEP_MS) as Job | undefined;
      }

      if (!candidate) {
        candidate = this.db.prepare(`
          SELECT * FROM jobs
          WHERE state = 'pending'
          ORDER BY ${EFFECTIVE_PRIORITY_SQL} ASC, created_at ASC
          LIMIT 1
        `).get(now, AGING_STEP_MS) as Job | undefined;
      }

      if (!candidate) return null;

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
   *   handler entirely). Requeue them — EXCEPT `kind = 'consolidate'`, which
   *   is poisoned instead (see below, issue #387).
   * - 'failed' jobs with attempts < maxAttempts were waiting on an IN-MEMORY
   *   retry timer (worker.ts setTimeout) that died with the process — without
   *   this they are stranded in 'failed' forever. Requeue them too (all
   *   kinds, including 'consolidate' — a job that reached 'failed' already
   *   went through the worker's normal catch/`fail()` path and respects the
   *   `maxAttempts` poison threshold; the blind-requeue hazard below is
   *   specific to 'running', which bypasses that threshold entirely).
   *
   * `attempts` is preserved in both cases so poison thresholds still apply.
   * Handlers must tolerate re-execution of partially-applied work (distill/
   * reembed write via idempotent upserts; a rare duplicate memory from a
   * mid-write crash is deduped downstream by consolidation).
   *
   * issue #387: a 'running' consolidate job orphaned by a mid-handle kill
   * used to be requeued exactly like any other kind, straight back to
   * 'pending' — the worker's first poll then re-ran the IDENTICAL unbounded
   * pairwise-scan setup (src/consolidate/consolidate.ts) that froze the
   * event loop long enough to kill the previous process in the first place,
   * reproducing the freeze on every single restart with no way out short of
   * manual DB surgery. A consolidate job recovered from 'running' is now
   * poisoned instead of requeued — same terminal state `markPoison` uses,
   * with a `last_error` naming the issue so `queue`/doctor forensics don't
   * read as an unexplained poison. Requires an explicit re-enqueue (or a fix
   * to the setup phase's own bound/yield behavior) to run again — see
   * consolidate.ts's `setupBudgetMs`/`setupYieldEveryNAtoms`.
   */
  recoverOrphans(maxAttempts = 3): { requeuedRunning: number; requeuedFailed: number; poisonedConsolidate: number } {
    const now = Date.now();
    const poisonedConsolidate = this.db.prepare(`
      UPDATE jobs
      SET state = 'poison', updated_at = ?,
          last_error = 'boot recovery: running consolidate job poisoned, not requeued ' ||
            '(issue #387 — the unbounded pairwise-scan setup can freeze the event loop on ' ||
            'every restart if simply requeued); re-enqueue manually once safe'
      WHERE state = 'running' AND kind = 'consolidate'
    `).run(now).changes;
    const requeuedRunning = this.db.prepare(`
      UPDATE jobs SET state = 'pending', updated_at = ?
      WHERE state = 'running' AND kind != 'consolidate'
    `).run(now).changes;
    const requeuedFailed = this.db.prepare(`
      UPDATE jobs SET state = 'pending', updated_at = ?
      WHERE state = 'failed' AND attempts < ?
    `).run(now, maxAttempts).changes;
    return { requeuedRunning, requeuedFailed, poisonedConsolidate };
  }

  /**
   * FEAT-482: requeue every 'paused' job back to 'pending' — the
   * operator-triggered counterpart to `recoverOrphans` (that boot-time sweep
   * deliberately LEAVES 'paused' alone; see its doc comment and
   * job-recovery.test.ts). Called from `astramem-local budget --reset`
   * (src/cli/budget.ts) right after `BudgetTracker.resetToday()` — until
   * this existed, a job the worker paused on `DistillBudgetPausedError` (see
   * worker.ts / pipeline/handlers/distill.ts) had NO path back to 'pending'
   * at all: `--reset` only zeroed the spend counter, so a paused job stayed
   * paused forever even after the cap that paused it was cleared. Today only
   * `distill` jobs can actually reach 'paused' (the consolidate contradiction
   * judge is bounded by call-count/wall-clock caps instead of a budget check
   * — see contradiction-judge.ts's doc comment for why a dollar cap was tried
   * and reverted there), but this method is job-kind-agnostic by
   * construction, like every other state transition here, so any future job
   * kind that adopts the same pause-on-budget pattern gets this for free.
   * `attempts` is left untouched (mirrors `recoverOrphans`), so a job that
   * was already partway through its retry budget before pausing doesn't get
   * a free reset on poison eligibility.
   */
  requeuePaused(): number {
    const now = Date.now();
    return this.db.prepare(`
      UPDATE jobs SET state = 'pending', updated_at = ?
      WHERE state = 'paused'
    `).run(now).changes;
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

  /** List all jobs currently in the 'poison' state, oldest first (FEAT-405 manual purge). */
  listPoison(): Job[] {
    return this.db.prepare(`
      SELECT * FROM jobs WHERE state = 'poison' ORDER BY updated_at ASC
    `).all() as Job[];
  }

  /**
   * Delete specific poison jobs by id (FEAT-405 `queue purge --poison`).
   * Guarded to state = 'poison' so a job that transitions out of poison
   * between the caller's read (for the forensics dump) and this delete is
   * never silently swept up. Callers must capture ids via listPoison() first
   * and write the forensics dump BEFORE calling this.
   */
  purgePoisonByIds(ids: string[]): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(
      `DELETE FROM jobs WHERE state = 'poison' AND id IN (${placeholders})`,
    ).run(...ids).changes;
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
