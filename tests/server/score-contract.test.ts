/**
 * SLICE-411: response-side [0,1] score wire contract enforcement at the
 * daemon's serialization boundary — independent of fuseScores() internal
 * math. Covers the shared clampScore/clampScores helper directly, plus the
 * three serialization sites it is wired into: GET /search, POST /recall, and
 * POST /recall/pack.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { warnMock, mockLog } = vi.hoisted(() => {
  const warnMock = vi.fn();
  const mockLog: Record<string, unknown> = {
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  mockLog['child'] = vi.fn(() => mockLog);
  return { warnMock, mockLog };
});

vi.mock('../../src/log/logger.js', () => ({
  logger: mockLog,
  childLogger: vi.fn(() => mockLog),
}));

import { clampScore, clampScores } from '../../src/server/lib/score-contract.js';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { buildApp } from '../../src/server/app.js';
import type { SearchHit } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { DB } from '../../src/storage/db.js';

// Mutable box read by the mocked search() below — lets each test control the
// exact (possibly out-of-contract) hits returned, without touching fuseScores.
const fakeHits: { value: SearchHit[] } = { value: [] };

vi.mock('../../src/search/search.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/search/search.js')>();
  return {
    ...actual,
    search: vi.fn(async () => fakeHits.value),
  };
});

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(() => new Array(1024).fill(0)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

// atom@2 repo/project consolidation (plan 20260709): the /recall/pack tests
// below call selectPack, which now filters on `project` — real ingest
// always derives `project` from `repo` (src/pipeline/derive-project.ts), so
// this fixture mirrors that instead of leaving `project` null.
function seedMemory(repo: MemoryRepo, text: string, type = 'decision', importance = 0.5) {
  return repo.insert({
    type: type as 'decision' | 'fact' | 'lesson' | 'command' | 'todo',
    text,
    normalized_text: text.toLowerCase(),
    repo: 'myrepo',
    project: 'myrepo',
    branch: null,
    agent: null,
    session_id: null,
    hash: Buffer.from(text).toString('hex').slice(0, 32),
    source_hash: null,
    importance,
  });
}

describe('clampScore', () => {
  beforeEach(() => warnMock.mockClear());

  it('passes an in-contract value through unchanged with no warning', () => {
    expect(clampScore(0.42, { route: 'unit', id: 'x' })).toBe(0.42);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('passes 0 and 1 (the boundary values) through unchanged with no warning', () => {
    expect(clampScore(0, { route: 'unit', id: 'x' })).toBe(0);
    expect(clampScore(1, { route: 'unit', id: 'x' })).toBe(1);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('clamps a value above 1 down to 1 and logs a warning with route + id', () => {
    expect(clampScore(1.7, { route: 'GET /search', id: 'mem-1' })).toBe(1);
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [fields] = warnMock.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields['route']).toBe('GET /search');
    expect(fields['id']).toBe('mem-1');
  });

  it('clamps a value below 0 up to 0 and logs a warning', () => {
    expect(clampScore(-0.3, { route: 'POST /recall', id: 'mem-2' })).toBe(0);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('maps NaN to a finite 0 and logs a warning', () => {
    const result = clampScore(NaN, { route: 'POST /recall', id: 'mem-3' });
    expect(result).toBe(0);
    expect(Number.isFinite(result)).toBe(true);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('maps +Infinity to 1 and -Infinity to 0, logging a warning each time', () => {
    expect(clampScore(Infinity, { route: 'unit', id: 'x' })).toBe(1);
    expect(clampScore(-Infinity, { route: 'unit', id: 'x' })).toBe(0);
    expect(warnMock).toHaveBeenCalledTimes(2);
  });
});

describe('clampScores (array helper)', () => {
  beforeEach(() => warnMock.mockClear());

  it('returns the same item reference when its score is already in-contract', () => {
    const item = { id: 'a', score: 0.5 };
    const [result] = clampScores([item], 'unit');
    expect(result).toBe(item);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('clamps only the out-of-contract items, one warning per offender', () => {
    const items = [
      { id: 'ok', score: 0.3 },
      { id: 'high', score: 5 },
      { id: 'low', score: -5 },
    ];
    const result = clampScores(items, 'unit');
    expect(result[0]?.score).toBe(0.3);
    expect(result[1]?.score).toBe(1);
    expect(result[2]?.score).toBe(0);
    expect(warnMock).toHaveBeenCalledTimes(2);
  });
});

describe('GET /search and POST /recall — serialization boundary (mocked search())', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
    warnMock.mockClear();
  });

  it('AC-2: a hit above 1 is clamped to 1 at the response boundary, warning logged, status 200', async () => {
    fakeHits.value = [{ id: 'hit-1', type: 'decision', text: 'x', score: 1.9, source: 'fts' }] as SearchHit[];
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=anything',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    const hits = res.json().hits as Array<{ id: string; score: number }>;
    expect(hits[0]?.score).toBe(1);
    expect(warnMock).toHaveBeenCalled();
  });

  it('AC-2: a hit below 0 is clamped to 0 at the response boundary via POST /recall, warning logged, status 200', async () => {
    fakeHits.value = [{ id: 'hit-2', type: 'fact', text: 'x', score: -0.4, source: 'vec' }] as SearchHit[];
    const res = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { query: 'anything', k: 5 },
    });
    expect(res.statusCode).toBe(200);
    const hits = res.json().hits as Array<{ id: string; score: number }>;
    expect(hits[0]?.score).toBe(0);
    expect(warnMock).toHaveBeenCalled();
  });

  it('AC-3: a NaN hit score serializes as a finite 0, warning logged, status still 200', async () => {
    fakeHits.value = [{ id: 'hit-3', type: 'decision', text: 'x', score: NaN, source: 'both' }] as SearchHit[];
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=anything',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    const hits = res.json().hits as Array<{ id: string; score: number }>;
    expect(hits[0]?.score).toBe(0);
    expect(Number.isFinite(hits[0]?.score)).toBe(true);
    expect(warnMock).toHaveBeenCalled();
  });

  it('AC-4: in-contract scores pass through bit-identical with NO warning on GET /search', async () => {
    fakeHits.value = [
      { id: 'hit-4', type: 'decision', text: 'x', score: 0.73, source: 'fts' },
      { id: 'hit-5', type: 'fact', text: 'y', score: 0, source: 'vec' },
      { id: 'hit-6', type: 'lesson', text: 'z', score: 1, source: 'both' },
    ] as SearchHit[];
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=anything',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    const hits = res.json().hits as Array<{ id: string; score: number }>;
    expect(hits.map(h => h.score)).toEqual([0.73, 0, 1]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('AC-4: in-contract scores pass through bit-identical with NO warning on POST /recall', async () => {
    fakeHits.value = [{ id: 'hit-7', type: 'decision', text: 'x', score: 0.11, source: 'fts' }] as SearchHit[];
    const res = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { query: 'anything', k: 5 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hits[0].score).toBe(0.11);
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('POST /recall/pack — a real non-fuseScores scoring path (selectPack) is clamped too', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
    warnMock.mockClear();
  });

  it('AC-2: an out-of-contract importance value (2.5, injected without touching fuseScores) yields a clamped score in the response, warning logged, status 200', async () => {
    // selectPack's score = typeWeight * recency * importance. importance is
    // only Zod-bounded to [0,1] on the /remember route — nothing stops a raw
    // insert (or a future importance-recompute path) from writing outside
    // that range, and selectPack never touches fuseScores at all.
    seedMemory(repo, 'a decision memory with runaway importance', 'decision', 2.5);

    const res = await app.inject({
      method: 'POST',
      url: '/recall/pack',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { repo: 'myrepo' },
    });

    expect(res.statusCode).toBe(200);
    const memories = res.json().memories as Array<{ id: string; score: number }>;
    expect(memories.length).toBeGreaterThan(0);
    for (const m of memories) {
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(1);
    }
    expect(warnMock).toHaveBeenCalled();
  });

  it('AC-4: normal importance stays in-contract with NO warning', async () => {
    seedMemory(repo, 'a normal decision memory', 'decision', 0.6);

    const res = await app.inject({
      method: 'POST',
      url: '/recall/pack',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { repo: 'myrepo' },
    });

    expect(res.statusCode).toBe(200);
    const memories = res.json().memories as Array<{ id: string; score: number }>;
    expect(memories.length).toBeGreaterThan(0);
    for (const m of memories) {
      expect(m.score).toBeGreaterThanOrEqual(0);
      expect(m.score).toBeLessThanOrEqual(1);
    }
    expect(warnMock).not.toHaveBeenCalled();
  });
});

describe('MCP tool serialization boundary (search_memory / recall_memory)', () => {
  // Reviewer follow-up (SLICE-411 review, MEDIUM): src/mcp/server.ts
  // serializes the same SearchHit[] via JSON.stringify({hits}) — a second
  // wire boundary with the identical failure mode. The MCP route calls
  // reply.hijack(), so Fastify.inject() cannot be used; listen on a random
  // port and POST real JSON-RPC like tests/mcp/server.test.ts does.
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let baseUrl: string;

  beforeEach(async () => {
    warnMock.mockClear();
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  async function mcpToolCall(name: string, args: object): Promise<{ hits: Array<{ id: string; score: number }> }> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer tok',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 1 }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
      const src = line.startsWith('data: ') ? line.slice(6) : line;
      try {
        const parsed = JSON.parse(src) as { result?: { content?: Array<{ text: string }> } };
        return JSON.parse(parsed.result?.content?.[0]?.text ?? '{}') as { hits: Array<{ id: string; score: number }> };
      } catch { /* skip non-JSON lines */ }
    }
    throw new Error(`No parseable JSON in MCP response:\n${text}`);
  }

  it('AC-2 (MCP): out-of-contract scores are clamped in search_memory responses, warning logged', async () => {
    fakeHits.value = [
      { id: 'mcp-1', type: 'decision', text: 'x', score: 1.9, source: 'fts' },
      { id: 'mcp-2', type: 'fact', text: 'y', score: -0.4, source: 'vec' },
    ] as SearchHit[];
    const payload = await mcpToolCall('search_memory', { query: 'anything', limit: 5 });
    expect(payload.hits.map(h => h.score)).toEqual([1, 0]);
    expect(warnMock).toHaveBeenCalledTimes(2);
  });

  it('AC-3/AC-4 (MCP): NaN clamps to 0 in recall_memory while in-contract scores pass through bit-identical', async () => {
    fakeHits.value = [
      { id: 'mcp-3', type: 'decision', text: 'x', score: NaN, source: 'both' },
      { id: 'mcp-4', type: 'fact', text: 'y', score: 0.7331, source: 'fts' },
    ] as SearchHit[];
    const payload = await mcpToolCall('recall_memory', { query: 'anything', k: 5 });
    expect(payload.hits.map(h => h.score)).toEqual([0, 0.7331]);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
