import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { defaultConfig, type Config } from '../../src/config/config.js';
import { pruneIngestIdempotency, backfillSummaryMemoryId } from '../../src/storage/ingest-idempotency.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function insertRow(db: DB, key: string, createdAt: number, summaryMemoryId = key): void {
  db.prepare(`
    INSERT INTO ingest_idempotency (key, body_hash, summary_memory_id, created_at)
    VALUES (?, 'hash', ?, ?)
  `).run(key, summaryMemoryId, createdAt);
}

function getRow(db: DB, key: string): { key: string; summary_memory_id: string | null } | undefined {
  return db.prepare('SELECT key, summary_memory_id FROM ingest_idempotency WHERE key = ?').get(key) as
    { key: string; summary_memory_id: string | null } | undefined;
}

describe('FEAT-432 pruneIngestIdempotency — config defaults', () => {
  it('defaults ingestIdempotency.retentionDays to 7', () => {
    const cfg = defaultConfig();
    expect(cfg.ingestIdempotency).toEqual({ retentionDays: 7 });
  });
});

describe('FEAT-432 pruneIngestIdempotency', () => {
  let db: DB;
  let config: Config;
  const now = Date.now();

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    config = defaultConfig();
  });

  it('deletes rows older than the configured retention window', () => {
    insertRow(db, 'old-key', now - 8 * DAY_MS); // older than default 7d
    insertRow(db, 'recent-key', now - 1 * DAY_MS);

    const result = pruneIngestIdempotency(db, config, now);

    expect(result.pruned).toBe(1);
    expect(getRow(db, 'old-key')).toBeUndefined();
    expect(getRow(db, 'recent-key')).toBeDefined();
  });

  it('is a no-op when every row is within the retention window', () => {
    insertRow(db, 'a', now - 1 * DAY_MS);
    insertRow(db, 'b', now - 6 * DAY_MS);

    const result = pruneIngestIdempotency(db, config, now);

    expect(result.pruned).toBe(0);
    expect(getRow(db, 'a')).toBeDefined();
    expect(getRow(db, 'b')).toBeDefined();
  });

  it('handles an empty table gracefully', () => {
    const result = pruneIngestIdempotency(db, config, now);
    expect(result.pruned).toBe(0);
  });

  it('honors a custom retentionDays value', () => {
    insertRow(db, 'three-days-old', now - 3 * DAY_MS);
    insertRow(db, 'eight-days-old', now - 8 * DAY_MS);

    const shortTtl: Config = { ...config, ingestIdempotency: { retentionDays: 5 } };
    const result = pruneIngestIdempotency(db, shortTtl, now);

    expect(result.pruned).toBe(1);
    expect(getRow(db, 'three-days-old')).toBeDefined();
    expect(getRow(db, 'eight-days-old')).toBeUndefined();
  });

  it('replay still resolves for a row within the TTL — idempotency is preserved', () => {
    // Simulates the ingest route's replay check (SELECT body_hash,
    // summary_memory_id FROM ingest_idempotency WHERE key = ?): a row
    // within the retention window must still be readable after a prune
    // pass runs, so a client retry keeps getting its idempotent 200.
    insertRow(db, 'replay-key', now - 2 * DAY_MS, 'memory-123');

    pruneIngestIdempotency(db, config, now);

    const row = db.prepare('SELECT body_hash, summary_memory_id FROM ingest_idempotency WHERE key = ?')
      .get('replay-key') as { body_hash: string; summary_memory_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.summary_memory_id).toBe('memory-123');
  });

  it('does not disturb the D-DEF2 summary_memory_id backfill for rows within the TTL', () => {
    insertRow(db, 'placeholder-key', now - 1 * DAY_MS, 'transcript-abc');

    backfillSummaryMemoryId(db, 'transcript-abc', 'memory-real');
    pruneIngestIdempotency(db, config, now);

    expect(getRow(db, 'placeholder-key')?.summary_memory_id).toBe('memory-real');
  });
});
