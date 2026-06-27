import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { JobRepo } from '../../src/pipeline/job-repo.js';
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
});
