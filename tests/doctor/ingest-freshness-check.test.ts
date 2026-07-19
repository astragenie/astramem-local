/**
 * tests/doctor/ingest-freshness-check.test.ts
 *
 * FEAT-483 SLICE-2: the "Ingest freshness" doctor row — the live-daemon
 * complement to the "Extraction yield" 7-day-rate canary
 * (tests/doctor/extraction-yield-check.test.ts). This check answers a
 * different, shorter-horizon question: is ingest -> memory flow alive on
 * THIS running daemon RIGHT NOW (a 5-minute SLA), not "what was the rate
 * over the last week".
 *
 * Uses a real on-disk memory.sqlite (same pattern as
 * tests/doctor/extraction-yield-check.test.ts) since the check opens
 * `join(dataDir, 'memory.sqlite')` via openProductionDbReadonly. Backdates
 * rows via a raw UPDATE (recordExtractionYield always stamps Date.now()) —
 * same technique tests/doctor/auto-capture-check.test.ts uses to control
 * `created_at` for window-boundary assertions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChecks } from '../../src/doctor/checks.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { recordExtractionYield } from '../../src/storage/extraction-yield-log.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

function checkFor(dir: string) {
  return findCheck(
    getChecks({ dataDir: dir, encryptionEnabled: false }),
    'Ingest freshness',
  );
}

/** Records an extraction-yield row, then backdates it to `msAgo` milliseconds
 *  before now — recordExtractionYield always stamps Date.now(), so this is
 *  the only way to place a row inside/outside the 5-minute SLA window. */
function recordAt(db: ReturnType<typeof openDb>, msAgo: number, chunksIn: number, atomsOut: number) {
  recordExtractionYield(db, { sessionId: `s-${Math.random()}`, chunksIn, atomsOut });
  db.prepare('UPDATE extraction_yield SET created_at = ? WHERE id = (SELECT MAX(id) FROM extraction_yield)')
    .run(Date.now() - msAgo);
}

const FIVE_MIN_MS = 5 * 60 * 1000;

describe('doctor "Ingest freshness" check (FEAT-483 S2 live-SLA canary)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-ingest-freshness-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no DB yet — ok:true, informational', async () => {
    const result = await checkFor(dir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no DB yet');
  });

  it('DB file exists but has not been migrated (query hits a missing table) — inconclusive, not a clean bill of health', async () => {
    openDb(join(dir, 'memory.sqlite')).close();
    const result = await checkFor(dir).run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('check error (non-fatal)');
  });

  it('below MEANINGFUL_USAGE_THRESHOLD 7d activity — ok:true, not enough history to judge, even with a live-looking stall', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    // Only 5 eligible runs in the whole 7d window (well under the 20 floor),
    // all recent and all zero-yield — must NOT read as a stall; there simply
    // isn't enough history yet to trust a live judgment.
    for (let i = 0; i < 5; i++) {
      recordAt(db, 60_000, 2, 0);
    }
    db.close();

    const result = await checkFor(dir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough distill activity');
    expect(result.message).toContain('5 eligible run(s)');
  });

  it('>= threshold 7d activity, but NO ingest activity in the last 5 min — quiet, not alarming', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    // 25 healthy eligible runs, all OUTSIDE the 5-minute SLA window (10 min ago).
    for (let i = 0; i < 25; i++) {
      recordAt(db, 10 * 60_000, 2, 3);
    }
    db.close();

    const result = await checkFor(dir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no ingest activity in the last 5 min');
    expect(result.message).toContain('nothing to distill');
  });

  it('>= threshold 7d activity, ingest activity in the last 5 min, ALL produced memories — flowing normally', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    // 20 runs to cross the 7d floor, all recent (within the SLA window) and all yielded atoms.
    for (let i = 0; i < 20; i++) {
      recordAt(db, 60_000, 2, 3);
    }
    db.close();

    const result = await checkFor(dir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('flowing normally');
    expect(result.message).toContain('20/20');
  });

  it('>= threshold 7d activity, ingest activity in the last 5 min but ZERO produced memories — RED: the pipeline appears stalled', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    // 20 runs to cross the 7d floor, all recent (within SLA window), none yielded atoms.
    for (let i = 0; i < 20; i++) {
      recordAt(db, 60_000, 2, 0);
    }
    db.close();

    const result = await checkFor(dir).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('pipeline appears stalled');
    expect(result.message).toContain('20 distill job(s)');
    expect(result.fix).toBeDefined();
  });

  it('mixed window: recent ingest activity with SOME (not all) producing memories — stays GREEN, at least one made it through', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    for (let i = 0; i < 15; i++) {
      recordAt(db, 60_000, 2, 0); // recent, zero-yield
    }
    for (let i = 0; i < 5; i++) {
      recordAt(db, 60_000, 2, 3); // recent, yielded
    }
    db.close();

    const result = await checkFor(dir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('flowing normally');
    expect(result.message).toContain('5/20');
  });

  it('boundary: a stale run just outside the SLA window is not counted as recent ingest activity', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    // Cross the 7d floor with old activity...
    for (let i = 0; i < 20; i++) {
      recordAt(db, FIVE_MIN_MS + 60_000, 2, 3); // just outside the 5-min SLA window
    }
    db.close();

    const result = await checkFor(dir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no ingest activity in the last 5 min');
  });
});
