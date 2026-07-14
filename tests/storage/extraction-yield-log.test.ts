/**
 * tests/storage/extraction-yield-log.test.ts
 *
 * Round-trip coverage for the extraction_yield write/read pair (migration
 * 042) — the ADR-015 zero-atom-yield canary's data layer. Mirrors the
 * relation-guard-log field-for-field shape but records EVERY run (including
 * zero-atom ones — that IS the signal), unlike recordRelationGuardDrops'
 * "skip if empty" no-op guard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import {
  recordExtractionYield,
  totalYield,
  zeroYieldCount,
  zeroYieldRate,
} from '../../src/storage/extraction-yield-log.js';
import type { DB } from '../../src/storage/db.js';

describe('extraction-yield-log', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('records a healthy run and a zero-atom run round-trips through the reader', () => {
    recordExtractionYield(db, { sessionId: 's1', chunksIn: 3, atomsOut: 5 });
    recordExtractionYield(db, { sessionId: 's2', chunksIn: 2, atomsOut: 0 });

    const rows = db.prepare('SELECT session_id, chunks_in, atoms_out FROM extraction_yield ORDER BY id').all() as any[];
    expect(rows).toEqual([
      { session_id: 's1', chunks_in: 3, atoms_out: 5 },
      { session_id: 's2', chunks_in: 2, atoms_out: 0 },
    ]);

    expect(totalYield(db)).toBe(2);
    expect(zeroYieldCount(db)).toBe(1);
    expect(zeroYieldRate(db)).toBeCloseTo(0.5);
  });

  it('zeroYieldRate returns null when there is no eligible (chunks_in > 0) run in the window', () => {
    expect(zeroYieldRate(db)).toBeNull();
    expect(totalYield(db)).toBe(0);
    expect(zeroYieldCount(db)).toBe(0);
  });

  it('a run with zero chunks in is not counted as an eligible zero-yield run', () => {
    recordExtractionYield(db, { sessionId: null, chunksIn: 0, atomsOut: 0 });
    // Recorded (totalYield counts every row)...
    expect(totalYield(db)).toBe(1);
    // ...but not eligible for the rate, since there was nothing to extract from.
    expect(zeroYieldRate(db)).toBeNull();
  });

  it('sinceMs filters out rows recorded before the window', () => {
    recordExtractionYield(db, { sessionId: 's1', chunksIn: 2, atomsOut: 0 });
    const cutoff = Date.now() + 1000;
    expect(totalYield(db, cutoff)).toBe(0);
    expect(zeroYieldRate(db, cutoff)).toBeNull();
  });

  it('a healthy run with atoms_out > 0 does not count toward zeroYieldCount', () => {
    for (let i = 0; i < 5; i++) {
      recordExtractionYield(db, { sessionId: `s${i}`, chunksIn: 1, atomsOut: 2 });
    }
    expect(totalYield(db)).toBe(5);
    expect(zeroYieldCount(db)).toBe(0);
    expect(zeroYieldRate(db)).toBe(0);
  });
});
