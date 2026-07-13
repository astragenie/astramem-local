/**
 * FEAT-454: named retrieval presets — REST (GET /search, POST /recall) and
 * MCP (search_memory, recall_memory) surface parity. Mirrors the harness
 * pattern in tests/mcp/search-parity.test.ts (real Fastify server, real
 * `POST /mcp` Streamable HTTP transport, no internal reach-in).
 *
 * AC-1 (byte-identical default ranking) has its own dedicated snapshot test
 * against the ADR-005 eval harness — see the "AC-1: preset=default byte-
 * identical ranking snapshot" describe block in
 * tests/eval/retrieval-eval.test.ts. This file covers request-shape
 * behavior: preset routing end-to-end, and the AC-3 400/isError cases.
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

const TOKEN = 'test-preset-parity-token';

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

function seedMemory(repo: MemoryRepo, text: string, repoName = 'myrepo') {
  return repo.insert({
    type: 'decision',
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

async function toolCall(baseUrl: string, name: string, args: object): Promise<{ payload: unknown; isError: boolean; rpcError: boolean }> {
  const resp = await mcpPost(baseUrl, {
    jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 1,
  }) as { error?: unknown; result?: { content?: Array<{ type: string; text: string }>; isError?: boolean } };
  const text = resp.result?.content?.[0]?.text ?? '{}';
  return { payload: JSON.parse(text), isError: resp.result?.isError === true, rpcError: resp.error !== undefined };
}

describe('FEAT-454 named retrieval presets', () => {
  let db: DB;
  let app: FastifyInstance;
  let baseUrl: string;
  let repo: MemoryRepo;

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

  describe('AC-1: preset omitted vs preset="default" (REST)', () => {
    // Two separate live HTTP round-trips necessarily land at (imperceptibly)
    // different wall-clock instants, and the δ (freshness) fusion component
    // is a function of `Date.now()` at call time — so a strict deep-equal on
    // raw float `score` is inherently flaky here, not a preset-routing bug.
    // "Byte-identical ranking" (AC-1) means ranking ORDER and every
    // non-time-derived field are identical; the dedicated
    // resolvePresetWeights unit test (tests/search/presets.test.ts) plus the
    // ADR-005 eval-harness snapshot (tests/eval/retrieval-eval.test.ts,
    // single process clock) cover the exact-weights-equality guarantee.
    function shape(hits: Array<{ id: string; type: string; text: string; source: string }>) {
      return hits.map(h => ({ id: h.id, type: h.type, text: h.text, source: h.source }));
    }

    it('GET /search returns identically-ordered, identically-shaped hits with preset omitted vs preset=default', async () => {
      seedMemory(repo, 'adopt postgres as the canonical store decision');
      seedMemory(repo, 'reject mysql for the canonical store decision');

      const omitted = await fetch(`${baseUrl}/search?q=canonical+store+decision`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }).then(r => r.json()) as { hits: Array<{ id: string; type: string; text: string; source: string }> };
      const explicit = await fetch(`${baseUrl}/search?q=canonical+store+decision&preset=default`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }).then(r => r.json()) as { hits: Array<{ id: string; type: string; text: string; source: string }> };

      expect(shape(explicit.hits)).toEqual(shape(omitted.hits));
    });

    it('POST /recall returns identically-ordered, identically-shaped hits with preset omitted vs preset=default', async () => {
      seedMemory(repo, 'adopt postgres as the canonical store decision');
      seedMemory(repo, 'reject mysql for the canonical store decision');

      async function recall(body: object) {
        const res = await fetch(`${baseUrl}/recall`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify(body),
        });
        return res.json() as Promise<{ hits: Array<{ id: string; type: string; text: string; source: string }> }>;
      }

      const omitted = await recall({ text: 'canonical store decision', limit: 10 });
      const explicit = await recall({ text: 'canonical store decision', limit: 10, preset: 'default' });
      expect(shape(explicit.hits)).toEqual(shape(omitted.hits));
    });
  });

  it('an out-of-enum preset value is a 400 on GET /search', async () => {
    const res = await fetch(`${baseUrl}/search?q=foo&preset=bogus`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
  });

  it('an out-of-enum preset value is a 400 on POST /recall', async () => {
    const res = await fetch(`${baseUrl}/recall`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ text: 'foo', preset: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });

  describe.each(['search_memory', 'recall_memory'] as const)('%s preset routing', (toolName) => {
    function argKey() { return toolName === 'search_memory' ? 'limit' : 'k'; }

    it('preset=recent is accepted and returns results', async () => {
      seedMemory(repo, 'adopt postgres as the canonical store decision');
      const result = await toolCall(baseUrl, toolName, {
        query: 'canonical store decision', [argKey()]: 10, preset: 'recent',
      });
      expect(result.isError).toBe(false);
      expect((result.payload as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
    });

    it('preset=exact is accepted and returns results', async () => {
      seedMemory(repo, 'adopt postgres as the canonical store decision');
      const result = await toolCall(baseUrl, toolName, {
        query: 'canonical store decision', [argKey()]: 10, preset: 'exact',
      });
      expect(result.isError).toBe(false);
      expect((result.payload as { hits: unknown[] }).hits.length).toBeGreaterThan(0);
    });

    it('AC-3: preset=entity without an entity filter is a clear error naming the missing filter', async () => {
      const result = await toolCall(baseUrl, toolName, {
        query: 'canonical store decision', [argKey()]: 10, preset: 'entity',
      });
      expect(result.isError).toBe(true);
      expect((result.payload as { error: string }).error).toMatch(/entity/i);
    });

    it('preset=entity WITH an entity filter succeeds (routes to the existing entity filter)', async () => {
      const linked = seedMemory(repo, 'adopt postgres as the canonical store decision');
      const unlinked = seedMemory(repo, 'reject mysql for the canonical store decision');
      const entities = new EntityRepo(db);
      const entId = entities.upsert('postgres', 'tech');
      entities.link(linked, entId);

      const result = await toolCall(baseUrl, toolName, {
        query: 'canonical store decision', [argKey()]: 10, preset: 'entity', entity: 'postgres',
      });
      expect(result.isError).toBe(false);
      const ids = (result.payload as { hits: Array<{ id: string }> }).hits.map(h => h.id);
      expect(ids).toContain(linked);
      expect(ids).not.toContain(unlinked);
    });

    it('AC-3: preset=temporal without an as_of filter is a clear error naming the missing filter', async () => {
      const result = await toolCall(baseUrl, toolName, {
        query: 'canonical store decision', [argKey()]: 10, preset: 'temporal',
      });
      expect(result.isError).toBe(true);
      expect((result.payload as { error: string }).error).toMatch(/as_of/i);
    });

    it('preset=temporal WITH an as_of filter succeeds (routes to the existing bitemporal filter)', async () => {
      const t0 = 1_600_000_000_000; // 2020-09-13 — MUST be in the past: supersede/invalidate stamp valid_to = Date.now(), so a superseded row is always already expired by query time. A future base instant made superseded rows look "not expired yet" once the default filter learned to tell unbounded from currently-valid.
      const t1 = t0 + 1000;
      const t2 = t0 + 2000;
      const oldId = seedMemory(repo, 'gen1(old): adopt postgres canonical store decision');
      const newId = seedMemory(repo, 'gen2(new): adopt postgres canonical store decision refined');
      db.prepare('UPDATE memories SET valid_from = ?, valid_to = ?, superseded_by = ? WHERE id = ?')
        .run(t0, t2, newId, oldId);
      db.prepare('UPDATE memories SET valid_from = ?, valid_to = NULL WHERE id = ?').run(t2, newId);

      const result = await toolCall(baseUrl, toolName, {
        query: 'postgres canonical store', [argKey()]: 10, preset: 'temporal',
        as_of: new Date(t1).toISOString(),
      });
      expect(result.isError).toBe(false);
      const ids = (result.payload as { hits: Array<{ id: string }> }).hits.map(h => h.id);
      expect(ids).toContain(oldId);
      expect(ids).not.toContain(newId);
    });

    it('an out-of-enum preset value is rejected (JSON-RPC error or tool isError)', async () => {
      // A zod inputSchema rejection at the MCP SDK layer returns a
      // human-readable "MCP error ..." string, not JSON — so this checks the
      // raw JSON-RPC envelope shape directly (mirrors the equivalent
      // `remember` schema-rejection case in tests/mcp/server.test.ts) instead
      // of going through the `toolCall` helper's `JSON.parse` on content text.
      const resp = await mcpPost(baseUrl, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: toolName, arguments: { query: 'canonical store decision', [argKey()]: 10, preset: 'bogus' } },
        id: 1,
      }) as { error?: unknown; result?: { isError?: boolean } };
      const rejected = resp.error !== undefined || resp.result?.isError === true;
      expect(rejected).toBe(true);
    });
  });
});
