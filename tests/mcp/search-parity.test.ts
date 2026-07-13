/**
 * FEAT-417b: MCP filter parity — search_memory / recall_memory gain the
 * as_of + entity params that GET /search and POST /recall already have.
 * Both params are wired to the existing SearchFilters (src/search/search.ts)
 * so semantics (including the AC-9 entity normalize seam) are inherited, not
 * reimplemented.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { makeFakeVec } from '../../src/search/search.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { EntityRepo } from '../../src/storage/entities.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../src/storage/db.js';

const TOKEN = 'test-mcp-parity-token';

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

function seedMemory(repo: MemoryRepo, text: string, type: 'decision' | 'fact' = 'decision', repoName = 'myrepo') {
  return repo.insert({
    type,
    text,
    normalized_text: text.toLowerCase(),
    repo: repoName,
    project: null,
    branch: null,
    agent: null,
    session_id: null,
    hash: Buffer.from(text).toString('hex').slice(0, 32),
    source_hash: null,
    importance: 0.8,
  });
}

async function mcpPost(baseUrl: string, body: object): Promise<unknown> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error(`Empty MCP response (status ${res.status})`);
  for (const line of lines) {
    const src = line.startsWith('data: ') ? line.slice(6) : line;
    try {
      return JSON.parse(src);
    } catch {
      // skip non-JSON lines
    }
  }
  throw new Error(`No parseable JSON in MCP response:\n${text}`);
}

async function toolCall(baseUrl: string, name: string, args: object): Promise<{ payload: unknown; isError: boolean }> {
  const resp = await mcpPost(baseUrl, {
    jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 1,
  }) as { result?: { content?: Array<{ type: string; text: string }>; isError?: boolean } };
  const text = resp.result?.content?.[0]?.text ?? '{}';
  return { payload: JSON.parse(text), isError: resp.result?.isError === true };
}

describe.each(['search_memory', 'recall_memory'] as const)('%s as_of + entity parity (FEAT-417b)', (toolName) => {
  let db: DB;
  let app: FastifyInstance;
  let baseUrl: string;
  let repo: MemoryRepo;
  const t0 = 1_600_000_000_000; // 2020-09-13 — MUST be in the past: supersede/invalidate stamp valid_to = Date.now(), so a superseded row is always already expired by query time. A future base instant made superseded rows look "not expired yet" once the default filter learned to tell unbounded from currently-valid.
  const t1 = t0 + 1000;
  const t2 = t0 + 2000;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: TOKEN, embed: buildMockEmbed() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  function seedSupersededPair(): { oldId: string; newId: string } {
    const oldId = seedMemory(repo, 'gen1(old): adopt postgres canonical store decision');
    const newId = seedMemory(repo, 'gen2(new): adopt postgres canonical store decision refined');
    db.prepare('UPDATE memories SET valid_from = ?, valid_to = ?, superseded_by = ? WHERE id = ?')
      .run(t0, t2, newId, oldId);
    db.prepare('UPDATE memories SET valid_from = ?, valid_to = NULL WHERE id = ?').run(t2, newId);
    return { oldId, newId };
  }

  it('as_of in the past returns the old memory, excludes the successor', async () => {
    const { oldId, newId } = seedSupersededPair();
    const argKey = toolName === 'search_memory' ? 'limit' : 'k';
    const result = await toolCall(baseUrl, toolName, {
      query: 'postgres canonical store',
      [argKey]: 10,
      as_of: new Date(t1).toISOString(),
    });
    expect(result.isError).toBe(false);
    const ids = (result.payload as { hits: Array<{ id: string }> }).hits.map(h => h.id);
    expect(ids).toContain(oldId);
    expect(ids).not.toContain(newId);
  });

  it('omitting as_of returns current-snapshot behavior (successor only)', async () => {
    const { oldId, newId } = seedSupersededPair();
    const argKey = toolName === 'search_memory' ? 'limit' : 'k';
    const result = await toolCall(baseUrl, toolName, {
      query: 'postgres canonical store',
      [argKey]: 10,
    });
    expect(result.isError).toBe(false);
    const ids = (result.payload as { hits: Array<{ id: string }> }).hits.map(h => h.id);
    expect(ids).toContain(newId);
    expect(ids).not.toContain(oldId);
  });

  it('an unparseable as_of returns isError, mirroring the REST 400', async () => {
    const argKey = toolName === 'search_memory' ? 'limit' : 'k';
    const result = await toolCall(baseUrl, toolName, {
      query: 'postgres',
      [argKey]: 5,
      as_of: 'not-a-date',
    });
    expect(result.isError).toBe(true);
    expect((result.payload as { error: string }).error).toMatch(/invalid as_of/);
  });

  it('entity filter returns all-and-only entity-linked members', async () => {
    const linked = seedMemory(repo, 'adopt postgres as the canonical store decision');
    const unlinked = seedMemory(repo, 'postgres canonical store rejected alternative decision');
    const entities = new EntityRepo(db);
    const entId = entities.upsert('postgres', 'tech');
    entities.link(linked, entId);

    const argKey = toolName === 'search_memory' ? 'limit' : 'k';
    const result = await toolCall(baseUrl, toolName, {
      query: 'postgres canonical store',
      [argKey]: 10,
      entity: 'postgres',
    });
    expect(result.isError).toBe(false);
    const ids = (result.payload as { hits: Array<{ id: string }> }).hits.map(h => h.id);
    expect(ids).toContain(linked);
    expect(ids).not.toContain(unlinked);
  });

  it('entity filter normalizes case/whitespace (AC-9 seam) — "Postgres" matches linked entity "postgres"', async () => {
    const linked = seedMemory(repo, 'adopt postgres as the canonical store decision');
    const entities = new EntityRepo(db);
    const entId = entities.upsert('postgres', 'tech');
    entities.link(linked, entId);

    const argKey = toolName === 'search_memory' ? 'limit' : 'k';
    const result = await toolCall(baseUrl, toolName, {
      query: 'postgres canonical store',
      [argKey]: 10,
      entity: '  Postgres  ',
    });
    expect(result.isError).toBe(false);
    const ids = (result.payload as { hits: Array<{ id: string }> }).hits.map(h => h.id);
    expect(ids).toContain(linked);
  });

  it('an unresolvable entity name returns zero hits, not an unfiltered search', async () => {
    seedMemory(repo, 'postgres canonical store decision');
    const argKey = toolName === 'search_memory' ? 'limit' : 'k';
    const result = await toolCall(baseUrl, toolName, {
      query: 'postgres canonical store',
      [argKey]: 10,
      entity: 'nonexistent-entity',
    });
    expect(result.isError).toBe(false);
    expect((result.payload as { hits: unknown[] }).hits).toEqual([]);
  });

  it('MCP result set matches the equivalent REST call for the same as_of + query', async () => {
    const { oldId, newId } = seedSupersededPair();
    const asOfIso = new Date(t1).toISOString();

    const restRes = await fetch(
      `${baseUrl}/search?q=${encodeURIComponent('postgres canonical store')}&as_of=${asOfIso}`,
      { headers: { authorization: `Bearer ${TOKEN}` } }
    );
    const restBody = await restRes.json() as { hits: Array<{ id: string }> };

    const argKey = toolName === 'search_memory' ? 'limit' : 'k';
    const mcpResult = await toolCall(baseUrl, toolName, {
      query: 'postgres canonical store',
      [argKey]: 10,
      as_of: asOfIso,
    });
    const mcpIds = (mcpResult.payload as { hits: Array<{ id: string }> }).hits.map(h => h.id).sort();
    const restIds = restBody.hits.map(h => h.id).sort();

    expect(mcpIds).toEqual(restIds);
    expect(restIds).toContain(oldId);
    expect(restIds).not.toContain(newId);
  });
});
