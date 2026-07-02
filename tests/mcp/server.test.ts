/**
 * MCP server integration tests.
 *
 * Strategy: start the daemon on a random port via Fastify.listen(), send
 * real HTTP POST /mcp requests, then tear down.  Fastify.inject() cannot be
 * used here because the MCP route calls reply.hijack() and lets the SDK
 * write directly to the raw Node ServerResponse.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { makeFakeVec } from '../../src/search/search.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../src/storage/db.js';

const TOKEN = 'test-mcp-token';

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

/** POST a JSON-RPC message to POST /mcp and return the parsed response body. */
async function mcpPost(baseUrl: string, body: object): Promise<unknown> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // MCP Streamable HTTP spec requires clients to accept both JSON and SSE.
      // The SDK enforces this and returns 406 if this header is absent.
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // The transport may return multiple newline-delimited JSON objects (NDJSON)
  // or a single JSON object.  Parse the last non-empty line.
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new Error(`Empty MCP response (status ${res.status})`);
  // Find the first line that is valid JSON (skip SSE event lines like "data: ...")
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

describe('POST /mcp — MCP Streamable HTTP transport', () => {
  let db: DB;
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN, embed: buildMockEmbed() });
    // Listen on a random OS-assigned port
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // tools/list
  // -------------------------------------------------------------------------

  it('initialize + tools/list returns 5 tools', async () => {
    // MCP requires an initialize handshake first in stateful mode.
    // In stateless mode (sessionIdGenerator: undefined) the SDK processes
    // each request independently, so tools/list works without initialize.
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: 1,
    }) as { result?: { tools?: Array<{ name: string }> }; error?: unknown };

    expect(resp).toHaveProperty('result');
    const tools = resp.result?.tools ?? [];
    expect(tools.length).toBe(5);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['get_health', 'recall_memory', 'remember', 'search_memory', 'why_memory']);
  });

  // -------------------------------------------------------------------------
  // get_health
  // -------------------------------------------------------------------------

  it('tools/call get_health returns { ok: true, version }', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'get_health', arguments: {} },
      id: 2,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    const text = resp.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as { ok: boolean; version: string };
    expect(payload.ok).toBe(true);
    expect(typeof payload.version).toBe('string');
  });

  // -------------------------------------------------------------------------
  // remember
  // -------------------------------------------------------------------------

  it('tools/call remember inserts a memory and returns { id, ok: true }', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'remember',
        arguments: { text: 'mcp smoke test memory', type: 'fact' },
      },
      id: 3,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    const text = resp.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as { id: string; ok: boolean };
    expect(payload.ok).toBe(true);
    expect(typeof payload.id).toBe('string');
    expect(payload.id.length).toBeGreaterThan(0);

    // Verify it was actually persisted
    const row = db.prepare('SELECT id FROM memories WHERE id = ?').get(payload.id);
    expect(row).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // search_memory
  // -------------------------------------------------------------------------

  it('tools/call search_memory returns hits array', async () => {
    // Insert a memory first
    await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'remember',
        arguments: { text: 'prefer zod for runtime validation', type: 'lesson' },
      },
      id: 10,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'search_memory',
        arguments: { query: 'zod validation', limit: 5 },
      },
      id: 11,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    const text = resp.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as { hits: unknown[] };
    expect(Array.isArray(payload.hits)).toBe(true);
    expect(payload.hits.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // recall_memory
  // -------------------------------------------------------------------------

  it('tools/call recall_memory returns hits array', async () => {
    await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'remember',
        arguments: { text: 'use fastify for the HTTP daemon', type: 'decision' },
      },
      id: 20,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'recall_memory',
        arguments: { query: 'fastify http server', k: 3 },
      },
      id: 21,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    const text = resp.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as { hits: unknown[] };
    expect(Array.isArray(payload.hits)).toBe(true);
    expect(payload.hits.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // why_memory
  // -------------------------------------------------------------------------

  it('tools/call why_memory returns a receipt with evidence + session block', async () => {
    db.prepare(
      'INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s1', 'astramem-local', null, 'main', 'claude-code', 1000);
    const id = new MemoryRepo(db).insert({
      type: 'decision', text: 'Use SQLite', normalized_text: 'use SQLite',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: 's1', hash: 'h-mcp-why-1', source_hash: 'src-abc',
      evidence: 'zero-config local file decided in review',
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'why_memory', arguments: { id } },
      id: 30,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    const text = resp.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as {
      evidence: string;
      session: { id: string; repo: string } | null;
      transcript_ref: string;
      history: unknown[];
    };
    expect(payload.evidence).toBe('zero-config local file decided in review');
    expect(payload.session).toMatchObject({ id: 's1', repo: 'astramem-local' });
    expect(payload.transcript_ref).toBe('src-abc');
    expect(payload.history).toEqual([]);
  });

  it('tools/call why_memory with unknown id returns isError', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'why_memory', arguments: { id: 'nope' } },
      id: 31,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    expect(resp.result?.isError).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('POST /mcp without Bearer returns 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 99 }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /mcp with wrong token returns 401', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 99 }),
    });
    expect(res.status).toBe(401);
  });
});
