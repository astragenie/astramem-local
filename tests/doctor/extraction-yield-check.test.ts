/**
 * tests/doctor/extraction-yield-check.test.ts
 *
 * ADR-015 headline finding: the "Extraction yield" doctor row — the
 * zero-atom-yield canary. A well-formed `{"atoms":[]}` extraction completes
 * as SUCCESS at every other layer, so a broken model and a genuinely empty
 * transcript are indistinguishable anywhere else. This check is the only
 * place that distinction becomes observable, via a zero-yield RATE over a
 * recent window (not existence of a single row — see
 * canary-must-measure-rate-not-existence).
 *
 * Uses a real on-disk memory.sqlite (same pattern as
 * tests/doctor/entity-relations-check.test.ts) since the check opens
 * `join(dataDir, 'memory.sqlite')` via openProductionDbReadonly.
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
    'Extraction yield',
  );
}

describe('doctor "Extraction yield" check (ADR-015 zero-atom-yield canary)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-extraction-yield-'));
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

  it('below MEANINGFUL_USAGE_THRESHOLD runs — ok:true, not enough activity to judge', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    for (let i = 0; i < 5; i++) {
      recordExtractionYield(db, { sessionId: `s${i}`, chunksIn: 2, atomsOut: 0 });
    }
    db.close();

    const result = await checkFor(dir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough distill activity');
    expect(result.message).toContain('5 eligible run(s)');
  });

  it('>= threshold runs, healthy yield (below the alarm floor) — stays quiet', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    // 25 runs, only 2 zero-atom — 8% zero-yield rate, well under the 50% floor.
    for (let i = 0; i < 23; i++) {
      recordExtractionYield(db, { sessionId: `healthy${i}`, chunksIn: 2, atomsOut: 3 });
    }
    for (let i = 0; i < 2; i++) {
      recordExtractionYield(db, { sessionId: `zero${i}`, chunksIn: 2, atomsOut: 0 });
    }
    db.close();

    const result = await checkFor(dir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('zero-atom rate');
    expect(result.message).toContain('below the');
  });

  it('>= threshold runs, majority zero-atom — WARN: the zero-yield canary fires', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    // 25 runs, 20 zero-atom — 80% zero-yield rate, over the 50% floor.
    for (let i = 0; i < 20; i++) {
      recordExtractionYield(db, { sessionId: `zero${i}`, chunksIn: 2, atomsOut: 0 });
    }
    for (let i = 0; i < 5; i++) {
      recordExtractionYield(db, { sessionId: `healthy${i}`, chunksIn: 2, atomsOut: 3 });
    }
    db.close();

    const result = await checkFor(dir).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('produced ZERO atoms');
    expect(result.message).toContain('20/25 eligible runs');
    expect(result.fix).toBeDefined();
  });

  it('>= threshold TOTAL rows but all have zero chunks in — 0 eligible, stays ok:true as "not enough activity"', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    for (let i = 0; i < 25; i++) {
      recordExtractionYield(db, { sessionId: `empty${i}`, chunksIn: 0, atomsOut: 0 });
    }
    db.close();

    const result = await checkFor(dir).run();
    expect(result.ok).toBe(true);
    // 25 total rows but 0 eligible (chunks_in > 0) -- eligible count, not the raw row
    // count, gates this check, so 0 eligible reads as "not enough activity", not a
    // separate "nothing to judge" branch (#300 review finding).
    expect(result.message).toContain('not enough distill activity');
    expect(result.message).toContain('0 eligible run(s)');
  });

  it('MIXED window: 25 rows, only 8 eligible (chunks_in > 0), all 8 zero-atom — ' +
    'must NOT warn (eligible 8 < threshold 20) and the message denominator must read 8, not 25', async () => {
    const dbPath = join(dir, 'memory.sqlite');
    const db = openDb(dbPath);
    migrate(db);
    // 17 zero-chunk rows -- not real extraction attempts, must not count toward the floor.
    for (let i = 0; i < 17; i++) {
      recordExtractionYield(db, { sessionId: `empty${i}`, chunksIn: 0, atomsOut: 0 });
    }
    // 8 eligible rows, all zero-atom -- would be a 100% zero-yield rate IF judged, but
    // the eligible sample (8) is below the MEANINGFUL_USAGE_THRESHOLD (20) floor.
    for (let i = 0; i < 8; i++) {
      recordExtractionYield(db, { sessionId: `zero${i}`, chunksIn: 2, atomsOut: 0 });
    }
    db.close();

    const result = await checkFor(dir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough distill activity');
    expect(result.message).toContain('8 eligible run(s)');
    // The 25-row total must never leak into the message as the denominator.
    expect(result.message).not.toContain('25');
  });
});
