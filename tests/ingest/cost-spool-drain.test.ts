/**
 * FEAT-476 Phase 0 — drainCostSpool: drains src/capture/cost-spool.ts's
 * queue into cost_events via recordCostEvent. Mirrors
 * tests/ingest/spool-drain.test.ts's own shape for the transcript spool.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { drainCostSpool } from '../../src/ingest/cost-spool-drain.js';
import { costSpoolDir, writeCostSpoolEntry, listCostSpoolFiles } from '../../src/capture/cost-spool.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { listCostEvents } from '../../src/storage/cost-events.js';

const dirs: string[] = [];
function tempDataDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cost-spool-drain-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('drainCostSpool', () => {
  it('drains a spooled entry into cost_events and deletes the file', () => {
    const dir = tempDataDir();
    const db = makeDb();
    writeCostSpoolEntry(dir, {
      capturedAtMs: Date.now(), provider: 'anthropic', model: 'claude-sonnet-5',
      inputTokens: 10, outputTokens: 5, cacheReadInputTokens: null, cacheCreationInputTokens: null,
      stopReason: 'end_turn', truncated: false, sessionKey: 'proxy-1', agentRole: null,
    });

    const result = drainCostSpool(db, dir);
    expect(result).toEqual({ drained: 1, failed: 0, pending: 0 });
    expect(listCostSpoolFiles(dir)).toHaveLength(0);
    expect(listCostEvents(db)).toHaveLength(1);
  });

  it('an empty spool drains cleanly with zero counts', () => {
    const dir = tempDataDir();
    const db = makeDb();
    expect(drainCostSpool(db, dir)).toEqual({ drained: 0, failed: 0, pending: 0 });
  });

  it('a malformed spool file is discarded and counted as failed, without blocking the rest of the batch', () => {
    const dir = tempDataDir();
    const db = makeDb();
    mkdirSync(costSpoolDir(dir), { recursive: true });
    writeFileSync(join(costSpoolDir(dir), '1-poison.json'), 'not json');
    writeCostSpoolEntry(dir, {
      capturedAtMs: Date.now(), provider: 'anthropic', model: 'claude-sonnet-5',
      inputTokens: 1, outputTokens: 1, cacheReadInputTokens: null, cacheCreationInputTokens: null,
      stopReason: null, truncated: false, sessionKey: 'proxy-good', agentRole: null,
    });

    const result = drainCostSpool(db, dir);
    expect(result.drained).toBe(1);
    expect(result.failed).toBe(1);
    expect(listCostEvents(db)).toHaveLength(1);
  });

  it('respects maxPerTick, reporting the remainder as pending', () => {
    const dir = tempDataDir();
    const db = makeDb();
    for (let i = 0; i < 5; i++) {
      writeCostSpoolEntry(dir, {
        capturedAtMs: Date.now() + i, provider: 'anthropic', model: 'claude-sonnet-5',
        inputTokens: i, outputTokens: i, cacheReadInputTokens: null, cacheCreationInputTokens: null,
        stopReason: null, truncated: false, sessionKey: `proxy-${i}`, agentRole: null,
      });
    }
    const result = drainCostSpool(db, dir, 2);
    expect(result.drained).toBe(2);
    expect(result.pending).toBe(3);
  });

  it('draining twice in a row is idempotent — second run finds nothing left to do', () => {
    const dir = tempDataDir();
    const db = makeDb();
    writeCostSpoolEntry(dir, {
      capturedAtMs: Date.now(), provider: 'anthropic', model: 'claude-sonnet-5',
      inputTokens: 1, outputTokens: 1, cacheReadInputTokens: null, cacheCreationInputTokens: null,
      stopReason: null, truncated: false, sessionKey: 'proxy-once', agentRole: null,
    });
    drainCostSpool(db, dir);
    const second = drainCostSpool(db, dir);
    expect(second).toEqual({ drained: 0, failed: 0, pending: 0 });
    expect(listCostEvents(db)).toHaveLength(1);
  });
});
