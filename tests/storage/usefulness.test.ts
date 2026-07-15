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
  usefulnessScores,
  runImplicitPositivePass,
  feedbackLoopSummary,
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

  it('recordMemoryCorrected appends a memory_corrected event, source defaults to external', () => {
    const id = insertMem(repo, 'us-corrected-a');
    recordMemoryCorrected(db, { atomId: id, action: 'demoted' });
    const payload = JSON.parse(events.listForAtom(id)[0]?.payload_json ?? '{}');
    expect(payload).toEqual({ family: 'memory_corrected', action: 'demoted', source: 'external' });
  });

  it('recordMemoryCorrected accepts an explicit source', () => {
    const id = insertMem(repo, 'us-corrected-b');
    recordMemoryCorrected(db, { atomId: id, action: 'demoted', source: 'consolidation_auto' });
    const payload = JSON.parse(events.listForAtom(id)[0]?.payload_json ?? '{}');
    expect(payload).toEqual({ family: 'memory_corrected', action: 'demoted', source: 'consolidation_auto' });
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
    // issue #190: invalidate() has no automated caller — always 'external'.
    expect(payload).toEqual({ family: 'memory_corrected', action: 'invalidated', source: 'external' });
  });

  it('supersede() appends supersede + usefulness/memory_corrected(superseded) on the old id, default source external', () => {
    const oldId = insertMem(repo, 'us-sup-old');
    const newId = insertMem(repo, 'us-sup-new');
    events.supersede(oldId, newId);

    const log = events.listForAtom(oldId);
    expect(log.map(e => e.event_type)).toEqual(['supersede', 'usefulness']);
    const payload = JSON.parse(log[1]?.payload_json ?? '{}');
    expect(payload).toEqual({ family: 'memory_corrected', action: 'superseded', source: 'external' });

    // new id is untouched by the correction event
    expect(events.listForAtom(newId).filter(e => e.event_type === 'usefulness')).toHaveLength(0);
  });

  // issue #190 AC-2: the 4th `correctionSource` param tags WHO decided this
  // merge, independent of the FEAT-442 `provenance` autoAcceptThreshold marker
  // (which stays untouched on the `supersede` event's own payload — see the
  // `provenance param adds ...` test in memory-events.test.ts).
  it('supersede() with correctionSource="consolidation_auto" tags the memory_corrected event, not the supersede event', () => {
    const oldId = insertMem(repo, 'us-sup-auto-old');
    const newId = insertMem(repo, 'us-sup-auto-new');
    events.supersede(oldId, newId, undefined, 'consolidation_auto');

    const log = events.listForAtom(oldId);
    const supersedePayload = JSON.parse(log.find(e => e.event_type === 'supersede')?.payload_json ?? '{}');
    expect(supersedePayload).toEqual({ superseded_by: newId }); // unaffected by correctionSource

    const usefulnessPayload = JSON.parse(log.find(e => e.event_type === 'usefulness')?.payload_json ?? '{}');
    expect(usefulnessPayload).toEqual({ family: 'memory_corrected', action: 'superseded', source: 'consolidation_auto' });
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

// issue #190: "cross-query survival" implicit positive-usefulness sweep —
// docs/specs/20260714-implicit-usefulness-signal-190.md.
describe('runImplicitPositivePass', () => {
  let db: DB;
  let repo: MemoryRepo;
  const OPTS = { windowDays: 30, minDistinctQueries: 2, maxGrantsPerRun: 500 };
  const NOW = 1_700_000_000_000; // fixed instant so "trailing window" math is deterministic

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  function servedAt(atomId: string, queryHash: string, createdAt: number) {
    new MemoryEventRepo(db).append({
      event_type: 'usefulness', atom_id: atomId, created_at: createdAt,
      payload: { family: 'recall_served', query_hash: queryHash, score: null, surface: 'rest', mode: null },
    });
  }

  // AC-1: at most one heuristic grant per atom, ever — a second pass over
  // the same fixture data grants nothing more for an already-granted atom.
  it('AC-1: grants at most one heuristic recall_used event per atom, ever — re-running is a no-op', () => {
    const a = insertMem(repo, 'implicit-ac1');
    servedAt(a, 'q1', NOW - 1000);
    servedAt(a, 'q2', NOW - 500);

    const first = runImplicitPositivePass(db, OPTS, NOW);
    expect(first).toEqual({ candidates: 1, granted: 1 });

    const second = runImplicitPositivePass(db, OPTS, NOW);
    expect(second).toEqual({ candidates: 0, granted: 0 });

    const grants = new MemoryEventRepo(db).listForAtom(a).filter(e => {
      const p = JSON.parse(e.payload_json ?? '{}');
      return p.family === 'recall_used' && p.signal === 'heuristic';
    });
    expect(grants).toHaveLength(1);
  });

  // AC-2: 1 distinct query, however many times served, never qualifies.
  it('AC-2: an atom served under only 1 distinct query_hash never qualifies, regardless of serve count', () => {
    const a = insertMem(repo, 'implicit-ac2');
    servedAt(a, 'same-query', NOW - 5000);
    servedAt(a, 'same-query', NOW - 4000);
    servedAt(a, 'same-query', NOW - 3000);

    const result = runImplicitPositivePass(db, OPTS, NOW);
    expect(result).toEqual({ candidates: 0, granted: 0 });
  });

  // AC-3: any memory_corrected event, at any time, permanently excludes.
  it('AC-3: an atom with any memory_corrected event is permanently excluded from a grant', () => {
    const a = insertMem(repo, 'implicit-ac3');
    servedAt(a, 'q1', NOW - 1000);
    servedAt(a, 'q2', NOW - 500);
    recordMemoryCorrected(db, { atomId: a, action: 'demoted' });

    const result = runImplicitPositivePass(db, OPTS, NOW);
    expect(result).toEqual({ candidates: 0, granted: 0 });
  });

  it('AC-3: a correction recorded AFTER the qualifying window still excludes the atom', () => {
    const a = insertMem(repo, 'implicit-ac3b');
    servedAt(a, 'q1', NOW - 1000);
    servedAt(a, 'q2', NOW - 500);
    // Correction event itself falls outside the window's created_at bound —
    // the exclusion subquery has no window filter, so it still applies.
    new MemoryEventRepo(db).append({
      event_type: 'usefulness', atom_id: a, created_at: NOW + 10_000,
      payload: { family: 'memory_corrected', action: 'demoted', source: 'external' },
    });

    const result = runImplicitPositivePass(db, OPTS, NOW);
    expect(result).toEqual({ candidates: 0, granted: 0 });
  });

  it('does not grant for a serve outside the trailing window', () => {
    const a = insertMem(repo, 'implicit-outside-window');
    const windowStartMs = NOW - OPTS.windowDays * 24 * 60 * 60 * 1000;
    servedAt(a, 'q1', windowStartMs - 10_000); // before the window
    servedAt(a, 'q2', windowStartMs - 5_000); // before the window

    const result = runImplicitPositivePass(db, OPTS, NOW);
    expect(result).toEqual({ candidates: 0, granted: 0 });
  });

  it('caps grants at maxGrantsPerRun', () => {
    const ids = [insertMem(repo, 'implicit-cap-a'), insertMem(repo, 'implicit-cap-b'), insertMem(repo, 'implicit-cap-c')];
    for (const id of ids) {
      servedAt(id, 'q1', NOW - 1000);
      servedAt(id, 'q2', NOW - 500);
    }

    const result = runImplicitPositivePass(db, { ...OPTS, maxGrantsPerRun: 2 }, NOW);
    expect(result).toEqual({ candidates: 2, granted: 2 });
  });

  it('the granted event carries surface:system, signal:heuristic, basis:no_correction_survival', () => {
    const a = insertMem(repo, 'implicit-payload-shape');
    servedAt(a, 'q1', NOW - 1000);
    servedAt(a, 'q2', NOW - 500);
    runImplicitPositivePass(db, OPTS, NOW);

    const grant = new MemoryEventRepo(db).listForAtom(a).find(e => {
      const p = JSON.parse(e.payload_json ?? '{}');
      return p.family === 'recall_used';
    });
    const payload = JSON.parse(grant?.payload_json ?? '{}');
    expect(payload).toEqual({
      family: 'recall_used', surface: 'system', signal: 'heuristic', basis: 'no_correction_survival',
    });
  });

  it('feedbackLoopSummary counts an implicit-only atom as used (heuristic bucket)', () => {
    const a = insertMem(repo, 'implicit-canary');
    servedAt(a, 'q1', NOW - 1000);
    servedAt(a, 'q2', NOW - 500);
    runImplicitPositivePass(db, OPTS, NOW);

    const summary = feedbackLoopSummary(db);
    expect(summary.usedDistinct).toBe(1);
    expect(summary.usedExplicitDistinct).toBe(0);
    expect(summary.usedHeuristicDistinct).toBe(1);
  });
});

describe('usefulnessScores (weighted, issue #190)', () => {
  let db: DB;
  let repo: MemoryRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  it('no signal at all -> neutral 0.5', () => {
    const a = insertMem(repo, 'scores-neutral');
    expect(usefulnessScores(db, [a]).get(a)).toBe(0.5);
  });

  it('one explicit recall_used -> 0.667 (unchanged from pre-#190 behavior)', () => {
    const a = insertMem(repo, 'scores-explicit');
    recordRecallUsed(db, { atomId: a, surface: 'mcp', signal: 'explicit' });
    expect(usefulnessScores(db, [a]).get(a)).toBeCloseTo(2 / 3, 6);
  });

  // AC-4: heuristic weighting is wired, not just event presence — a
  // heuristic-only atom must score DIFFERENTLY from an explicit-only one.
  it('AC-4: one heuristic recall_used at the default weight (0.35) -> 0.574, not 0.667', () => {
    const a = insertMem(repo, 'scores-heuristic-default');
    recordRecallUsed(db, { atomId: a, surface: 'system', signal: 'heuristic' });
    const score = usefulnessScores(db, [a]).get(a)!;
    expect(score).toBeCloseTo((0.35 + 1) / (0.35 + 2), 6); // 0.574074...
    expect(score).not.toBeCloseTo(2 / 3, 3);
  });

  it('AC-4: an explicit caller-supplied weight is honored, not hardcoded', () => {
    const a = insertMem(repo, 'scores-heuristic-custom-weight');
    recordRecallUsed(db, { atomId: a, surface: 'system', signal: 'heuristic' });
    const score = usefulnessScores(db, [a], 0.6).get(a)!;
    expect(score).toBeCloseTo((0.6 + 1) / (0.6 + 2), 6);
  });

  // Regression (2026-07-15): one bound param per id overflowed SQLite's
  // SQLITE_MAX_VARIABLE_NUMBER (~999) once a consolidation run passed the full
  // valid-atom set, throwing "too many SQL variables" and poisoning every
  // consolidate job on a large corpus. usefulnessScores now batches the IN().
  it('handles > 999 atom ids without "too many SQL variables" (batched IN)', () => {
    const ids: string[] = [];
    for (let i = 0; i < 1500; i++) ids.push(insertMem(repo, `scores-batch-${i}`));
    // Give one atom in a LATER batch a real signal so we prove batching keeps
    // returning correct scores past the first chunk, not just that it runs.
    recordRecallUsed(db, { atomId: ids[1200]!, surface: 'mcp', signal: 'explicit' });
    let scores!: Map<string, number>;
    expect(() => { scores = usefulnessScores(db, ids); }).not.toThrow();
    expect(scores.size).toBe(1500);
    expect(scores.get(ids[0]!)).toBe(0.5); // no signal -> neutral
    expect(scores.get(ids[1200]!)).toBeCloseTo(2 / 3, 6); // signal counted across batch boundary
  });

  it('a correction still demotes an implicit-only grant exactly as it would an explicit one', () => {
    const a = insertMem(repo, 'scores-heuristic-corrected');
    recordRecallUsed(db, { atomId: a, surface: 'system', signal: 'heuristic' });
    recordMemoryCorrected(db, { atomId: a, action: 'demoted' });
    const score = usefulnessScores(db, [a]).get(a)!;
    expect(score).toBeCloseTo((0.35 + 1) / (0.35 + 1 + 2), 6);
  });

  it('explicit + heuristic on the same atom both contribute to the weighted sum', () => {
    const a = insertMem(repo, 'scores-both-signals');
    recordRecallUsed(db, { atomId: a, surface: 'mcp', signal: 'explicit' });
    recordRecallUsed(db, { atomId: a, surface: 'system', signal: 'heuristic' });
    const score = usefulnessScores(db, [a]).get(a)!;
    expect(score).toBeCloseTo((1 + 0.35 + 1) / (1 + 0.35 + 2), 6);
  });
});
