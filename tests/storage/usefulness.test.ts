import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
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
  pruneOldRecallServedEvents,
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

  // FEAT-477: `basis` lets a heuristic mechanism (e.g.
  // src/storage/proxy-turn-correlation.ts) tag which one produced a grant,
  // without disturbing the byte-identical shape every pre-FEAT-477 caller
  // (including this file's own previous test above) already relies on.
  it('recordRecallUsed includes basis when supplied, omits it when not', () => {
    const withBasis = insertMem(repo, 'us-used-basis');
    recordRecallUsed(db, { atomId: withBasis, surface: 'system', signal: 'heuristic', basis: 'proxy_turn_correlation' });
    const withBasisPayload = JSON.parse(events.listForAtom(withBasis)[0]?.payload_json ?? '{}');
    expect(withBasisPayload).toEqual({ family: 'recall_used', surface: 'system', signal: 'heuristic', basis: 'proxy_turn_correlation' });

    const withoutBasis = insertMem(repo, 'us-used-no-basis');
    recordRecallUsed(db, { atomId: withoutBasis, surface: 'mcp', signal: 'explicit' });
    const withoutBasisPayload = JSON.parse(events.listForAtom(withoutBasis)[0]?.payload_json ?? '{}');
    expect(withoutBasisPayload).not.toHaveProperty('basis');
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

describe('feedbackLoopSummary — single-pass rewrite (2026-08-02) matches the old 8-query behavior exactly', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  /**
   * Byte-for-byte copy of the pre-fix implementation (eight separate
   * `COUNT(DISTINCT atom_id)` queries) — kept ONLY as an equivalence
   * oracle for these tests, never imported by production code. If the
   * live `feedbackLoopSummary()` (src/storage/usefulness.ts) and this
   * function ever disagree, the single-pass rewrite changed doctor-canary
   * alarm behavior, which is exactly what this suite exists to catch.
   */
  function oldFeedbackLoopSummary(db: DB): ReturnType<typeof feedbackLoopSummary> {
    const J = `(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '[]' END)`;
    const count = (sql: string, ...params: unknown[]): number =>
      (db.prepare(sql).get(...params) as { n: number }).n;

    const servedDistinct = count(`
      SELECT COUNT(DISTINCT atom_id) AS n FROM memory_events
      WHERE event_type = 'usefulness' AND json_extract(${J},'$.family') = 'recall_served'
    `);
    const usedDistinct = count(`
      SELECT COUNT(DISTINCT atom_id) AS n FROM memory_events
      WHERE event_type = 'usefulness' AND json_extract(${J},'$.family') = 'recall_used'
    `);
    const usedExplicitDistinct = count(`
      SELECT COUNT(DISTINCT atom_id) AS n FROM memory_events
      WHERE event_type = 'usefulness' AND json_extract(${J},'$.family') = 'recall_used'
        AND json_extract(${J},'$.signal') = 'explicit'
    `);
    const usedHeuristicDistinct = count(`
      SELECT COUNT(DISTINCT atom_id) AS n FROM memory_events
      WHERE event_type = 'usefulness' AND json_extract(${J},'$.family') = 'recall_used'
        AND json_extract(${J},'$.signal') = 'heuristic'
    `);
    const correctedDistinct = count(`
      SELECT COUNT(DISTINCT atom_id) AS n FROM memory_events
      WHERE event_type = 'usefulness' AND json_extract(${J},'$.family') = 'memory_corrected'
    `);
    const correctedConsolidationDistinct = count(`
      SELECT COUNT(DISTINCT atom_id) AS n FROM memory_events
      WHERE event_type = 'usefulness' AND json_extract(${J},'$.family') = 'memory_corrected'
        AND json_extract(${J},'$.source') = 'consolidation_auto'
    `);
    const correctedExternalDistinct = count(`
      SELECT COUNT(DISTINCT atom_id) AS n FROM memory_events
      WHERE event_type = 'usefulness' AND json_extract(${J},'$.family') = 'memory_corrected'
        AND json_extract(${J},'$.source') = 'external'
    `);
    const correctedUnknownDistinct = count(`
      SELECT COUNT(DISTINCT atom_id) AS n FROM memory_events
      WHERE event_type = 'usefulness' AND json_extract(${J},'$.family') = 'memory_corrected'
        AND json_extract(${J},'$.source') IS NULL
        AND atom_id NOT IN (
          SELECT atom_id FROM memory_events
          WHERE event_type = 'usefulness' AND json_extract(${J},'$.family') = 'memory_corrected'
            AND json_extract(${J},'$.source') IS NOT NULL
        )
    `);

    return {
      servedDistinct, usedDistinct, usedExplicitDistinct, usedHeuristicDistinct, correctedDistinct,
      correctedConsolidationDistinct, correctedExternalDistinct, correctedUnknownDistinct,
    };
  }

  function expectEquivalent(): void {
    expect(feedbackLoopSummary(db)).toEqual(oldFeedbackLoopSummary(db));
  }

  it('empty table', () => {
    expectEquivalent();
    expect(feedbackLoopSummary(db)).toEqual({
      servedDistinct: 0, usedDistinct: 0, usedExplicitDistinct: 0, usedHeuristicDistinct: 0,
      correctedDistinct: 0, correctedConsolidationDistinct: 0, correctedExternalDistinct: 0,
      correctedUnknownDistinct: 0,
    });
  });

  it('one family present, others entirely absent', () => {
    const a = insertMem(repo, 'eq-served-only');
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'recall_served' } });
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'recall_served' } }); // dup event, same atom -> still 1 distinct
    expectEquivalent();
    expect(feedbackLoopSummary(db).servedDistinct).toBe(1);
    expect(feedbackLoopSummary(db).usedDistinct).toBe(0);
    expect(feedbackLoopSummary(db).correctedDistinct).toBe(0);
  });

  it('an atom appears across all three families', () => {
    const a = insertMem(repo, 'eq-multi-family');
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'recall_served' } });
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'recall_used', signal: 'explicit' } });
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'memory_corrected', source: 'external' } });
    expectEquivalent();
    const s = feedbackLoopSummary(db);
    expect(s.servedDistinct).toBe(1);
    expect(s.usedDistinct).toBe(1);
    expect(s.correctedDistinct).toBe(1);
  });

  it('an atom with BOTH explicit and heuristic recall_used events counts in both buckets (not mutually exclusive)', () => {
    const a = insertMem(repo, 'eq-both-signals');
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'recall_used', signal: 'explicit' } });
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'recall_used', signal: 'heuristic' } });
    expectEquivalent();
    const s = feedbackLoopSummary(db);
    expect(s.usedDistinct).toBe(1);
    expect(s.usedExplicitDistinct).toBe(1);
    expect(s.usedHeuristicDistinct).toBe(1);
  });

  it('an atom with BOTH consolidation_auto and external corrections counts in both source buckets', () => {
    const a = insertMem(repo, 'eq-both-sources');
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'memory_corrected', source: 'consolidation_auto' } });
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'memory_corrected', source: 'external' } });
    expectEquivalent();
    const s = feedbackLoopSummary(db);
    expect(s.correctedDistinct).toBe(1);
    expect(s.correctedConsolidationDistinct).toBe(1);
    expect(s.correctedExternalDistinct).toBe(1);
    expect(s.correctedUnknownDistinct).toBe(0);
  });

  it('an atom with ONLY an unsourced (null source) correction counts as unknown', () => {
    const a = insertMem(repo, 'eq-unsourced-only');
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'memory_corrected', action: 'demoted' } }); // no source key
    expectEquivalent();
    const s = feedbackLoopSummary(db);
    expect(s.correctedDistinct).toBe(1);
    expect(s.correctedConsolidationDistinct).toBe(0);
    expect(s.correctedExternalDistinct).toBe(0);
    expect(s.correctedUnknownDistinct).toBe(1);
  });

  it('the anti-join case: an atom with BOTH an unsourced AND a sourced correction is NOT counted as unknown', () => {
    const a = insertMem(repo, 'eq-mixed-source');
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'memory_corrected', action: 'demoted' } }); // unsourced (pre-fix-shaped event)
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'memory_corrected', source: 'external' } }); // later, sourced
    expectEquivalent();
    const s = feedbackLoopSummary(db);
    expect(s.correctedDistinct).toBe(1);
    expect(s.correctedExternalDistinct).toBe(1);
    // The atom has a sourced event too, so it must NOT count in "unknown" —
    // this is the exact NOT IN / anti-join semantic the rewrite has to
    // preserve without a second subquery.
    expect(s.correctedUnknownDistinct).toBe(0);
  });

  it('an unrecognized family value matches none of the buckets, in either implementation', () => {
    const a = insertMem(repo, 'eq-unknown-family');
    events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'some_future_family' } });
    expectEquivalent();
    const s = feedbackLoopSummary(db);
    expect(s).toEqual({
      servedDistinct: 0, usedDistinct: 0, usedExplicitDistinct: 0, usedHeuristicDistinct: 0,
      correctedDistinct: 0, correctedConsolidationDistinct: 0, correctedExternalDistinct: 0,
      correctedUnknownDistinct: 0,
    });
  });

  it('a mixed population of many atoms across all families/signals/sources stays equivalent', () => {
    for (let i = 0; i < 25; i++) {
      const a = insertMem(repo, `eq-bulk-${i}`);
      if (i % 3 === 0) events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'recall_served' } });
      if (i % 4 === 0) {
        events.append({
          event_type: 'usefulness', atom_id: a,
          payload: { family: 'recall_used', signal: i % 2 === 0 ? 'explicit' : 'heuristic' },
        });
      }
      if (i % 5 === 0) {
        const source = i % 15 === 0 ? undefined : (i % 2 === 0 ? 'consolidation_auto' : 'external');
        events.append({ event_type: 'usefulness', atom_id: a, payload: { family: 'memory_corrected', source } });
      }
    }
    expectEquivalent();
  });

  it('EXPLAIN QUERY PLAN: each of the three sub-queries hits its own dedicated index, never a full scan', () => {
    const J = `(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '[]' END)`;
    const servedPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT atom_id FROM memory_events WHERE event_type = 'usefulness' AND json_extract(${J},'$.family') = 'recall_served'`).all() as { detail: string }[];
    const usedPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT atom_id FROM memory_events WHERE event_type = 'usefulness' AND json_extract(${J},'$.family') = 'recall_used'`).all() as { detail: string }[];
    const correctedPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT atom_id FROM memory_events WHERE event_type = 'usefulness' AND json_extract(${J},'$.family') = 'memory_corrected'`).all() as { detail: string }[];

    expect(servedPlan.some(p => p.detail.includes('idx_memory_events_usefulness_served'))).toBe(true);
    expect(usedPlan.some(p => p.detail.includes('idx_memory_events_usefulness_used'))).toBe(true);
    expect(correctedPlan.some(p => p.detail.includes('idx_memory_events_usefulness_corrected'))).toBe(true);

    for (const plan of [servedPlan, usedPlan, correctedPlan]) {
      expect(plan.some(p => /SCAN memory_events USING INDEX idx_memory_events_atom_seq/.test(p.detail))).toBe(false);
      expect(plan.some(p => /^SCAN memory_events$/.test(p.detail))).toBe(false);
    }
  });

  it('does not regress usefulnessRate()\'s served query plan (the bug a first draft of this fix introduced)', () => {
    // A broader index (WHERE event_type = 'usefulness' alone, covering all
    // three families) was tried first and reverted because SQLite started
    // preferring it over migration 019's idx_memory_events_usefulness_served
    // for THIS query, discarding a targeted created_at range SEARCH for a
    // full 'usefulness'-slice SCAN. This test locks in that the final,
    // narrower (memory_corrected-only) index does not reintroduce that.
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(DISTINCT atom_id) AS n
      FROM memory_events
      WHERE event_type = 'usefulness'
        AND json_extract((CASE WHEN json_valid(payload_json) THEN payload_json ELSE '[]' END), '$.family') = 'recall_served'
        AND created_at >= ?
    `).all(0) as { detail: string }[];
    expect(plan.some(p => p.detail.includes('idx_memory_events_usefulness_served'))).toBe(true);
    expect(plan.some(p => p.detail.includes('idx_memory_events_usefulness_corrected'))).toBe(false);
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

describe('pruneOldRecallServedEvents (Wave-3 storage+perf track)', () => {
  let db: DB;
  let repo: MemoryRepo;
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  /** insertMem() (top of file) always defaults to scope: 'private' — this
   *  variant is for the team/org-scope cases this describe block needs to
   *  distinguish. */
  function insertMemWithScope(hash: string, scope: 'private' | 'team' | 'org'): string {
    return repo.insert({
      type: 'fact', text: 'usefulness test memory', normalized_text: 'usefulness test memory',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash, source_hash: null, scope,
    });
  }

  /** Raw insert bypassing recordRecallServed/MemoryEventRepo.append — the
   *  only way to control created_at/synced_at directly for this sweep's age
   *  + sync-state predicate, same technique tests/sync/shipper.test.ts uses. */
  function insertRawEvent(opts: {
    eventType: string;
    atomId: string;
    payload?: unknown;
    createdAt: number;
    syncedAt?: number | null;
  }): number {
    const result = db.prepare(`
      INSERT INTO memory_events (event_id, event_type, atom_id, payload_json, created_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), opts.eventType, opts.atomId,
      opts.payload !== undefined ? JSON.stringify(opts.payload) : null,
      opts.createdAt, opts.syncedAt ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  it('prunes an old, synced recall_served row (team/org atom, already shipped)', () => {
    const a = insertMemWithScope('prune-old-synced', 'team');
    insertRawEvent({
      eventType: 'usefulness', atomId: a, payload: { family: 'recall_served', query_hash: 'q1' },
      createdAt: Date.now() - 40 * DAY_MS, syncedAt: Date.now() - 39 * DAY_MS,
    });

    const result = pruneOldRecallServedEvents(db, 30);

    expect(result.pruned).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_events WHERE atom_id = ?').get(a)).toEqual({ n: 0 });
  });

  it('prunes an old, UNSYNCED recall_served row for a private-scope atom — structurally never ship-eligible', () => {
    const a = insertMemWithScope('prune-old-private-unsynced', 'private');
    insertRawEvent({
      eventType: 'usefulness', atomId: a, payload: { family: 'recall_served', query_hash: 'q1' },
      createdAt: Date.now() - 40 * DAY_MS, syncedAt: null,
    });

    const result = pruneOldRecallServedEvents(db, 30);

    expect(result.pruned).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_events WHERE atom_id = ?').get(a)).toEqual({ n: 0 });
  });

  it('HARD INVARIANT: leaves an old, UNSYNCED recall_served row for a team/org atom untouched — the shipper may still need it', () => {
    const a = insertMemWithScope('prune-old-teamorg-unsynced', 'team');
    insertRawEvent({
      eventType: 'usefulness', atomId: a, payload: { family: 'recall_served', query_hash: 'q1' },
      createdAt: Date.now() - 40 * DAY_MS, syncedAt: null,
    });

    const result = pruneOldRecallServedEvents(db, 30);

    expect(result.pruned).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_events WHERE atom_id = ?').get(a)).toEqual({ n: 1 });
  });

  it('prunes an old, unsynced recall_served row whose atom has since been hard-erased — can never become ship-eligible again', () => {
    const a = insertMemWithScope('prune-old-erased-unsynced', 'team');
    insertRawEvent({
      eventType: 'usefulness', atomId: a, payload: { family: 'recall_served', query_hash: 'q1' },
      createdAt: Date.now() - 40 * DAY_MS, syncedAt: null,
    });
    new MemoryEventRepo(db).erase(a);

    const result = pruneOldRecallServedEvents(db, 30);

    expect(result.pruned).toBe(1);
  });

  it('leaves a synced recall_served row that is not old enough yet', () => {
    const a = insertMemWithScope('prune-too-new', 'team');
    insertRawEvent({
      eventType: 'usefulness', atomId: a, payload: { family: 'recall_served', query_hash: 'q1' },
      createdAt: Date.now() - 5 * DAY_MS, syncedAt: Date.now() - 4 * DAY_MS,
    });

    const result = pruneOldRecallServedEvents(db, 30);

    expect(result.pruned).toBe(0);
  });

  it('leaves an unsynced, private-scope recall_served row that is not old enough yet', () => {
    const a = insertMemWithScope('prune-private-too-new', 'private');
    insertRawEvent({
      eventType: 'usefulness', atomId: a, payload: { family: 'recall_served', query_hash: 'q1' },
      createdAt: Date.now() - 5 * DAY_MS, syncedAt: null,
    });

    const result = pruneOldRecallServedEvents(db, 30);

    expect(result.pruned).toBe(0);
  });

  it('never prunes the recall_used / memory_corrected usefulness families, even old + private + unsynced', () => {
    const a = insertMemWithScope('prune-other-families', 'private');
    insertRawEvent({
      eventType: 'usefulness', atomId: a, payload: { family: 'recall_used', signal: 'explicit' },
      createdAt: Date.now() - 40 * DAY_MS, syncedAt: null,
    });
    insertRawEvent({
      eventType: 'usefulness', atomId: a, payload: { family: 'memory_corrected', action: 'invalidated' },
      createdAt: Date.now() - 40 * DAY_MS, syncedAt: null,
    });

    const result = pruneOldRecallServedEvents(db, 30);

    expect(result.pruned).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_events WHERE atom_id = ?').get(a)).toEqual({ n: 2 });
  });

  it('never prunes non-usefulness (audit) event types, even old + private + unsynced', () => {
    const a = insertMemWithScope('prune-audit-rows', 'private');
    for (const eventType of ['create', 'invalidate', 'supersede', 'promote_scope', 'erase_request']) {
      insertRawEvent({
        eventType, atomId: a,
        createdAt: Date.now() - 40 * DAY_MS, syncedAt: null,
      });
    }

    const result = pruneOldRecallServedEvents(db, 30);

    expect(result.pruned).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_events WHERE atom_id = ?').get(a)).toEqual({ n: 5 });
  });

  it('mixed batch: prunes old+synced and old+private-unsynced recall_served rows, keeps everything else', () => {
    const a = insertMemWithScope('prune-mixed', 'team');
    insertRawEvent({ // pruned — synced
      eventType: 'usefulness', atomId: a, payload: { family: 'recall_served', query_hash: 'q1' },
      createdAt: Date.now() - 40 * DAY_MS, syncedAt: Date.now() - 39 * DAY_MS,
    });
    insertRawEvent({ // pruned — synced
      eventType: 'usefulness', atomId: a, payload: { family: 'recall_served', query_hash: 'q2' },
      createdAt: Date.now() - 60 * DAY_MS, syncedAt: Date.now() - 50 * DAY_MS,
    });
    insertRawEvent({ // survives — unsynced AND team/org: still shipper-eligible
      eventType: 'usefulness', atomId: a, payload: { family: 'recall_served', query_hash: 'q3' },
      createdAt: Date.now() - 40 * DAY_MS, syncedAt: null,
    });
    insertRawEvent({ // survives — too new
      eventType: 'usefulness', atomId: a, payload: { family: 'recall_served', query_hash: 'q4' },
      createdAt: Date.now() - 1 * DAY_MS, syncedAt: Date.now(),
    });
    insertRawEvent({ // survives — create is an audit row, never pruned
      eventType: 'create', atomId: a,
      createdAt: Date.now() - 40 * DAY_MS, syncedAt: Date.now() - 39 * DAY_MS,
    });

    const result = pruneOldRecallServedEvents(db, 30);

    expect(result.pruned).toBe(2);
    const remaining = db.prepare('SELECT event_type FROM memory_events WHERE atom_id = ? ORDER BY seq').all(a) as { event_type: string }[];
    expect(remaining.map(r => r.event_type)).toEqual(['usefulness', 'usefulness', 'create']);
  });
});
