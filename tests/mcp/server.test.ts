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
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { PKG_VERSION } from '../../src/server/lib/wire-meta.js';
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

  it('initialize + tools/list returns 11 tools', async () => {
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
    expect(tools.length).toBe(11);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'get_health',
      'invalidate_memory',
      'mark_memory_used',
      'memory_history',
      'promote_memory',
      'recall_memory',
      'remember',
      'search_memory',
      'session_digest',
      'supersede_memory',
      'why_memory',
    ]);
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
    // Behavioral drift guard: must be the real package version, not a stale literal
    expect(payload.version).toBe(PKG_VERSION);
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
  // session_digest
  // -------------------------------------------------------------------------

  it('tools/call session_digest with explicit session_id returns digest JSON', async () => {
    db.prepare(
      'INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s-digest-1', 'astramem-local', null, 'main', 'claude-code', 1000);
    const repo = new MemoryRepo(db);
    repo.insert({
      type: 'decision', text: 'Use SQLite', normalized_text: 'use SQLite',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: 's-digest-1', hash: 'h-mcp-digest-1', source_hash: null,
    });
    repo.insert({
      type: 'lesson', text: 'Bun lacks better-sqlite3 on Windows', normalized_text: 'bun lacks',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: 's-digest-1', hash: 'h-mcp-digest-2', source_hash: null,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'session_digest', arguments: { session_id: 's-digest-1' } },
      id: 32,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    const text = resp.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as {
      session_id: string;
      status: string;
      counts: Record<string, number>;
      memories: Array<{ id: string; type: string; text: string }>;
    };
    expect(payload.session_id).toBe('s-digest-1');
    expect(payload.status).toBe('ready');
    expect(payload.counts).toEqual({ decision: 1, lesson: 1 });
    expect(payload.memories).toHaveLength(2);
  });

  it('tools/call session_digest with no sessions recorded returns isError', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'session_digest', arguments: {} },
      id: 33,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ error: 'no sessions recorded' });
  });

  it('tools/call session_digest with omitted session_id resolves to the most recent session', async () => {
    db.prepare(
      'INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s-digest-older', 'astramem-local', null, 'main', 'claude-code', 1000);
    db.prepare(
      'INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s-digest-newest', 'astramem-local', null, 'main', 'claude-code', 2000);
    new MemoryRepo(db).insert({
      type: 'fact', text: 'Latest session fact', normalized_text: 'latest session fact',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: 's-digest-newest', hash: 'h-mcp-digest-3', source_hash: null,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'session_digest', arguments: {} },
      id: 34,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    const text = resp.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as { session_id: string; counts: Record<string, number> };
    expect(payload.session_id).toBe('s-digest-newest');
    expect(payload.counts).toEqual({ fact: 1 });
  });

  // -------------------------------------------------------------------------
  // invalidate_memory
  // -------------------------------------------------------------------------

  it('tools/call invalidate_memory marks a memory invalid', async () => {
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'to be invalidated', normalized_text: 'to be invalidated',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-invalidate-1', source_hash: null,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'invalidate_memory', arguments: { id, reason: 'stale' } },
      id: 40,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ ok: true, id });

    const row = db.prepare('SELECT valid_to FROM memories WHERE id = ?').get(id) as { valid_to: number | null };
    expect(row.valid_to).not.toBeNull();
  });

  it('tools/call invalidate_memory with unknown id returns isError', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'invalidate_memory', arguments: { id: 'nope' } },
      id: 41,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ error: 'not found', id: 'nope' });
  });

  it('tools/call invalidate_memory on an already-invalid memory returns isError', async () => {
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'already invalid', normalized_text: 'already invalid',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-invalidate-2', source_hash: null,
    });
    new MemoryEventRepo(db).invalidate(id);

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'invalidate_memory', arguments: { id } },
      id: 42,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ error: 'already invalid', id });
  });

  // -------------------------------------------------------------------------
  // supersede_memory
  // -------------------------------------------------------------------------

  it('tools/call supersede_memory links old_id to new_id', async () => {
    const repo = new MemoryRepo(db);
    const oldId = repo.insert({
      type: 'fact', text: 'old fact', normalized_text: 'old fact',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-supersede-old', source_hash: null,
    });
    const newId = repo.insert({
      type: 'fact', text: 'new fact', normalized_text: 'new fact',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-supersede-new', source_hash: null,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'supersede_memory', arguments: { old_id: oldId, new_id: newId } },
      id: 43,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ ok: true, old_id: oldId, new_id: newId });

    const row = db.prepare('SELECT superseded_by FROM memories WHERE id = ?').get(oldId) as { superseded_by: string | null };
    expect(row.superseded_by).toBe(newId);
  });

  it('tools/call supersede_memory with unknown old_id returns isError', async () => {
    const newId = new MemoryRepo(db).insert({
      type: 'fact', text: 'new fact', normalized_text: 'new fact',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-supersede-new-2', source_hash: null,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'supersede_memory', arguments: { old_id: 'nope', new_id: newId } },
      id: 44,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ error: 'not found', id: 'nope' });
  });

  it('tools/call supersede_memory with an invalid new_id returns isError', async () => {
    const repo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    const oldId = repo.insert({
      type: 'fact', text: 'old fact 2', normalized_text: 'old fact 2',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-supersede-old-2', source_hash: null,
    });
    const newId = repo.insert({
      type: 'fact', text: 'invalid new fact', normalized_text: 'invalid new fact',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-supersede-new-3', source_hash: null,
    });
    events.invalidate(newId);

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'supersede_memory', arguments: { old_id: oldId, new_id: newId } },
      id: 45,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ error: 'invalid new_id', new_id: newId });
  });

  // -------------------------------------------------------------------------
  // promote_memory
  // -------------------------------------------------------------------------

  it('tools/call promote_memory promotes scope upward', async () => {
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'promote me', normalized_text: 'promote me',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-promote-1', source_hash: null,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'promote_memory', arguments: { id, scope: 'team' } },
      id: 46,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ ok: true, id, scope: 'team' });

    const row = db.prepare('SELECT scope FROM memories WHERE id = ?').get(id) as { scope: string };
    expect(row.scope).toBe('team');
  });

  it('tools/call promote_memory with unknown id returns isError', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'promote_memory', arguments: { id: 'nope', scope: 'team' } },
      id: 47,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ error: 'not found', id: 'nope' });
  });

  it('tools/call promote_memory with a downward/same-scope request returns isError', async () => {
    const repo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    const id = repo.insert({
      type: 'fact', text: 'already org scope', normalized_text: 'already org scope',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-promote-2', source_hash: null,
    });
    events.promoteScope(id, 'team');
    events.promoteScope(id, 'org');

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'promote_memory', arguments: { id, scope: 'team' } },
      id: 48,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as { error: string; id: string };
    expect(payload.id).toBe(id);
    expect(payload.error).toMatch(/only upward promotions allowed/);
  });

  // -------------------------------------------------------------------------
  // memory_history
  // -------------------------------------------------------------------------

  it('tools/call memory_history reflects an invalidate event', async () => {
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'history target', normalized_text: 'history target',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-history-1', source_hash: null,
    });
    new MemoryEventRepo(db).invalidate(id, 'no longer accurate');

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'memory_history', arguments: { id } },
      id: 49,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    const text = resp.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as { id: string; events: Array<{ event_type: string; atom_id: string }> };
    expect(payload.id).toBe(id);
    // invalidate() also appends a 'usefulness' memory_corrected event (ADR-010) in the same tx.
    expect(payload.events).toHaveLength(2);
    expect(payload.events[0]).toMatchObject({ event_type: 'invalidate', atom_id: id });
    expect(payload.events[1]).toMatchObject({ event_type: 'usefulness', atom_id: id });
  });

  it('tools/call memory_history with unknown id returns isError', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'memory_history', arguments: { id: 'nope' } },
      id: 50,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ error: 'not found', id: 'nope' });
  });

  // -------------------------------------------------------------------------
  // mark_memory_used (ADR-010, 2e)
  // -------------------------------------------------------------------------

  it('tools/call mark_memory_used records a recall_used usefulness event', async () => {
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'served then used', normalized_text: 'served then used',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-used-1', source_hash: null,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'mark_memory_used', arguments: { id, note: 'this helped' } },
      id: 51,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ ok: true, id });

    const events = new MemoryEventRepo(db).listForAtom(id).filter(e => e.event_type === 'usefulness');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]?.payload_json ?? '{}');
    expect(payload).toEqual({ family: 'recall_used', surface: 'mcp', signal: 'explicit' });
  });

  it('tools/call mark_memory_used with unknown id returns isError', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'mark_memory_used', arguments: { id: 'nope' } },
      id: 52,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ error: 'not found', id: 'nope' });
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
