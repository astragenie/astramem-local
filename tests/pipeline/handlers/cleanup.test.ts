import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../../src/storage/db.js';
import { migrate } from '../../../src/storage/migrate.js';
import { cleanupHandler } from '../../../src/pipeline/handlers/cleanup.js';
import { defaultConfig } from '../../../src/config/config.js';
import type { DB } from '../../../src/storage/db.js';
import type { HandlerCtx } from '../../../src/pipeline/handler.js';
import type { CleanupPayload } from '../../../src/contracts/index.js';

function insertCompletedJob(db: DB, id: string, updatedAt: number): void {
  db.prepare(`
    INSERT INTO jobs (id, kind, payload_json, state, attempts, last_error, created_at, updated_at)
    VALUES (?, 'cleanup', '{"kind":"cleanup","older_than_days":30}', 'completed', 0, NULL, ?, ?)
  `).run(id, updatedAt, updatedAt);
}

function insertPendingJob(db: DB, id: string, updatedAt: number): void {
  db.prepare(`
    INSERT INTO jobs (id, kind, payload_json, state, attempts, last_error, created_at, updated_at)
    VALUES (?, 'distill', '{"kind":"distill","transcript_id":"t1","session_id":"s1"}', 'pending', 0, NULL, ?, ?)
  `).run(id, updatedAt, updatedAt);
}

describe('cleanupHandler', () => {
  let db: DB;
  let ctx: HandlerCtx;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    ctx = { db, config: defaultConfig() };
  });

  it('removes completed jobs older than older_than_days', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const oldTs = now - 31 * DAY_MS;  // 31 days ago — should be pruned
    const newTs = now - 1 * DAY_MS;   // 1 day ago — should be kept

    insertCompletedJob(db, 'old-job', oldTs);
    insertCompletedJob(db, 'new-job', newTs);

    const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
    await cleanupHandler.handle(payload, ctx);

    const remaining = db.prepare("SELECT id FROM jobs WHERE state = 'completed'").all() as { id: string }[];
    const ids = remaining.map(r => r.id);
    expect(ids).not.toContain('old-job');
    expect(ids).toContain('new-job');
  });

  it('does not remove non-completed jobs regardless of age', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const oldTs = Date.now() - 60 * DAY_MS; // very old

    insertPendingJob(db, 'old-pending', oldTs);

    const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
    await cleanupHandler.handle(payload, ctx);

    const remaining = db.prepare("SELECT id FROM jobs").all() as { id: string }[];
    const ids = remaining.map(r => r.id);
    expect(ids).toContain('old-pending');
  });

  it('removes zero rows when nothing is old enough', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const recentTs = Date.now() - 5 * DAY_MS; // only 5 days old

    insertCompletedJob(db, 'recent-job', recentTs);

    const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
    await cleanupHandler.handle(payload, ctx);

    const remaining = db.prepare("SELECT id FROM jobs WHERE state = 'completed'").all() as { id: string }[];
    expect(remaining.map(r => r.id)).toContain('recent-job');
  });

  it('handles empty table gracefully', async () => {
    const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
    await expect(cleanupHandler.handle(payload, ctx)).resolves.toBeUndefined();
  });

  it('uses older_than_days from payload', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    insertCompletedJob(db, 'three-days-old', now - 3 * DAY_MS);
    insertCompletedJob(db, 'eight-days-old', now - 8 * DAY_MS);

    // prune only jobs older than 7 days
    const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 7 };
    await cleanupHandler.handle(payload, ctx);

    const remaining = db.prepare("SELECT id FROM jobs WHERE state = 'completed'").all() as { id: string }[];
    const ids = remaining.map(r => r.id);
    expect(ids).toContain('three-days-old');
    expect(ids).not.toContain('eight-days-old');
  });

  describe('ingest_idempotency retention (FEAT-432)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    function insertIdempotencyRow(id: string, createdAt: number): void {
      db.prepare(`
        INSERT INTO ingest_idempotency (key, body_hash, summary_memory_id, created_at)
        VALUES (?, 'hash', ?, ?)
      `).run(id, id, createdAt);
    }

    it('prunes rows older than config.ingestIdempotency.retentionDays and keeps recent ones', async () => {
      const now = Date.now();
      insertIdempotencyRow('old-key', now - 8 * DAY_MS);   // older than default 7d — pruned
      insertIdempotencyRow('recent-key', now - 1 * DAY_MS); // within window — kept

      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, ctx);

      const remaining = db.prepare('SELECT key FROM ingest_idempotency').all() as { key: string }[];
      const keys = remaining.map(r => r.key);
      expect(keys).not.toContain('old-key');
      expect(keys).toContain('recent-key');
    });

    it('keeps a row that is still within the configured retention window (replay stays safe)', async () => {
      const now = Date.now();
      const withinWindowTs = now - 6 * DAY_MS; // within default 7-day TTL
      insertIdempotencyRow('within-window-key', withinWindowTs);

      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, ctx);

      const row = db.prepare('SELECT key, body_hash, summary_memory_id FROM ingest_idempotency WHERE key = ?')
        .get('within-window-key') as { key: string; body_hash: string; summary_memory_id: string } | undefined;

      // Row survives the prune, so a replay within the TTL still resolves —
      // idempotent-replay behavior is unchanged for anything inside the window.
      expect(row).toBeDefined();
      expect(row?.summary_memory_id).toBe('within-window-key');
    });

    it('respects a configured retentionDays value other than the default', async () => {
      const now = Date.now();
      insertIdempotencyRow('three-days-old', now - 3 * DAY_MS);
      insertIdempotencyRow('eight-days-old', now - 8 * DAY_MS);

      const customCtx: HandlerCtx = {
        db,
        config: { ...defaultConfig(), ingestIdempotency: { retentionDays: 5 } },
      };
      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, customCtx);

      const remaining = db.prepare('SELECT key FROM ingest_idempotency').all() as { key: string }[];
      const keys = remaining.map(r => r.key);
      expect(keys).toContain('three-days-old');
      expect(keys).not.toContain('eight-days-old');
    });
  });

  // Issue #209: the durable safety net behind the write-time retry-job
  // enqueue — every memory still flagged needs_vec_index gets a `reembed`
  // job on this same 24h tick (ADR-015 §4: reuse the existing cadence
  // rather than a new timer).
  describe('vec-index sweep (issue #209)', () => {
    function insertMemory(db: DB, id: string, needsVecIndex: boolean): void {
      const now = Date.now();
      db.prepare(`
        INSERT INTO memories
          (id, type, text, normalized_text, hash, importance, confidence,
           created_at, updated_at, valid_from, scope, needs_vec_index)
        VALUES (?, 'fact', 'x', 'x', ?, 0.5, 0.5, ?, ?, ?, 'private', ?)
      `).run(id, id, now, now, now, needsVecIndex ? 1 : 0);
    }

    it('enqueues a reembed job for every needs_vec_index=1 memory', async () => {
      insertMemory(db, 'mem-flagged-1', true);
      insertMemory(db, 'mem-flagged-2', true);
      insertMemory(db, 'mem-not-flagged', false);

      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, ctx);

      const jobs = db.prepare("SELECT payload_json FROM jobs WHERE kind = 'reembed'").all() as { payload_json: string }[];
      const enqueuedIds = jobs.map(j => (JSON.parse(j.payload_json) as { memory_id: string }).memory_id).sort();
      expect(enqueuedIds).toEqual(['mem-flagged-1', 'mem-flagged-2']);
    });

    it('does not enqueue anything when no memory is flagged', async () => {
      insertMemory(db, 'mem-clean-1', false);

      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, ctx);

      const count = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'reembed'").get() as { n: number }).n;
      expect(count).toBe(0);
    });

    it('caps the sweep at VEC_INDEX_SWEEP_LIMIT (500) per pass', async () => {
      for (let i = 0; i < 501; i++) insertMemory(db, `mem-bulk-${i}`, true);

      const payload: CleanupPayload = { kind: 'cleanup', older_than_days: 30 };
      await cleanupHandler.handle(payload, ctx);

      const count = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'reembed'").get() as { n: number }).n;
      expect(count).toBe(500);
    });
  });
});
