import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb, type DB } from '../../../src/storage/db.js';
import { migrate } from '../../../src/storage/migrate.js';
import { MemoryRepo } from '../../../src/storage/memories.js';
import { MemoryEventRepo } from '../../../src/storage/memory-events.js';
import { SqliteVecStore } from '../../../src/vector/sqlite-vec.js';
import { recordRecallServed, recordRecallUsed } from '../../../src/storage/usefulness.js';
import {
  buildMemoryHealthCheap,
  buildMemoryHealthFull,
} from '../../../src/server/queries/memory-health.js';
import {
  estimateNearDuplicates,
  estimateJunkHeuristic,
  estimateLlmJudgedJunk,
} from '../../../src/server/queries/memory-health-deep.js';
import type { LLMProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth } from '../../../src/contracts/llm.js';

function vecAt(axis: number, tilt = 0, tiltAxis = 1): Float32Array {
  const v = new Float32Array(1024);
  v[axis] = 1;
  if (tilt > 0) v[tiltAxis] = tilt;
  return v;
}

async function seedMemory(
  db: DB,
  text: string,
  opts: {
    hash?: string;
    type?: 'fact' | 'decision' | 'lesson' | 'note';
    repo?: string;
    scope?: 'private' | 'team' | 'org';
    importance?: number;
    embed?: Float32Array;
  } = {},
): Promise<string> {
  const id = new MemoryRepo(db).insert({
    type: opts.type ?? 'fact',
    text,
    normalized_text: text.toLowerCase(),
    repo: opts.repo ?? 'r1',
    project: null,
    branch: null,
    agent: null,
    session_id: null,
    hash: opts.hash ?? randomUUID(),
    source_hash: null,
    importance: opts.importance,
    scope: opts.scope,
  });
  if (opts.embed) {
    await new SqliteVecStore(db).upsert(id, opts.embed);
  }
  return id;
}

function insertDistillJob(db: DB, opts: { state: string; sessionId: string }) {
  db.prepare(`
    INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at)
    VALUES (?, 'distill', ?, ?, 0, ?, ?)
  `).run(randomUUID(), JSON.stringify({ session_id: opts.sessionId }), opts.state, Date.now(), Date.now());
}

describe('memory-health: contract shape + fail-safe (AC-4)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('empty DB — all zeros, no throw, no NaN/division-by-zero', () => {
    expect(() => buildMemoryHealthCheap(db)).not.toThrow();
    const cheap = buildMemoryHealthCheap(db);
    expect(cheap.activeCount).toBe(0);
    expect(cheap.archivedCount).toBe(0);
    expect(cheap.usefulness).toEqual({ served: 0, used: 0, coverageRate: null });
    expect(cheap.corrections).toEqual({ corrected: 0, rate: null });
    expect(cheap.poisonDistillSessions).toBe(0);
    expect(cheap.counts).toBeNull();
    expect(cheap.staleness).toBeNull();

    const full = buildMemoryHealthFull(db);
    expect(full.counts).toEqual({ active: 0, archived: 0, byType: {}, byScope: {} });
    expect(full.staleness!.every(b => b.count === 0)).toBe(true);
    for (const v of Object.values(full)) {
      if (typeof v === 'number') expect(Number.isNaN(v)).toBe(false);
    }
  });

  it('cheap tier shape matches MemoryHealthReport (generatedAt present, counts/staleness null)', () => {
    const report = buildMemoryHealthCheap(db);
    expect(typeof report.generatedAt).toBe('number');
    expect(report).toHaveProperty('activeCount');
    expect(report).toHaveProperty('archivedCount');
    expect(report).toHaveProperty('usefulness');
    expect(report).toHaveProperty('corrections');
    expect(report).toHaveProperty('poisonDistillSessions');
  });
});

describe('memory-health: cheap tier — counts, usefulness, corrections, poison sessions', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('activeCount/archivedCount reflect archived flag and valid_to', async () => {
    await seedMemory(db, 'active one');
    await seedMemory(db, 'active two');
    const archivedId = await seedMemory(db, 'archived one');
    db.prepare('UPDATE memories SET archived = 1 WHERE id = ?').run(archivedId);

    const report = buildMemoryHealthCheap(db);
    expect(report.activeCount).toBe(2);
    expect(report.archivedCount).toBe(1);
  });

  it('usefulness coverage: served/used distinct-atom counts + coverageRate = served/active', async () => {
    const a = await seedMemory(db, 'a');
    const b = await seedMemory(db, 'b');
    await seedMemory(db, 'c'); // never served

    recordRecallServed(db, { atomIds: [a, b], query: 'q', surface: 'rest' });
    recordRecallUsed(db, { atomId: a, surface: 'rest', signal: 'explicit' });

    const report = buildMemoryHealthCheap(db);
    expect(report.usefulness.served).toBe(2);
    expect(report.usefulness.used).toBe(1);
    expect(report.usefulness.coverageRate).toBeCloseTo(2 / 3, 5);
  });

  it('correction rate: distinct corrected atoms via invalidate/supersede events', async () => {
    const winner = await seedMemory(db, 'winner');
    const loser = await seedMemory(db, 'loser');
    await seedMemory(db, 'untouched');

    new MemoryEventRepo(db).supersede(loser, winner);

    const report = buildMemoryHealthCheap(db);
    expect(report.corrections.corrected).toBe(1);
    // active (winner + untouched, loser's valid_to is now set so it's not
    // active) = 2, corrected = 1 -> rate = 1 / (2 + 1)
    expect(report.corrections.rate).toBeCloseTo(1 / 3, 5);
  });

  it('poisonDistillSessions counts distinct sessions with a poison distill job, ignoring other kinds/states', () => {
    insertDistillJob(db, { state: 'poison', sessionId: 's1' });
    insertDistillJob(db, { state: 'poison', sessionId: 's1' }); // same session, dedup
    insertDistillJob(db, { state: 'poison', sessionId: 's2' });
    insertDistillJob(db, { state: 'pending', sessionId: 's3' }); // not poison
    db.prepare(`
      INSERT INTO jobs (id, kind, payload_json, state, attempts, created_at, updated_at)
      VALUES (?, 'reembed', ?, 'poison', 0, ?, ?)
    `).run(randomUUID(), JSON.stringify({ session_id: 's4' }), Date.now(), Date.now()); // not distill

    const report = buildMemoryHealthCheap(db);
    expect(report.poisonDistillSessions).toBe(2);
  });
});

describe('memory-health: full tier — byType/byScope + staleness (doctor/CLI only)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('byType/byScope group active memories only', async () => {
    await seedMemory(db, 'a fact', { type: 'fact', scope: 'private' });
    await seedMemory(db, 'a decision', { type: 'decision', scope: 'team' });
    const archived = await seedMemory(db, 'archived fact', { type: 'fact' });
    db.prepare('UPDATE memories SET archived = 1 WHERE id = ?').run(archived);

    const report = buildMemoryHealthFull(db);
    expect(report.counts!.byType).toEqual({ fact: 1, decision: 1 });
    expect(report.counts!.byScope).toEqual({ private: 1, team: 1 });
  });

  it('staleness buckets active memories by age over valid_from', async () => {
    const recent = await seedMemory(db, 'recent');
    const old = await seedMemory(db, 'old');
    const now = Date.now();
    db.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(now - 1 * 24 * 60 * 60 * 1000, recent);
    db.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(now - 200 * 24 * 60 * 60 * 1000, old);

    const report = buildMemoryHealthFull(db);
    const byLabel = Object.fromEntries(report.staleness!.map(b => [b.label, b.count]));
    expect(byLabel['0-7d']).toBe(1);
    expect(byLabel['180d+']).toBe(1);
  });
});

describe('memory-health: EXPLAIN QUERY PLAN — cheap tier rides existing indexes only', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('active/archived counts use idx_memories_archival_candidates', () => {
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(*) AS n FROM memories WHERE archived = 0 AND valid_to IS NULL
    `).all() as { detail: string }[];
    expect(plan.some(p => p.detail.includes('idx_memories_archival_candidates'))).toBe(true);
  });

  it('usefulness served/used counts (via usefulnessRate) use the migration-019 partial indexes', () => {
    // memory-health.ts's usefulnessCoverage() delegates to usefulnessRate()
    // rather than hand-rolling the query — this EXPLAIN mirrors that
    // function's actual SQL shape (created_at >= ? is required for the
    // planner to pick the partial index; omitting it falls back to
    // idx_memory_events_atom_seq instead, verified by hand while writing
    // this test).
    const servedPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(DISTINCT atom_id) AS n FROM memory_events
      WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'recall_served' AND created_at >= ?
    `).all(0) as { detail: string }[];
    expect(servedPlan.some(p => p.detail.includes('idx_memory_events_usefulness_served'))).toBe(true);

    const usedPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(DISTINCT atom_id) AS n FROM memory_events
      WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'recall_used' AND created_at >= ?
    `).all(0) as { detail: string }[];
    expect(usedPlan.some(p => p.detail.includes('idx_memory_events_usefulness_used'))).toBe(true);
  });

  it('correction count uses the migration-020 partial index', () => {
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(DISTINCT atom_id) AS n FROM memory_events
      WHERE event_type IN ('invalidate', 'supersede')
    `).all() as { detail: string }[];
    expect(plan.some(p => p.detail.includes('idx_memory_events_correction_type'))).toBe(true);
  });

  it('poison-distill-session count uses idx_jobs_state (state as the equality prefix)', () => {
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT COUNT(DISTINCT json_extract(payload_json, '$.session_id')) AS n
      FROM jobs WHERE state = 'poison' AND kind = 'distill'
    `).all() as { detail: string }[];
    expect(plan.some(p => p.detail.includes('idx_jobs_state'))).toBe(true);
  });
});

describe('memory-health-deep: near-duplicate estimate (CLI-only, bounded sample)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('flags a near-identical pair above threshold, within a (repo,type) group', async () => {
    await seedMemory(db, 'port is 7777', { embed: vecAt(0, 0.01) });
    await seedMemory(db, 'the port is 7777', { embed: vecAt(0, 0.02) });

    const result = estimateNearDuplicates(db);
    expect(result.sampledPairs).toBeGreaterThan(0);
    expect(result.nearDuplicatePairs).toBe(1);
    expect(result.rate).toBeCloseTo(1, 5);
    expect(result.bound.threshold).toBe(0.85);
  });

  it('never compares across (repo,type) groups', async () => {
    await seedMemory(db, 'same vector', { embed: vecAt(0), repo: 'r1' });
    await seedMemory(db, 'same vector', { embed: vecAt(0), repo: 'r2' });

    const result = estimateNearDuplicates(db);
    expect(result.sampledPairs).toBe(0);
    expect(result.nearDuplicatePairs).toBe(0);
    expect(result.rate).toBeNull();
  });

  it('empty DB — zeros, no throw', () => {
    expect(() => estimateNearDuplicates(db)).not.toThrow();
    const result = estimateNearDuplicates(db);
    expect(result.scannedGroups).toBe(0);
    expect(result.sampledPairs).toBe(0);
    expect(result.rate).toBeNull();
  });
});

describe('memory-health-deep: junk heuristic (CLI-only, bounded sample)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('flags ultra-short, low-importance, and never-recalled atoms', async () => {
    await seedMemory(db, 'ok', { importance: 0.9 }); // ultra-short
    await seedMemory(db, 'a reasonably long piece of text', { importance: 0.1 }); // low-importance
    await seedMemory(db, 'a reasonably long piece of text too', { importance: 0.9 }); // never-recalled
    const healthy = await seedMemory(db, 'a perfectly healthy, well-used memory', { importance: 0.9 });
    recordRecallServed(db, { atomIds: [healthy], query: 'q', surface: 'rest' });

    const result = estimateJunkHeuristic(db);
    expect(result.sampledCount).toBe(4);
    expect(result.ultraShortCount).toBe(1);
    expect(result.lowImportanceCount).toBe(1);
    expect(result.neverRecalledCount).toBe(3); // every atom except `healthy`
    expect(result.junkCount).toBe(3);
    expect(result.rate).toBeCloseTo(0.75, 5);
  });

  it('empty DB — zeros, no throw', () => {
    expect(() => estimateJunkHeuristic(db)).not.toThrow();
    const result = estimateJunkHeuristic(db);
    expect(result.sampledCount).toBe(0);
    expect(result.rate).toBeNull();
  });
});

describe('memory-health-deep: LLM-judged junk sample — AC-5 (off by default, no provider call unless enabled)', () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('enabled=false: returns zeros immediately, provider is never constructed or called', async () => {
    let called = false;
    const provider: LLMProvider = {
      name: 'ollama',
      model: 'test',
      async chat(_messages: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
        called = true;
        return { text: '', usage: { in: 0, out: 0, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test', latency_ms: 0 };
      },
    };
    await seedMemory(db, 'some memory text here');

    const result = await estimateLlmJudgedJunk(db, { enabled: false, provider });
    expect(result).toEqual({ enabled: false, sampledCount: 0, judgedJunkCount: 0, rate: null });
    expect(called).toBe(false);
  });

  it('enabled=true with a mock provider: parses JUNK/KEEP lines from the response', async () => {
    const provider: LLMProvider = {
      name: 'ollama',
      model: 'test',
      async chat(messages: ChatMsg[]): Promise<ChatResult> {
        const userMsg = messages.find(m => m.role === 'user')!.content;
        const n = userMsg.split('\n').filter(l => l.trim().length > 0).length;
        const lines = Array.from({ length: n }, (_, i) => `${i + 1}: ${i === 0 ? 'JUNK' : 'KEEP'}`);
        return { text: lines.join('\n'), usage: { in: 0, out: 0, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test', latency_ms: 0 };
      },
    };
    await seedMemory(db, 'ok');
    await seedMemory(db, 'a longer more meaningful memory');

    const result = await estimateLlmJudgedJunk(db, { enabled: true, provider, sampleBound: 5 });
    expect(result.enabled).toBe(true);
    expect(result.sampledCount).toBe(2);
    expect(result.judgedJunkCount).toBe(1);
    expect(result.rate).toBeCloseTo(0.5, 5);
  });

  it('enabled=true but provider unreachable: degrades to zeros, never throws', async () => {
    const provider: LLMProvider = {
      name: 'ollama',
      model: 'test',
      async chat(): Promise<ChatResult> {
        throw new Error('connection refused');
      },
      async health(): Promise<LLMHealth> {
        return { ok: false, model: 'test', latency_ms: 0, error: 'connection refused' };
      },
    };
    await seedMemory(db, 'a memory');

    const result = await estimateLlmJudgedJunk(db, { enabled: true, provider });
    expect(result.enabled).toBe(true);
    expect(result.judgedJunkCount).toBe(0);
    expect(result.rate).toBeNull();
  });
});
