import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { JobRepo } from '../../src/pipeline/job-repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function setJob(db: DB, id: string, state: string, attempts: number, updatedAt = Date.now()): void {
  db.prepare(
    `UPDATE jobs SET state = ?, attempts = ?, updated_at = ? WHERE id = ?`,
  ).run(state, attempts, updatedAt, id);
}

describe('JobRepo boot recovery + retention', () => {
  let db: DB;
  let repo: JobRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new JobRepo(db);
  });

  it('recoverOrphans requeues running jobs (mid-handle crash)', () => {
    const id = repo.enqueue('distill', {});
    setJob(db, id, 'running', 1);
    const r = repo.recoverOrphans();
    expect(r.requeuedRunning).toBe(1);
    expect(r.poisonedConsolidate).toBe(0);
    expect(repo.get(id)?.state).toBe('pending');
    expect(repo.get(id)?.attempts).toBe(1); // attempts preserved
  });

  // issue #387: a 'running' consolidate job orphaned by a mid-handle kill
  // used to be requeued exactly like any other kind, so the worker's next
  // poll re-ran the same unbounded setup that froze the previous process —
  // reproducing the freeze on every restart. It must now be poisoned, not
  // requeued, while every other kind (distill included) keeps recovering
  // normally in the SAME recoverOrphans() call.
  it('recoverOrphans poisons a running consolidate job instead of requeuing it, but still requeues a running distill job in the same pass', () => {
    const consolidateId = repo.enqueue('consolidate', {});
    setJob(db, consolidateId, 'running', 0);
    const distillId = repo.enqueue('distill', {});
    setJob(db, distillId, 'running', 0);

    const r = repo.recoverOrphans();

    expect(r.poisonedConsolidate).toBe(1);
    expect(r.requeuedRunning).toBe(1); // only the distill job

    const consolidateJob = repo.get(consolidateId);
    expect(consolidateJob?.state).toBe('poison');
    expect(consolidateJob?.last_error).toContain('#387');
    expect(consolidateJob?.attempts).toBe(0); // attempts preserved, not incremented

    expect(repo.get(distillId)?.state).toBe('pending');
  });

  it('recoverOrphans poisons EVERY running consolidate job, not just the first', () => {
    const idA = repo.enqueue('consolidate', {});
    setJob(db, idA, 'running', 1);
    const idB = repo.enqueue('consolidate', {});
    setJob(db, idB, 'running', 2);

    const r = repo.recoverOrphans();

    expect(r.poisonedConsolidate).toBe(2);
    expect(repo.get(idA)?.state).toBe('poison');
    expect(repo.get(idB)?.state).toBe('poison');
  });

  it('recoverOrphans still requeues a FAILED consolidate job under maxAttempts (only the running-state bypass is guarded)', () => {
    const id = repo.enqueue('consolidate', {});
    setJob(db, id, 'failed', 1);
    const r = repo.recoverOrphans();
    expect(r.poisonedConsolidate).toBe(0);
    expect(r.requeuedFailed).toBe(1);
    expect(repo.get(id)?.state).toBe('pending');
  });

  it('recoverOrphans requeues failed jobs whose in-memory retry timer died', () => {
    const id = repo.enqueue('distill', {});
    setJob(db, id, 'failed', 2);
    const r = repo.recoverOrphans();
    expect(r.requeuedFailed).toBe(1);
    expect(repo.get(id)?.state).toBe('pending');
  });

  it('recoverOrphans leaves exhausted failed jobs alone (attempts >= max)', () => {
    const id = repo.enqueue('distill', {});
    setJob(db, id, 'failed', 3);
    const r = repo.recoverOrphans();
    expect(r.requeuedFailed).toBe(0);
    expect(repo.get(id)?.state).toBe('failed');
  });

  it('recoverOrphans does not touch pending/completed/poison/paused', () => {
    for (const state of ['pending', 'completed', 'poison', 'paused']) {
      const id = repo.enqueue('distill', {});
      setJob(db, id, state, 0);
      repo.recoverOrphans();
      expect(repo.get(id)?.state).toBe(state);
    }
  });

  // FEAT-482: `recoverOrphans` above deliberately leaves 'paused' alone (a
  // budget pause is not a crash) — before `requeuePaused` existed, that left
  // NO path back to 'pending' at all: `budget --reset` only zeroed the spend
  // counter (src/cli/budget.ts), so a paused job stayed paused forever even
  // after the cap that paused it was cleared. This proves the fix, and that
  // it's job-kind-agnostic — a 'consolidate' job pauses/resumes exactly like
  // a 'distill' job, since both go through the same jobs table state machine.
  it('requeuePaused() moves every paused job back to pending, regardless of kind, and leaves attempts untouched', () => {
    const distillId = repo.enqueue('distill', {});
    setJob(db, distillId, 'paused', 1);
    const consolidateId = repo.enqueue('consolidate', {});
    setJob(db, consolidateId, 'paused', 0);

    const n = repo.requeuePaused();

    expect(n).toBe(2);
    expect(repo.get(distillId)?.state).toBe('pending');
    expect(repo.get(distillId)?.attempts).toBe(1); // attempts preserved, mirrors recoverOrphans
    expect(repo.get(consolidateId)?.state).toBe('pending');
  });

  it('requeuePaused() does not touch pending/running/completed/failed/poison', () => {
    for (const state of ['pending', 'running', 'completed', 'failed', 'poison']) {
      const id = repo.enqueue('distill', {});
      setJob(db, id, state, 0);
      repo.requeuePaused();
      expect(repo.get(id)?.state).toBe(state);
    }
  });

  it('requeuePaused() returns 0 when no job is paused', () => {
    repo.enqueue('distill', {});
    expect(repo.requeuePaused()).toBe(0);
  });

  it('purgeOld deletes old completed (7d) and old poison (30d), keeps recent', () => {
    const oldCompleted = repo.enqueue('distill', {});
    setJob(db, oldCompleted, 'completed', 1, Date.now() - 8 * DAY_MS);
    const newCompleted = repo.enqueue('distill', {});
    setJob(db, newCompleted, 'completed', 1, Date.now() - 1 * DAY_MS);
    const oldPoison = repo.enqueue('distill', {});
    setJob(db, oldPoison, 'poison', 3, Date.now() - 31 * DAY_MS);
    const newPoison = repo.enqueue('distill', {});
    setJob(db, newPoison, 'poison', 3, Date.now() - 10 * DAY_MS);

    const r = repo.purgeOld();
    expect(r.completed).toBe(1);
    expect(r.poison).toBe(1);
    expect(repo.get(oldCompleted)).toBeNull();
    expect(repo.get(newCompleted)).not.toBeNull();
    expect(repo.get(oldPoison)).toBeNull();
    expect(repo.get(newPoison)).not.toBeNull();
  });

  it('stateCounts groups by state', () => {
    repo.enqueue('distill', {});
    repo.enqueue('distill', {});
    const id = repo.enqueue('distill', {});
    setJob(db, id, 'poison', 3);
    const counts = repo.stateCounts();
    expect(counts['pending']).toBe(2);
    expect(counts['poison']).toBe(1);
  });
});
