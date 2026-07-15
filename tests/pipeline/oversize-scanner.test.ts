// FEAT-507: oversize-atom repair scanner.

import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { JobRepo } from '../../src/pipeline/job-repo.js';
import { scanAndEnqueueOversizeRepairs } from '../../src/pipeline/oversize-scanner.js';
import { EMBED_MAX_INPUT_CHARS } from '../../src/pipeline/oversize.js';
import type { DB } from '../../src/storage/db.js';

function insertMemory(db: DB, hash: string, text: string, needsVecIndex: boolean): string {
  const repo = new MemoryRepo(db);
  const id = repo.insert({
    type: 'fact', text, normalized_text: text, hash,
    repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null,
  });
  if (needsVecIndex) repo.markNeedsVecIndex(id);
  return id;
}

function reembedJobIds(db: DB): string[] {
  const rows = db.prepare("SELECT payload_json FROM jobs WHERE kind = 'reembed'").all() as { payload_json: string }[];
  return rows.map(r => (JSON.parse(r.payload_json) as { memory_id: string }).memory_id);
}

describe('scanAndEnqueueOversizeRepairs (FEAT-507)', () => {
  it('enqueues a reembed job only for memories that are BOTH oversize and flagged needs_vec_index', () => {
    const db = openDb(':memory:');
    migrate(db);

    const oversizeText = 'x'.repeat(EMBED_MAX_INPUT_CHARS + 500);
    const smallText = 'x'.repeat(10);

    const oversizeFlagged = insertMemory(db, 'scan-oversize-flagged', oversizeText, true);
    insertMemory(db, 'scan-oversize-clean', oversizeText, false); // already indexed — must not enqueue
    insertMemory(db, 'scan-small-flagged', smallText, true); // flagged but not oversize — must not enqueue

    const result = scanAndEnqueueOversizeRepairs(db);

    expect(result.enqueued).toBe(1);
    expect(result.candidates).toBe(1);
    expect(result.alreadyQueued).toBe(0);
    expect(reembedJobIds(db)).toEqual([oversizeFlagged]);
  });

  it('is idempotent — a memory with an already-pending reembed job is not double-enqueued', () => {
    const db = openDb(':memory:');
    migrate(db);
    const jobRepo = new JobRepo(db);

    const oversizeText = 'x'.repeat(EMBED_MAX_INPUT_CHARS + 500);
    const id = insertMemory(db, 'scan-idempotent-1', oversizeText, true);
    jobRepo.enqueue('reembed', { kind: 'reembed', memory_id: id }); // simulate an in-flight job

    const result = scanAndEnqueueOversizeRepairs(db);

    expect(result.enqueued).toBe(0);
    expect(result.alreadyQueued).toBe(1);
    // Still exactly one reembed job for this memory, not two.
    expect(reembedJobIds(db)).toEqual([id]);
  });

  it('re-running the scan twice does not double-enqueue', () => {
    const db = openDb(':memory:');
    migrate(db);

    const oversizeText = 'x'.repeat(EMBED_MAX_INPUT_CHARS + 500);
    const id = insertMemory(db, 'scan-rerun-1', oversizeText, true);

    const first = scanAndEnqueueOversizeRepairs(db);
    expect(first.enqueued).toBe(1);

    const second = scanAndEnqueueOversizeRepairs(db);
    expect(second.enqueued).toBe(0);
    expect(second.alreadyQueued).toBe(1);
    expect(reembedJobIds(db)).toEqual([id]);
  });

  it('a memory whose existing reembed job is completed (not pending/running) is re-enqueued', () => {
    const db = openDb(':memory:');
    migrate(db);
    const jobRepo = new JobRepo(db);

    const oversizeText = 'x'.repeat(EMBED_MAX_INPUT_CHARS + 500);
    const id = insertMemory(db, 'scan-completed-job-1', oversizeText, true);
    const jobId = jobRepo.enqueue('reembed', { kind: 'reembed', memory_id: id });
    jobRepo.complete(jobId); // job finished (e.g. an old poison→purge cycle) but needs_vec_index never cleared

    const result = scanAndEnqueueOversizeRepairs(db);

    expect(result.enqueued).toBe(1);
    expect(reembedJobIds(db)).toEqual([id, id]);
  });

  it('a memory whose existing reembed job is failed (not yet terminal) is not re-enqueued', () => {
    const db = openDb(':memory:');
    migrate(db);
    const jobRepo = new JobRepo(db);

    const oversizeText = 'x'.repeat(EMBED_MAX_INPUT_CHARS + 500);
    const id = insertMemory(db, 'scan-failed-job-1', oversizeText, true);
    const jobId = jobRepo.enqueue('reembed', { kind: 'reembed', memory_id: id });
    jobRepo.fail(jobId, 'transient error'); // still retryable — self-promotes back to pending on backoff

    const result = scanAndEnqueueOversizeRepairs(db);

    expect(result.enqueued).toBe(0);
    expect(result.alreadyQueued).toBe(1);
    expect(reembedJobIds(db)).toEqual([id]);
  });

  it('does nothing when there are no candidates', () => {
    const db = openDb(':memory:');
    migrate(db);
    insertMemory(db, 'scan-clean-1', 'a short memory', false);

    const result = scanAndEnqueueOversizeRepairs(db);

    expect(result).toEqual({ candidates: 0, enqueued: 0, alreadyQueued: 0 });
    expect(reembedJobIds(db)).toHaveLength(0);
  });

  it('caps a large backlog at the configured limit per pass', () => {
    const db = openDb(':memory:');
    migrate(db);
    const oversizeText = 'x'.repeat(EMBED_MAX_INPUT_CHARS + 500);
    for (let i = 0; i < 5; i++) insertMemory(db, `scan-cap-${i}`, oversizeText, true);

    const result = scanAndEnqueueOversizeRepairs(db, 3);

    expect(result.candidates).toBe(3);
    expect(result.enqueued).toBe(3);
  });
});
