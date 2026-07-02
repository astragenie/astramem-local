import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { buildApp } from '../../src/server/app.js';
import {
  hashQuery,
  recordRecallServed,
  recordRecallUsed,
  recordMemoryCorrected,
  usefulnessRate,
  usefulnessByType,
} from '../../src/storage/usefulness.js';

function insertMem(repo: MemoryRepo, hash: string, type = 'fact'): string {
  return repo.insert({
    type: type as 'fact' | 'decision' | 'lesson',
    text: 'usefulness test memory', normalized_text: 'usefulness test memory',
    repo: 'r1', project: null, branch: null, agent: null, session_id: null,
    hash, source_hash: null,
  });
}

describe('hashQuery', () => {
  it('is a 16-char hex digest and never contains the raw query text', () => {
    const h = hashQuery('the raw query text');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).not.toContain('raw');
  });

  it('is deterministic for the same input', () => {
    expect(hashQuery('same')).toBe(hashQuery('same'));
  });
});

describe('recordRecallServed', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  it('appends one usefulness/recall_served event per atom id', () => {
    const a = insertMem(repo, 'us-served-a');
    const b = insertMem(repo, 'us-served-b');

    recordRecallServed(db, { query: 'find the thing', atomIds: [a, b], scores: [0.9, 0.4], surface: 'rest', mode: 'search' });

    const aEvents = events.listForAtom(a);
    expect(aEvents).toHaveLength(1);
    expect(aEvents[0]?.event_type).toBe('usefulness');
    const aPayload = JSON.parse(aEvents[0]?.payload_json ?? '{}');
    expect(aPayload).toMatchObject({ family: 'recall_served', surface: 'rest', mode: 'search', score: 0.9 });
    expect(aPayload.query_hash).toBe(hashQuery('find the thing'));

    const bPayload = JSON.parse(events.listForAtom(b)[0]?.payload_json ?? '{}');
    expect(bPayload.score).toBe(0.4);
  });

  it('is a no-op on an empty atomIds list', () => {
    recordRecallServed(db, { query: 'nothing found', atomIds: [], surface: 'rest' });
    const total = (db.prepare("SELECT COUNT(*) AS n FROM memory_events WHERE event_type = 'usefulness'").get() as { n: number }).n;
    expect(total).toBe(0);
  });

  it('accepts a precomputed queryHash instead of query', () => {
    const a = insertMem(repo, 'us-served-c');
    recordRecallServed(db, { queryHash: 'deadbeefdeadbeef', atomIds: [a], surface: 'mcp' });
    const payload = JSON.parse(events.listForAtom(a)[0]?.payload_json ?? '{}');
    expect(payload.query_hash).toBe('deadbeefdeadbeef');
  });
});

describe('recordRecallUsed + recordMemoryCorrected', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  it('recordRecallUsed appends a recall_used event', () => {
    const id = insertMem(repo, 'us-used-a');
    recordRecallUsed(db, { atomId: id, surface: 'mcp', signal: 'explicit' });
    const payload = JSON.parse(events.listForAtom(id)[0]?.payload_json ?? '{}');
    expect(payload).toEqual({ family: 'recall_used', surface: 'mcp', signal: 'explicit' });
  });

  it('recordMemoryCorrected appends a memory_corrected event', () => {
    const id = insertMem(repo, 'us-corrected-a');
    recordMemoryCorrected(db, { atomId: id, action: 'demoted' });
    const payload = JSON.parse(events.listForAtom(id)[0]?.payload_json ?? '{}');
    expect(payload).toEqual({ family: 'memory_corrected', action: 'demoted' });
  });
});

describe('MemoryEventRepo.invalidate/supersede also write memory_corrected', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  it('invalidate() appends invalidate + usefulness/memory_corrected(invalidated), same tx', () => {
    const id = insertMem(repo, 'us-inv-corrected');
    events.invalidate(id, 'stale');

    const log = events.listForAtom(id);
    expect(log.map(e => e.event_type)).toEqual(['invalidate', 'usefulness']);
    const payload = JSON.parse(log[1]?.payload_json ?? '{}');
    expect(payload).toEqual({ family: 'memory_corrected', action: 'invalidated' });
  });

  it('supersede() appends supersede + usefulness/memory_corrected(superseded) on the old id', () => {
    const oldId = insertMem(repo, 'us-sup-old');
    const newId = insertMem(repo, 'us-sup-new');
    events.supersede(oldId, newId);

    const log = events.listForAtom(oldId);
    expect(log.map(e => e.event_type)).toEqual(['supersede', 'usefulness']);
    const payload = JSON.parse(log[1]?.payload_json ?? '{}');
    expect(payload).toEqual({ family: 'memory_corrected', action: 'superseded' });

    // new id is untouched by the correction event
    expect(events.listForAtom(newId).filter(e => e.event_type === 'usefulness')).toHaveLength(0);
  });
});

describe('usefulnessRate', () => {
  let db: DB;
  let repo: MemoryRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  it('served-only → used 0, rate 0', () => {
    const a = insertMem(repo, 'rate-served-only');
    recordRecallServed(db, { query: 'q', atomIds: [a], surface: 'rest' });

    const rate = usefulnessRate(db);
    expect(rate).toEqual({ served: 1, used: 0, rate: 0 });
  });

  it('used without a matching served event → served 0, rate null (no divide by zero)', () => {
    const a = insertMem(repo, 'rate-used-only');
    recordRecallUsed(db, { atomId: a, surface: 'mcp', signal: 'explicit' });

    const rate = usefulnessRate(db);
    expect(rate).toEqual({ served: 0, used: 1, rate: null });
  });

  it('no events at all → all zero, rate null', () => {
    expect(usefulnessRate(db)).toEqual({ served: 0, used: 0, rate: null });
  });

  it('served + used on the same atom → rate 1', () => {
    const a = insertMem(repo, 'rate-served-and-used');
    recordRecallServed(db, { query: 'q', atomIds: [a], surface: 'rest' });
    recordRecallUsed(db, { atomId: a, surface: 'rest', signal: 'explicit' });

    expect(usefulnessRate(db)).toEqual({ served: 1, used: 1, rate: 1 });
  });

  it('sinceMs windows out events created before the cutoff', () => {
    const a = insertMem(repo, 'rate-window-old');
    const b = insertMem(repo, 'rate-window-new');
    const events = new MemoryEventRepo(db);
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'recall_served', query_hash: 'h', score: null, surface: 'rest', mode: null }, created_at: 1_000 });
    events.append({ event_type: 'usefulness', atom_id: b, payload: { family: 'recall_served', query_hash: 'h', score: null, surface: 'rest', mode: null }, created_at: 50_000 });

    const windowed = usefulnessRate(db, { sinceMs: 10_000 });
    expect(windowed.served).toBe(1);

    const unwindowed = usefulnessRate(db, { sinceMs: 0 });
    expect(unwindowed.served).toBe(2);
  });

  it('surface filter narrows to matching surface only', () => {
    const a = insertMem(repo, 'rate-surface-rest');
    const b = insertMem(repo, 'rate-surface-mcp');
    recordRecallServed(db, { query: 'q', atomIds: [a], surface: 'rest' });
    recordRecallServed(db, { query: 'q', atomIds: [b], surface: 'mcp' });

    expect(usefulnessRate(db, { surface: 'rest' }).served).toBe(1);
    expect(usefulnessRate(db, { surface: 'mcp' }).served).toBe(1);
    expect(usefulnessRate(db).served).toBe(2);
  });

  it('counts distinct atoms — repeated serves of the same atom count once', () => {
    const a = insertMem(repo, 'rate-distinct');
    recordRecallServed(db, { query: 'q1', atomIds: [a], surface: 'rest' });
    recordRecallServed(db, { query: 'q2', atomIds: [a], surface: 'rest' });

    expect(usefulnessRate(db).served).toBe(1);
  });
});

describe('usefulnessByType', () => {
  let db: DB;
  let repo: MemoryRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  it('groups served/used/rate by the atom\'s current memories.type', () => {
    const decision = insertMem(repo, 'bytype-decision', 'decision');
    const fact = insertMem(repo, 'bytype-fact', 'fact');
    recordRecallServed(db, { query: 'q', atomIds: [decision, fact], surface: 'rest' });
    recordRecallUsed(db, { atomId: decision, surface: 'rest', signal: 'explicit' });

    const rows = usefulnessByType(db);
    const byType = new Map(rows.map(r => [r.type, r]));
    expect(byType.get('decision')).toEqual({ type: 'decision', served: 1, used: 1, rate: 1 });
    expect(byType.get('fact')).toEqual({ type: 'fact', served: 1, used: 0, rate: 0 });
  });

  it('returns an empty array when there are no usefulness events', () => {
    expect(usefulnessByType(db)).toEqual([]);
  });
});

describe('POST /memory/:id/used (REST explicit recall-used channel)', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok' });
  });

  it('happy path — 200 { ok: true }, records a recall_used usefulness event', async () => {
    const id = insertMem(repo, 'rest-used-1');
    const res = await app.inject({
      method: 'POST', url: `/memory/${id}/used`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const events = new MemoryEventRepo(db).listForAtom(id).filter(e => e.event_type === 'usefulness');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]?.payload_json ?? '{}');
    expect(payload).toEqual({ family: 'recall_used', surface: 'rest', signal: 'explicit' });
  });

  it('unknown id -> 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/memory/nope/used',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires bearer auth', async () => {
    const id = insertMem(repo, 'rest-used-2');
    const res = await app.inject({ method: 'POST', url: `/memory/${id}/used` });
    expect(res.statusCode).toBe(401);
  });
});
