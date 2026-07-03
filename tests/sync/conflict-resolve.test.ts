// FEAT-407 (ADR-011 multi-device conflict policy) — scoped projection
// recompute. AC-3: each conflict class resolves deterministically per
// ADR-011's rules A (concurrent-edit), B (edit-vs-supersede), C
// (edit-vs-erase).
//
// These tests simulate two devices by directly appending memory_events with
// explicit created_at/event_id (bypassing the single-device
// invalidate()/supersede() convenience methods, which assume one writer and
// would reject the second concurrent mutation) — exactly the situation pull
// ingest produces when it dedup-inserts a remote event onto an atom that
// also has a local event.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { recomputeProjection } from '../../src/sync/conflict-resolve.js';

function seedAtom(db: DB, hash: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact',
    text: `text ${hash}`,
    normalized_text: `text ${hash}`,
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null, scope: 'team',
  });
}

let db: DB;
let events: MemoryEventRepo;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  events = new MemoryEventRepo(db);
});

function getMemory(id: string) {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
    | { id: string; valid_to: number | null; superseded_by: string | null }
    | undefined;
}

describe('Rule A — concurrent-edit: supersede-vs-supersede fork tie-break', () => {
  it('picks the winner by max(created_at, event_id), chains the loser to the winner, and both successors survive', () => {
    const x = seedAtom(db, 'h-x');
    const y1 = seedAtom(db, 'h-y1');
    const y2 = seedAtom(db, 'h-y2');

    // Two devices concurrently supersede X — device A -> Y1 at t=100,
    // device B -> Y2 at t=200 (later, so Y2 wins by created_at).
    events.append({ event_type: 'supersede', atom_id: x, payload: { superseded_by: y1 }, created_at: 100 });
    events.append({ event_type: 'supersede', atom_id: x, payload: { superseded_by: y2 }, created_at: 200 });

    recomputeProjection(db, x);

    const xRow = getMemory(x)!;
    expect(xRow.valid_to).toBe(100); // min(created_at) across the fork
    expect(xRow.superseded_by).toBe(y2); // later event wins

    // Loser Y1 is chained to the winner Y2 via a synthetic conflict_merge event.
    const y1Row = getMemory(y1)!;
    expect(y1Row.superseded_by).toBe(y2);
    expect(y1Row.valid_to).not.toBeNull();

    // Y2 (winner) is untouched — still a live, standalone successor.
    const y2Row = getMemory(y2)!;
    expect(y2Row.valid_to).toBeNull();
    expect(y2Row.superseded_by).toBeNull();

    // The synthetic event is a real, shippable event (ADR-011 point 4).
    const y1Log = events.listForAtom(y1);
    const synthetic = y1Log.filter(e => e.event_type === 'supersede');
    expect(synthetic).toHaveLength(1);
    expect(JSON.parse(synthetic[0]!.payload_json!)).toEqual({ superseded_by: y2, reason: 'conflict_merge' });
  });

  it('is idempotent — re-running recompute after the fork already resolved appends no duplicate synthetic event', () => {
    const x = seedAtom(db, 'h-x2');
    const y1 = seedAtom(db, 'h-y1b');
    const y2 = seedAtom(db, 'h-y2b');
    events.append({ event_type: 'supersede', atom_id: x, payload: { superseded_by: y1 }, created_at: 100 });
    events.append({ event_type: 'supersede', atom_id: x, payload: { superseded_by: y2 }, created_at: 200 });

    recomputeProjection(db, x);
    recomputeProjection(db, x);
    recomputeProjection(db, x);

    const y1Log = events.listForAtom(y1).filter(e => e.event_type === 'supersede');
    expect(y1Log).toHaveLength(1); // still exactly one conflict_merge event, not three
  });

  it('picks the winner by event_id when created_at ties (deterministic tie-break, no device favored)', () => {
    const x = seedAtom(db, 'h-x3');
    const y1 = seedAtom(db, 'h-y1c');
    const y2 = seedAtom(db, 'h-y2c');
    // Same created_at — event_id (string compare) decides. Use explicit
    // event_ids so the expected winner is unambiguous regardless of
    // randomUUID() output.
    events.append({ event_type: 'supersede', atom_id: x, payload: { superseded_by: y1 }, created_at: 500, event_id: 'aaaaaaaa-0000-4000-8000-000000000000' });
    events.append({ event_type: 'supersede', atom_id: x, payload: { superseded_by: y2 }, created_at: 500, event_id: 'bbbbbbbb-0000-4000-8000-000000000000' });

    recomputeProjection(db, x);

    // 'b...' > 'a...' lexicographically, so y2 (the 'b' event) wins.
    expect(getMemory(x)!.superseded_by).toBe(y2);
  });
});

describe('Rule A — concurrent-edit: invalidate-vs-invalidate', () => {
  it('is order-independent: valid_to = min(created_at) regardless of append order', () => {
    const x = seedAtom(db, 'h-inv1');
    events.append({ event_type: 'invalidate', atom_id: x, payload: { reason: 'device-A' }, created_at: 900 });
    events.append({ event_type: 'invalidate', atom_id: x, payload: { reason: 'device-B' }, created_at: 300 });

    recomputeProjection(db, x);

    expect(getMemory(x)!.valid_to).toBe(300); // first-invalidated-wins
    expect(getMemory(x)!.superseded_by).toBeNull();
  });
});

describe('Rule B — edit-vs-supersede: supersede always wins regardless of created_at ordering', () => {
  it('supersede wins even when the concurrent invalidate has a LATER created_at', () => {
    const x = seedAtom(db, 'h-b1');
    const y = seedAtom(db, 'h-b1y');
    // supersede happened chronologically FIRST (t=1000); invalidate landed
    // later (t=5000) — a naive timestamp-LWW would let invalidate win, but
    // ADR-011 rule B is type-priority, not time-priority.
    events.append({ event_type: 'supersede', atom_id: x, payload: { superseded_by: y }, created_at: 1000 });
    events.append({ event_type: 'invalidate', atom_id: x, payload: { reason: 'concurrent' }, created_at: 5000 });

    recomputeProjection(db, x);

    const xRow = getMemory(x)!;
    expect(xRow.superseded_by).toBe(y);
    expect(xRow.valid_to).toBe(1000); // the supersede's own timestamp, not the invalidate's
  });
});

describe('Rule C — edit-vs-erase: erase_request always wins, unconditionally', () => {
  it('hard-deletes the atom even with a concurrent supersede naming a live replacement; the replacement is untouched', () => {
    const x = seedAtom(db, 'h-c1');
    const y = seedAtom(db, 'h-c1y');
    events.append({ event_type: 'supersede', atom_id: x, payload: { superseded_by: y }, created_at: 100 });
    events.append({ event_type: 'erase_request', atom_id: x, payload: { scope: 'team', reason: 'gdpr' }, created_at: 200 });

    recomputeProjection(db, x);

    expect(getMemory(x)).toBeUndefined(); // hard-deleted
    const yRow = getMemory(y)!;
    expect(yRow.valid_to).toBeNull(); // Y stands alone, untouched
    expect(yRow.superseded_by).toBeNull();
  });

  it('wins regardless of created_at ordering — erase before OR after the concurrent invalidate', () => {
    const x = seedAtom(db, 'h-c2');
    events.append({ event_type: 'erase_request', atom_id: x, payload: { scope: 'team' }, created_at: 100 });
    events.append({ event_type: 'invalidate', atom_id: x, payload: { reason: 'concurrent' }, created_at: 50 });

    recomputeProjection(db, x);

    expect(getMemory(x)).toBeUndefined();
  });
});

describe('Composition — fork (A) resolved before supersede-beats-invalidate (B) on the same atom', () => {
  it('resolves the fork first, then a concurrent invalidate on X still loses to the fork winner', () => {
    const x = seedAtom(db, 'h-comp');
    const y1 = seedAtom(db, 'h-comp-y1');
    const y2 = seedAtom(db, 'h-comp-y2');
    events.append({ event_type: 'supersede', atom_id: x, payload: { superseded_by: y1 }, created_at: 100 });
    events.append({ event_type: 'supersede', atom_id: x, payload: { superseded_by: y2 }, created_at: 200 });
    events.append({ event_type: 'invalidate', atom_id: x, payload: { reason: 'concurrent' }, created_at: 9999 });

    recomputeProjection(db, x);

    const xRow = getMemory(x)!;
    expect(xRow.superseded_by).toBe(y2); // fork winner, not affected by the invalidate
    expect(xRow.valid_to).toBe(100);
  });
});
