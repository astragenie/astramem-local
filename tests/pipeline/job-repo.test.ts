import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { JobRepo, AGING_STEP_MS } from '../../src/pipeline/job-repo.js';
import type { DB } from '../../src/storage/db.js';

describe('JobRepo', () => {
  let db: DB;
  let repo: JobRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new JobRepo(db);
  });

  it('enqueue creates a pending job and returns its id', () => {
    const id = repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown>;
    expect(job).toBeTruthy();
    expect(job.state).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.kind).toBe('distill');
  });

  it('claimPending returns the oldest pending job and transitions it to running', () => {
    const id = repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });
    const claimed = repo.claimPending();
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(id);
    expect(claimed!.state).toBe('running');
    expect(claimed!.attempts).toBe(0);
  });

  it('claimPending returns null when no pending jobs exist', () => {
    const result = repo.claimPending();
    expect(result).toBeNull();
  });

  it('claimPending does not return already-running jobs', () => {
    repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });
    repo.claimPending(); // moves to running
    const second = repo.claimPending();
    expect(second).toBeNull();
  });

  it('complete transitions running job to completed', () => {
    const id = repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });
    repo.claimPending();
    repo.complete(id);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string };
    expect(job.state).toBe('completed');
  });

  it('fail transitions job to failed and increments attempts', () => {
    const id = repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' });
    repo.claimPending();
    repo.fail(id, 'something went wrong');
    const job = db.prepare('SELECT state, attempts, last_error FROM jobs WHERE id = ?').get(id) as {
      state: string; attempts: number; last_error: string;
    };
    expect(job.state).toBe('failed');
    expect(job.attempts).toBe(1);
    expect(job.last_error).toBe('something went wrong');
  });

  it('markPoison transitions job to poison', () => {
    const id = repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' });
    repo.claimPending();
    repo.markPoison(id);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string };
    expect(job.state).toBe('poison');
  });

  it('pause transitions job to paused', () => {
    const id = repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' });
    repo.claimPending();
    repo.pause(id);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string };
    expect(job.state).toBe('paused');
  });

  it('claimPending picks oldest pending job (FIFO order)', async () => {
    // small delay to ensure different created_at values
    const id1 = repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });
    // Force different timestamp by manipulating created_at directly
    const id2 = repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });
    db.prepare('UPDATE jobs SET created_at = created_at + 1 WHERE id = ?').run(id2);

    const first = repo.claimPending();
    expect(first!.id).toBe(id1);
  });

  describe('priority tiers (FEAT-482 fold, worker-starvation wave)', () => {
    it('enqueue stamps a distill (P1) job with a lower priority number than a cleanup (P5) job', () => {
      const distillId = repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' });
      const cleanupId = repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });
      const distillPriority = (db.prepare('SELECT priority FROM jobs WHERE id = ?').get(distillId) as { priority: number }).priority;
      const cleanupPriority = (db.prepare('SELECT priority FROM jobs WHERE id = ?').get(cleanupId) as { priority: number }).priority;
      expect(distillPriority).toBeLessThan(cleanupPriority);
    });

    it('priority tier wins over plain FIFO: a freshly-enqueued distill (P1) job is claimed before an older cleanup (P5) job', () => {
      const cleanupId = repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 }); // older
      const distillId = repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' }); // newer, higher tier
      void cleanupId;

      const claimed = repo.claimPending();
      expect(claimed!.id).toBe(distillId);
    });

    it('a legacy row inserted without an explicit priority (pre-058 shape) defaults to the neutral mid-tier and is still claimable', () => {
      const now = Date.now();
      db.prepare(`
        INSERT INTO jobs (id, kind, payload_json, state, attempts, last_error, created_at, updated_at)
        VALUES ('legacy-job-1', 'cleanup', '{}', 'pending', 0, NULL, ?, ?)
      `).run(now, now);

      const row = db.prepare('SELECT priority FROM jobs WHERE id = ?').get('legacy-job-1') as { priority: number };
      expect(row.priority).toBe(3); // migration 058's DEFAULT, same as JobRepo.DEFAULT_JOB_PRIORITY

      const claimed = repo.claimPending();
      expect(claimed!.id).toBe('legacy-job-1');
    });

    it('claimPending({ preferKinds }) claims a preferred-kind job even when an older, higher-priority job of another kind is pending', () => {
      repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' }); // P1, older
      const cleanupId = repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 }); // P5, newer

      const claimed = repo.claimPending({ preferKinds: ['cleanup'] });
      expect(claimed!.id).toBe(cleanupId);
    });

    it('claimPending({ preferKinds }) falls back to normal any-kind ordering when no preferred-kind job is pending', () => {
      const distillId = repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' });

      const claimed = repo.claimPending({ preferKinds: ['cleanup'] });
      expect(claimed!.id).toBe(distillId);
    });

    it('fairness: an aged low-priority job is selected ahead of a constant stream of fresh P1 arrivals', () => {
      // Backdate a cleanup (P5) job well past the aging threshold — 5 full
      // steps drops its EFFECTIVE priority (5 - 5 = 0) below every fresh
      // arrival's own base tier (age ~0), so it must win regardless of how
      // many P1 jobs keep arriving after it.
      const agedId = repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });
      db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?')
        .run(Date.now() - AGING_STEP_MS * 5, agedId);

      // A constant stream of fresh P1 (distill) arrivals, enqueued AFTER the
      // aged job — exactly the scenario naive priority-only ordering would
      // starve it under.
      for (let i = 0; i < 10; i++) {
        repo.enqueue('distill', { kind: 'distill', transcript_id: `t${i}`, session_id: `s${i}` });
      }

      const claimed = repo.claimPending();
      expect(claimed!.id).toBe(agedId);
    });

    it('fairness floor: a fresh (unaged) low-priority job does NOT jump ahead of a fresh P1 job', () => {
      // Sanity control for the fairness test above — without any aging, tier
      // ordering must still hold: proves the aging term isn't so aggressive
      // that it distorts ordering for jobs that haven't actually waited.
      repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });
      const distillId = repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' });

      const claimed = repo.claimPending();
      expect(claimed!.id).toBe(distillId);
    });
  });
});
