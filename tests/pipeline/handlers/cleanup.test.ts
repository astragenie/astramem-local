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
});
