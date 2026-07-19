/**
 * tests/storage/triage-guard-log.test.ts
 *
 * Round-trip coverage for triage_guard_drops/triage_run_log (migration 052,
 * FEAT-533) — extended with corrected_type/evidence_supported (migration
 * 054, FEAT-547 v2). Asserts DB ROWS directly (not in-memory counters) —
 * the exact gap FEAT-551's review round found: its own guard-drop writer
 * was imported and never called, and the only reason it slipped through
 * 721 green tests was that the sibling test block asserted on result counts
 * without ever querying the new tables. This file exists so
 * recordTriageGuardDrops' new columns have that same direct DB-row
 * assertion from day one, not bolted on after a needs_fix round.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import {
  recordTriageGuardDrops,
  recordTriageRunLog,
  totalAtomsTriaged,
  totalAtomsDropped,
  triageDropRate,
} from '../../src/storage/triage-guard-log.js';
import type { DB } from '../../src/storage/db.js';

describe('triage-guard-log', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('records a plain non-keep verdict row with corrected_type/evidence_supported left NULL (pre-FEAT-547 shape, unaffected)', () => {
    recordTriageGuardDrops(db, [
      { reason: 'junk', memoryId: null, model: 'test-model', confidence: 0.9, mode: 'enabled', sessionId: 's1' },
    ]);

    const rows = db.prepare(
      'SELECT reason, memory_id, model, confidence, mode, session_id, corrected_type, evidence_supported FROM triage_guard_drops',
    ).all() as any[];
    expect(rows).toEqual([
      {
        reason: 'junk', memory_id: null, model: 'test-model', confidence: 0.9, mode: 'enabled',
        session_id: 's1', corrected_type: null, evidence_supported: null,
      },
    ]);
  });

  it('FEAT-547: records corrected_type and evidence_supported (true/false) verbatim on a "keep" row', () => {
    recordTriageGuardDrops(db, [
      {
        reason: 'keep', memoryId: 'mem-1', model: 'phi4-mini', confidence: 0.85, mode: 'enabled', sessionId: 's1',
        correctedType: 'event', evidenceSupported: true,
      },
      {
        reason: 'keep', memoryId: 'mem-2', model: 'phi4-mini', confidence: 0.9, mode: 'enabled', sessionId: 's1',
        correctedType: null, evidenceSupported: false,
      },
    ]);

    const rows = db.prepare(
      'SELECT memory_id, corrected_type, evidence_supported FROM triage_guard_drops ORDER BY memory_id',
    ).all() as any[];
    expect(rows).toEqual([
      { memory_id: 'mem-1', corrected_type: 'event', evidence_supported: 1 },
      { memory_id: 'mem-2', corrected_type: null, evidence_supported: 0 },
    ]);
  });

  it('omitting correctedType/evidenceSupported entirely (undefined, not just null) also stores NULL — backward-compatible call shape', () => {
    recordTriageGuardDrops(db, [
      { reason: 'meta-echo', memoryId: null, model: 'test-model', confidence: 0.7, mode: 'enabled', sessionId: null },
    ]);
    const row = db.prepare('SELECT corrected_type, evidence_supported FROM triage_guard_drops').get() as any;
    expect(row.corrected_type).toBeNull();
    expect(row.evidence_supported).toBeNull();
  });

  it('run-log + rate readers are unaffected by the v2 columns', () => {
    recordTriageRunLog(db, { sessionId: 's1', atomsTriaged: 10, atomsDropped: 3 });
    expect(totalAtomsTriaged(db)).toBe(10);
    expect(totalAtomsDropped(db)).toBe(3);
    expect(triageDropRate(db)).toBeCloseTo(0.3, 5);
  });
});
