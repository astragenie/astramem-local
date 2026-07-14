// FEAT-495 item 3 — memory_events.payload_json is fed by BOTH local writers
// (MemoryEventRepo.append) and the sync pull path (src/sync/puller.ts's
// dedupInsertEvent, which trusts a remote device's payload verbatim). A
// single malformed row must not break a shared query that scans/aggregates
// across many rows. These tests insert a deliberately malformed row directly
// (bypassing JSON.stringify) to simulate exactly that — a row a buggy or
// compromised remote device shipped, or local bit-rot — and assert the
// shared read paths degrade gracefully instead of throwing.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { safeJsonColumn, safeParseEventPayload } from '../../src/storage/json-guard.js';
import { usefulnessRate, feedbackLoopSummary, usefulnessScores } from '../../src/storage/usefulness.js';
import { listUnsynced, countUnsynced, buildEnvelope } from '../../src/sync/shipper.js';
import { recomputeProjection } from '../../src/sync/conflict-resolve.js';

function seedAtom(db: DB, hash: string, scope: 'private' | 'team' | 'org' = 'team'): string {
  return new MemoryRepo(db).insert({
    type: 'fact',
    text: `text ${hash}`,
    normalized_text: `text ${hash}`,
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null, scope,
  });
}

/** Insert a memory_events row with deliberately malformed JSON in payload_json
 *  — the shape puller.ts's dedupInsertEvent would produce for a corrupted
 *  remote row, or that bit-rot could produce for a local one. */
function insertMalformedEvent(db: DB, atomId: string, eventType: string, createdAt: number): void {
  db.prepare(
    `INSERT INTO memory_events (event_id, event_type, atom_id, payload_json, content_hash, created_at)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(`malformed-${atomId}-${eventType}`, eventType, atomId, '{not valid json', createdAt);
}

describe('safeJsonColumn', () => {
  let db: DB;
  beforeEach(() => { db = openDb(':memory:'); });

  it('json_extract throws on malformed JSON when unguarded (documents the underlying bug)', () => {
    expect(() => db.prepare(`SELECT json_extract('{not valid json', '$.x') AS v`).get()).toThrow(/malformed JSON/);
  });

  it('guarded json_extract returns NULL instead of throwing', () => {
    const row = db.prepare(`SELECT json_extract(${safeJsonColumn("'{not valid json'")}, '$.x') AS v`).get() as { v: unknown };
    expect(row.v).toBeNull();
  });

  it('guarded json_extract is unaffected for valid JSON', () => {
    const row = db.prepare(`SELECT json_extract(${safeJsonColumn("'{\"x\":1}'")}, '$.x') AS v`).get() as { v: unknown };
    expect(row.v).toBe(1);
  });
});

describe('safeParseEventPayload', () => {
  it('returns null and invokes onError for malformed JSON, without throwing', () => {
    let captured: unknown;
    const result = safeParseEventPayload('{not valid json', err => { captured = err; });
    expect(result).toBeNull();
    expect(captured).toBeDefined();
  });

  it('returns null for a null input without invoking onError', () => {
    let called = false;
    const result = safeParseEventPayload(null, () => { called = true; });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it('parses valid JSON normally', () => {
    expect(safeParseEventPayload('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('usefulness.ts — malformed payload_json does not break shared aggregate queries', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  it('usefulnessRate/feedbackLoopSummary/usefulnessScores tolerate one malformed usefulness-typed row among healthy ones', () => {
    const healthy = seedAtom(db, 'h-healthy');
    events.append({ event_type: 'usefulness', atom_id: healthy, payload: { family: 'recall_served' } });
    events.append({ event_type: 'usefulness', atom_id: healthy, payload: { family: 'recall_used' } });

    const poisoned = seedAtom(db, 'h-poisoned');
    insertMalformedEvent(db, poisoned, 'usefulness', Date.now());

    expect(() => usefulnessRate(db)).not.toThrow();
    expect(() => feedbackLoopSummary(db)).not.toThrow();
    expect(() => usefulnessScores(db, [healthy, poisoned])).not.toThrow();

    // The healthy atom's real signal still counts — the malformed row is
    // excluded from matching, not a query-wide failure that hides everything.
    const rate = usefulnessRate(db);
    expect(rate.served).toBeGreaterThanOrEqual(1);
    expect(rate.used).toBeGreaterThanOrEqual(1);
  });
});

describe('shipper.ts — malformed payload_json does not break the ship-eligibility scan or envelope build', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('listUnsynced/countUnsynced tolerate a malformed erase_request payload without throwing and still surface healthy rows', () => {
    const healthy = seedAtom(db, 'h-ship-healthy', 'team');
    new MemoryEventRepo(db).append({ event_type: 'create', atom_id: healthy, payload: { scope: 'team' } });

    // Simulate a pulled erase_request event with a corrupted payload for a
    // ghost atom (row already gone) — exactly the shape listUnsynced's
    // json_extract(e.payload_json, '$.scope') branch reads.
    insertMalformedEvent(db, 'ghost-atom-id', 'erase_request', Date.now());

    expect(() => listUnsynced(db, 200)).not.toThrow();
    expect(() => countUnsynced(db)).not.toThrow();

    const rows = listUnsynced(db, 200);
    expect(rows.some(r => r.atom_id === healthy)).toBe(true);
  });

  it('buildEnvelope ships a malformed row with a null payload instead of throwing and losing the whole batch', () => {
    const healthy = seedAtom(db, 'h-envelope-healthy', 'team');
    const events = new MemoryEventRepo(db);
    events.append({ event_type: 'create', atom_id: healthy, payload: { scope: 'team' } });
    insertMalformedEvent(db, healthy, 'promote_scope', Date.now());

    const rows = listUnsynced(db, 200);
    expect(rows.length).toBeGreaterThanOrEqual(2);

    let envelope: ReturnType<typeof buildEnvelope> | undefined;
    expect(() => { envelope = buildEnvelope('device-1', 'ws-1', 0, rows); }).not.toThrow();
    expect(envelope!.events.length).toBe(rows.length);
    const malformedEntry = envelope!.events.find(e => e.event_type === 'promote_scope');
    expect(malformedEntry?.payload_json).toBeNull();
  });
});

describe('conflict-resolve.ts — malformed supersede payload does not crash recomputeProjection', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('resolves using the valid supersede event when one supersede for the atom is malformed', () => {
    const x = seedAtom(db, 'h-cr-x');
    const y = seedAtom(db, 'h-cr-y');
    const events = new MemoryEventRepo(db);
    events.append({ event_type: 'supersede', atom_id: x, payload: { superseded_by: y }, created_at: 100 });
    insertMalformedEvent(db, x, 'supersede', 200);

    expect(() => recomputeProjection(db, x)).not.toThrow();

    const row = db.prepare('SELECT valid_to, superseded_by FROM memories WHERE id = ?').get(x) as
      { valid_to: number | null; superseded_by: string | null };
    expect(row.superseded_by).toBe(y); // the one resolvable target wins
  });

  it('leaves the projection unresolved (does not throw, does not corrupt state) when EVERY supersede for the atom is malformed', () => {
    const x = seedAtom(db, 'h-cr-all-bad');
    insertMalformedEvent(db, x, 'supersede', 100);

    expect(() => recomputeProjection(db, x)).not.toThrow();

    const row = db.prepare('SELECT valid_to, superseded_by FROM memories WHERE id = ?').get(x) as
      { valid_to: number | null; superseded_by: string | null };
    expect(row.valid_to).toBeNull();
    expect(row.superseded_by).toBeNull();
  });
});
