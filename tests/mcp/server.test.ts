/**
 * MCP server integration tests.
 *
 * Strategy: start the daemon on a random port via Fastify.listen(), send
 * real HTTP POST /mcp requests, then tear down.  Fastify.inject() cannot be
 * used here because the MCP route calls reply.hijack() and lets the SDK
 * write directly to the raw Node ServerResponse.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { makeFakeVec } from '../../src/search/search.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { ProposalRepo } from '../../src/consolidate/proposals.js';
import { PKG_VERSION } from '../../src/server/lib/wire-meta.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../src/storage/db.js';

const TOKEN = 'test-mcp-token';

// The expected tool count is NOT a literal here (ADR-016 — a hand-maintained
// aggregate over an enumerable set is exactly the pattern that let this
// number drift silently in three other places: this test's own former
// literal, the doc comment atop src/mcp/server.ts, and CLAUDE.md).
//
// The McpServer SDK does not expose a public way to ask "how many tools are
// registered" — `McpServer#_registeredTools` (node_modules/@modelcontextprotocol/
// sdk/dist/esm/server/mcp.d.ts) is typed `private`, so reading it here would
// mean reaching into SDK internals with an `as any` cast that breaks the
// moment the SDK changes its private field layout. That rules out "ask the
// server object directly."
//
// So the count is derived by counting `server.registerTool(` call sites in
// src/mcp/server.ts itself via a source-text scan, and compared against what
// the server actually advertises over the wire (tools/list). This is a
// source-regex, and a source-regex is admittedly brittle — but it beats a
// literal because it cannot silently drift: add a registerTool( call and both
// sides of the comparison move together, with zero edits required anywhere
// else. Exact tool-NAME correctness (not just count) is a stronger,
// independent guarantee already owned by
// tests/contracts/mcp-tool-manifest-parity.test.ts, which cross-checks the
// wire response against contracts/manifests/mcp-tools.v1.json (the cross-repo
// SoT) — this test intentionally doesn't duplicate that list.
const SERVER_SOURCE_PATH = join(__dirname, '../../src/mcp/server.ts');

function countRegisterToolCallSites(): number {
  const source = readFileSync(SERVER_SOURCE_PATH, 'utf-8');
  const matches = source.match(/\bserver\.registerTool\(/g);
  return matches ? matches.length : 0;
}

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

  /** tools/call helper — returns the parsed JSON payload of the first text content. */
  async function toolCall(name: string, args: object): Promise<{ payload: unknown; isError: boolean }> {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 99,
    }) as { result?: { content?: Array<{ type: string; text: string }>; isError?: boolean } };
    const text = resp.result?.content?.[0]?.text ?? '{}';
    return { payload: JSON.parse(text), isError: resp.result?.isError === true };
  }

  // -------------------------------------------------------------------------
  // tools/list
  // -------------------------------------------------------------------------

  it('initialize + tools/list count matches the number of registerTool( call sites in src/mcp/server.ts', async () => {
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
    // Two independently-derived values, not a tautology: what the server
    // actually advertises over the wire (tools.length, from a live MCP
    // request) vs. what the source registers (a static scan of
    // src/mcp/server.ts, computed with no knowledge of the wire response).
    expect(tools.length).toBe(countRegisterToolCallSites());
    // Sanity: every advertised tool has a distinct name (catches an
    // accidental duplicate registerTool( call the count alone would miss).
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
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

  // Silent-error audit (2026-07-13): a failed embed/vec-upsert used to be
  // swallowed into a log line while the response still said {id, ok: true}
  // unconditionally — the caller had no way to know the memory was saved
  // FTS-only and not vector-indexed. vec_indexed: false now surfaces it.
  it('embed/vec upsert failure: memory still saved, but response reports vec_indexed: false instead of lying', async () => {
    const brokenEmbed: EmbedProvider = {
      ...buildMockEmbed(),
      embed: async () => { throw new Error('embed provider unreachable (test)'); },
    };
    const brokenApp = await buildApp({ db, token: TOKEN, embed: brokenEmbed });
    await brokenApp.listen({ host: '127.0.0.1', port: 0 });
    const addr = brokenApp.server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
    const brokenBaseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const resp = await mcpPost(brokenBaseUrl, {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'remember', arguments: { text: 'mcp remember with a broken embed provider', type: 'fact' } },
        id: 4,
      }) as { result?: { content?: Array<{ type: string; text: string }> } };
      const text = resp.result?.content?.[0]?.text ?? '';
      const payload = JSON.parse(text) as { id: string; ok: boolean; vec_indexed?: boolean };

      expect(payload.ok).toBe(true);
      expect(payload.vec_indexed).toBe(false);

      const row = db.prepare('SELECT id FROM memories WHERE id = ?').get(payload.id);
      expect(row).toBeDefined();
      const rowid = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(payload.id) as { rowid: number };
      const vecRow = db.prepare('SELECT rowid FROM memories_vec WHERE rowid = ?').get(BigInt(rowid.rowid));
      expect(vecRow).toBeUndefined();
    } finally {
      await brokenApp.close();
    }
  });

  // astramem-local#84: content_hash must be a full 64-char sha256 hex digest
  // (contracts/schemas/sync-envelope.v1.schema.json pattern ^[a-f0-9]{64}$),
  // not the legacy 32-char truncation. Exercises the real MCP remember hash
  // site (src/mcp/server.ts), not a synthetic value.
  it('tools/call remember stores a full 64-char sha256 hex content hash, not a 32-char truncation', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'remember',
        arguments: { text: 'astramem-local#84: mcp remember hash must be 64 chars', type: 'fact' },
      },
      id: 4,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    const text = resp.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as { id: string; ok: boolean };
    expect(payload.ok).toBe(true);

    const row = db.prepare('SELECT hash FROM memories WHERE id = ?').get(payload.id) as { hash: string };
    expect(row.hash).toMatch(/^[a-f0-9]{64}$/);
    const event = db.prepare(`SELECT content_hash FROM memory_events WHERE atom_id = ? AND event_type = 'create'`).get(payload.id) as { content_hash: string };
    expect(event.content_hash).toBe(row.hash);
  });

  // -------------------------------------------------------------------------
  // remember — canonical unified save contract
  // -------------------------------------------------------------------------

  it('tools/call remember accepts every canonical type — no CHECK rejection for preference/task_result/summary', async () => {
    for (const type of ['decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event', 'preference', 'task_result', 'summary']) {
      const { payload, isError } = await toolCall('remember', {
        content: `canonical-type test for ${type}`,
        type,
      });
      expect(isError, `type "${type}" should not error`).toBe(false);
      const { id, ok } = payload as { id: string; ok: boolean };
      expect(ok).toBe(true);
      const row = db.prepare('SELECT type FROM memories WHERE id = ?').get(id) as { type: string };
      expect(row.type).toBe(type);
    }
  });

  it('tools/call remember with scope: "org" persists the row at scope=org directly (no promote step)', async () => {
    const { payload, isError } = await toolCall('remember', {
      content: 'born-at-org-scope memory',
      type: 'fact',
      scope: 'org',
    });
    expect(isError).toBe(false);
    const { id } = payload as { id: string };
    const row = db.prepare('SELECT scope FROM memories WHERE id = ?').get(id) as { scope: string };
    expect(row.scope).toBe('org');
  });

  it('tools/call remember with scope: "team" persists the row at scope=team directly', async () => {
    const { payload, isError } = await toolCall('remember', {
      content: 'born-at-team-scope memory',
      type: 'fact',
      scope: 'team',
    });
    expect(isError).toBe(false);
    const { id } = payload as { id: string };
    const row = db.prepare('SELECT scope FROM memories WHERE id = ?').get(id) as { scope: string };
    expect(row.scope).toBe('team');
  });

  it('tools/call remember with no scope defaults to private, same as before', async () => {
    const { payload, isError } = await toolCall('remember', {
      content: 'default scope memory',
      type: 'fact',
    });
    expect(isError).toBe(false);
    const { id } = payload as { id: string };
    const row = db.prepare('SELECT scope FROM memories WHERE id = ?').get(id) as { scope: string };
    expect(row.scope).toBe('private');
  });

  it('tools/call remember with decisionJson + reviewJson saves the memory AND echoes both in unsupported_fields — no decision/review data reaches storage', async () => {
    const { payload, isError } = await toolCall('remember', {
      content: 'memory with cloud-only attachments',
      type: 'decision',
      decisionJson: { rationale: 'because', outcome: 'accepted' },
      reviewJson: { reviewer: 'someone', verdict: 'approved' },
    });
    expect(isError).toBe(false);
    const { id, ok, unsupported_fields } = payload as { id: string; ok: boolean; unsupported_fields: string[] };
    expect(ok).toBe(true);
    expect(unsupported_fields.sort()).toEqual(['decisionJson', 'reviewJson']);

    // The memory itself was persisted...
    const row = db.prepare('SELECT id, type FROM memories WHERE id = ?').get(id) as { id: string; type: string };
    expect(row.id).toBe(id);
    expect(row.type).toBe('decision');
    // ...and no decision/review-shaped data reached the memories table —
    // the memories schema has no such columns at all.
    const cols = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).not.toContain('decision_json');
    expect(colNames).not.toContain('review_json');
  });

  it('tools/call remember with only decisionJson supplied echoes just that one field in unsupported_fields', async () => {
    const { payload, isError } = await toolCall('remember', {
      content: 'memory with only a decision attachment',
      type: 'decision',
      decisionJson: { rationale: 'solo decision field' },
    });
    expect(isError).toBe(false);
    const { unsupported_fields } = payload as { unsupported_fields: string[] };
    expect(unsupported_fields).toEqual(['decisionJson']);
  });

  it('tools/call remember with tags supplied saves the memory and echoes tags in unsupported_fields (no local tags storage column)', async () => {
    const { payload, isError } = await toolCall('remember', {
      content: 'memory with tags',
      type: 'fact',
      tags: ['alpha', 'beta'],
    });
    expect(isError).toBe(false);
    const { id, ok, unsupported_fields } = payload as { id: string; ok: boolean; unsupported_fields: string[] };
    expect(ok).toBe(true);
    expect(unsupported_fields).toEqual(['tags']);
    const row = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
    expect(row).toBeDefined();
  });

  it('tools/call remember with no unsupported fields omits unsupported_fields entirely', async () => {
    const { payload, isError } = await toolCall('remember', {
      content: 'plain memory, nothing unsupported',
      type: 'fact',
    });
    expect(isError).toBe(false);
    expect(payload).toEqual({ id: (payload as { id: string }).id, ok: true });
    expect(payload).not.toHaveProperty('unsupported_fields');
  });

  it('tools/call remember: deprecated `text` alias still works when `content` is absent', async () => {
    const { payload, isError } = await toolCall('remember', {
      text: 'legacy text-field call',
      type: 'fact',
    });
    expect(isError).toBe(false);
    const { id, ok } = payload as { id: string; ok: boolean };
    expect(ok).toBe(true);
    const row = db.prepare('SELECT text FROM memories WHERE id = ?').get(id) as { text: string };
    expect(row.text).toBe('legacy text-field call');
  });

  it('tools/call remember: canonical `content` field works', async () => {
    const { payload, isError } = await toolCall('remember', {
      content: 'canonical content-field call',
      type: 'fact',
    });
    expect(isError).toBe(false);
    const { id, ok } = payload as { id: string; ok: boolean };
    expect(ok).toBe(true);
    const row = db.prepare('SELECT text FROM memories WHERE id = ?').get(id) as { text: string };
    expect(row.text).toBe('canonical content-field call');
  });

  it('tools/call remember: neither `content` nor `text` supplied is a validation error', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'remember', arguments: { type: 'fact' } },
      id: 60,
    }) as { error?: unknown; result?: { isError?: boolean } };
    // MCP SDK schema validation failures surface either as a JSON-RPC error
    // or a tool isError, depending on SDK version — either is an acceptable
    // "rejected" outcome here.
    const rejected = resp.error !== undefined || resp.result?.isError === true;
    expect(rejected).toBe(true);
  });

  it('tools/call remember: deprecated nested `metadata` back-compat still works (repo/project/branch/agent/importance/confidence)', async () => {
    const { payload, isError } = await toolCall('remember', {
      content: 'nested metadata back-compat call',
      type: 'fact',
      metadata: {
        repo: 'astramem-local',
        project: 'proj-legacy',
        branch: 'main',
        agent: 'claude-code',
        importance: 0.9,
        confidence: 0.8,
      },
    });
    expect(isError).toBe(false);
    const { id } = payload as { id: string };
    const row = db.prepare(
      'SELECT repo, project, branch, agent, importance, confidence FROM memories WHERE id = ?'
    ).get(id) as { repo: string; project: string; branch: string; agent: string; importance: number; confidence: number };
    expect(row).toEqual({
      repo: 'astramem-local',
      project: 'proj-legacy',
      branch: 'main',
      agent: 'claude-code',
      importance: 0.9,
      confidence: 0.8,
    });
  });

  it('tools/call remember: flat projectId/agentId/sessionId win over nested metadata when both are present', async () => {
    db.prepare(
      'INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s-flat-1', 'astramem-local', null, 'main', 'claude-code', 1000);

    const { payload, isError } = await toolCall('remember', {
      content: 'flat aliases win over nested metadata',
      type: 'fact',
      projectId: 'proj-flat',
      agentId: 'agent-flat',
      sessionId: 's-flat-1',
      metadata: { project: 'proj-nested', agent: 'agent-nested' },
    });
    expect(isError).toBe(false);
    const { id } = payload as { id: string };
    const row = db.prepare(
      'SELECT project, agent, session_id FROM memories WHERE id = ?'
    ).get(id) as { project: string; agent: string; session_id: string };
    expect(row).toEqual({ project: 'proj-flat', agent: 'agent-flat', session_id: 's-flat-1' });
  });

  it('tools/call remember: flat importance/confidence/evidence are honored', async () => {
    const { payload, isError } = await toolCall('remember', {
      content: 'flat importance/confidence/evidence call',
      type: 'fact',
      importance: 0.95,
      confidence: 0.1,
      evidence: 'excerpt supporting this atom',
    });
    expect(isError).toBe(false);
    const { id } = payload as { id: string };
    const row = db.prepare(
      'SELECT importance, confidence, evidence FROM memories WHERE id = ?'
    ).get(id) as { importance: number; confidence: number; evidence: string };
    expect(row).toEqual({ importance: 0.95, confidence: 0.1, evidence: 'excerpt supporting this atom' });
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

  it('FEAT-500: tools/call search_memory hits carry explanation.top_signal, a real key of explanation.signals', async () => {
    await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'remember',
        arguments: { text: 'top_signal must survive the MCP wire response', type: 'lesson' },
      },
      id: 12,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'search_memory',
        arguments: { query: 'top_signal MCP wire response', limit: 5 },
      },
      id: 13,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    const text2 = resp.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text2) as {
      hits: Array<{ explanation: { final: number; signals: Record<string, { final: number }>; top_signal?: string } }>;
    };
    expect(payload.hits.length).toBeGreaterThan(0);
    for (const hit of payload.hits) {
      expect(typeof hit.explanation.top_signal).toBe('string');
      expect(hit.explanation.signals).toHaveProperty(hit.explanation.top_signal!);
    }
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
  // restore_memory (FEAT-416)
  // -------------------------------------------------------------------------

  it('tools/call restore_memory un-archives a memory', async () => {
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'to be restored', normalized_text: 'to be restored',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-restore-1', source_hash: null,
    });
    new MemoryEventRepo(db).archive(id, 'ttl-policy');

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'restore_memory', arguments: { id } },
      id: 49,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ ok: true, id });

    const row = db.prepare('SELECT valid_to, archived FROM memories WHERE id = ?').get(id) as
      { valid_to: number | null; archived: number };
    expect(row.valid_to).toBeNull();
    expect(row.archived).toBe(0);
  });

  it('tools/call restore_memory with unknown id returns isError', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'restore_memory', arguments: { id: 'nope' } },
      id: 50,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ error: 'not found', id: 'nope' });
  });

  it('tools/call restore_memory on a never-archived memory returns isError', async () => {
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'never archived', normalized_text: 'never archived',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-restore-2', source_hash: null,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'restore_memory', arguments: { id } },
      id: 51,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ error: 'not archived', id });
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
  // submit_feedback (ADR-010, 2e) — canonical U5 name
  // (astragenie/memory#671, astragenie/astramem-local#120)
  // -------------------------------------------------------------------------

  it('tools/call submit_feedback records a recall_used usefulness event', async () => {
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'served then used', normalized_text: 'served then used',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-used-1', source_hash: null,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'submit_feedback', arguments: { id, note: 'this helped' } },
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

  it('tools/call submit_feedback with unknown id returns isError', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'submit_feedback', arguments: { id: 'nope' } },
      id: 52,
    }) as { result?: { isError?: boolean; content?: Array<{ type: string; text: string }> } };

    expect(resp.result?.isError).toBe(true);
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ error: 'not found', id: 'nope' });
  });

  // -------------------------------------------------------------------------
  // mark_memory_used — DEPRECATED one-release alias of submit_feedback (U5)
  // -------------------------------------------------------------------------

  it('tools/call mark_memory_used (deprecated alias) records the same usefulness event as submit_feedback', async () => {
    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'served then used via deprecated alias', normalized_text: 'served then used via deprecated alias',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-mcp-used-alias-1', source_hash: null,
    });

    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'mark_memory_used', arguments: { id, note: 'this helped' } },
      id: 61,
    }) as { result?: { content?: Array<{ type: string; text: string }> } };

    expect(resp).toHaveProperty('result');
    const text = resp.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual({ ok: true, id });

    const events = new MemoryEventRepo(db).listForAtom(id).filter(e => e.event_type === 'usefulness');
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]?.payload_json ?? '{}');
    expect(payload).toEqual({ family: 'recall_used', surface: 'mcp', signal: 'explicit' });
  });

  it('tools/call mark_memory_used (deprecated alias) with unknown id returns isError', async () => {
    const resp = await mcpPost(baseUrl, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'mark_memory_used', arguments: { id: 'nope' } },
      id: 62,
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

  // -------------------------------------------------------------------------
  // consolidation proposal tools (Wave 4b surfacing)
  // -------------------------------------------------------------------------

  it('list + resolve consolidation proposals roundtrip over MCP', async () => {
    // Seed a borderline near-duplicate pair (cos ≈ 0.90) and run stage 9.
    const { runConsolidation } = await import('../../src/consolidate/consolidate.js');
    const { SqliteVecStore } = await import('../../src/vector/sqlite-vec.js');
    const repo = new MemoryRepo(db);
    const vecStore = new SqliteVecStore(db);
    const mk = (tilt: number): Float32Array => {
      const v = new Float32Array(1024); v[0] = 1; v[1] = tilt; return v;
    };
    const a = repo.insert({
      type: 'fact', text: 'deploys run at midnight', normalized_text: 'deploys run at midnight',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: 'h-mcp-c1', source_hash: null,
    });
    const b = repo.insert({
      type: 'fact', text: 'deploys run nightly', normalized_text: 'deploys run nightly',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: 'h-mcp-c2', source_hash: null,
    });
    await vecStore.upsert(a, mk(0));
    await vecStore.upsert(b, mk(0.45));
    await runConsolidation(db);

    const list = await toolCall('list_consolidation_proposals', {});
    const { proposals } = list.payload as { proposals: Array<{ id: string; winner_text: string; loser_text: string; status: string }> };
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe('pending');
    expect(proposals[0]!.winner_text).toContain('deploys');

    const resolve = await toolCall('resolve_consolidation_proposal', { id: proposals[0]!.id, action: 'accept' });
    expect(resolve.isError).toBe(false);
    expect((resolve.payload as { proposal: { status: string } }).proposal.status).toBe('accepted');

    // Double-resolve and unknown id are structured errors, not throws.
    const again = await toolCall('resolve_consolidation_proposal', { id: proposals[0]!.id, action: 'reject' });
    expect(again.isError).toBe(true);
    const missing = await toolCall('resolve_consolidation_proposal', { id: 'nope', action: 'accept' });
    expect(missing.isError).toBe(true);
  });

  // AC-10/AC-11 (FEAT-456 SLICE-2): kind='contradiction' proposals surface
  // parsed verdict/confidence/excerpts, and resolve behaves identically to
  // a 'merge' proposal (same accept -> merge-as-supersede path, no branch
  // by kind).
  it('list_consolidation_proposals enriches a contradiction proposal with parsed metadata; resolve behaves like merge', async () => {
    const repo = new MemoryRepo(db);
    const winnerId = repo.insert({
      type: 'fact', text: 'default port is now 8888', normalized_text: 'default port is now 8888',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: 'h-mcp-contra-1', source_hash: null,
    });
    const loserId = repo.insert({
      type: 'fact', text: 'default port is 7777', normalized_text: 'default port is 7777',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: 'h-mcp-contra-2', source_hash: null,
    });
    const metadata = {
      verdict: 'contradicts', confidence: 0.92,
      winner_excerpt: 'default port is now 8888', loser_excerpt: 'default port is 7777',
    };
    db.prepare(`
      INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
      VALUES ('prop-contra-1', 'contradiction', ?, ?, ?, 'pending', ?, ?)
    `).run(winnerId, loserId, 0.7, Date.now(), JSON.stringify(metadata));

    // kind filter: contradiction-only list excludes any merge proposals.
    const filtered = await toolCall('list_consolidation_proposals', { kind: 'contradiction' });
    const { proposals } = filtered.payload as {
      proposals: Array<{
        id: string; kind: string; winner_text: string; loser_text: string;
        contradiction_metadata: { verdict: string; confidence: number; winner_excerpt: string; loser_excerpt: string } | null;
      }>;
    };
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.kind).toBe('contradiction');
    expect(p.winner_text).toBe('default port is now 8888');
    expect(p.contradiction_metadata).toEqual(metadata);

    // Resolve: identical accept path to a 'merge' proposal (no branch by kind).
    const resolve = await toolCall('resolve_consolidation_proposal', { id: 'prop-contra-1', action: 'accept' });
    expect(resolve.isError).toBe(false);
    expect((resolve.payload as { proposal: { status: string } }).proposal.status).toBe('accepted');
    expect(new MemoryRepo(db).get(loserId)!.superseded_by).toBe(winnerId);
  });

  // #372/#171: list_consolidation_proposals gains limit/offset/minConfidence,
  // same repo-layer pagination the HTTP route and CLI now use.
  it('list_consolidation_proposals paginates via limit/offset and reports total independent of the slice', async () => {
    const memRepo = new MemoryRepo(db);
    const seedMerge = (i: number, similarity: number, createdAt: number): void => {
      const w = memRepo.insert({
        type: 'fact', text: `page winner ${i}`, normalized_text: `page winner ${i}`,
        repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: `h-page-w${i}`, source_hash: null,
      });
      const l = memRepo.insert({
        type: 'fact', text: `page loser ${i}`, normalized_text: `page loser ${i}`,
        repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: `h-page-l${i}`, source_hash: null,
      });
      db.prepare(`
        INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
        VALUES (?, 'merge', ?, ?, ?, 'pending', ?, NULL)
      `).run(`prop-page-${i}`, w, l, similarity, createdAt);
    };
    for (let i = 0; i < 5; i++) seedMerge(i, 0.9, 1000 + i);

    const page1 = await toolCall('list_consolidation_proposals', { limit: 2 });
    const p1 = page1.payload as { proposals: unknown[]; total: number };
    expect(p1.proposals).toHaveLength(2);
    expect(p1.total).toBe(5); // total is not clamped by limit

    const page2 = await toolCall('list_consolidation_proposals', { limit: 2, offset: 2 });
    const p2 = page2.payload as { proposals: Array<{ id: string }>; total: number };
    expect(p2.proposals).toHaveLength(2);
    const ids1 = (p1.proposals as Array<{ id: string }>).map(p => p.id);
    const ids2 = p2.proposals.map(p => p.id);
    expect(new Set([...ids1, ...ids2]).size).toBe(4); // no overlap across pages

    const filtered = await toolCall('list_consolidation_proposals', { minConfidence: 0.999 });
    expect((filtered.payload as { proposals: unknown[]; total: number }).total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // resolve_consolidation_proposals_batch (#372)
  // -------------------------------------------------------------------------

  it('resolve_consolidation_proposals_batch accepts only proposals at/above minConfidence, leaves the rest pending', async () => {
    const memRepo = new MemoryRepo(db);
    const seedMerge = (id: string, similarity: number): { winner: string; loser: string } => {
      const w = memRepo.insert({
        type: 'fact', text: `${id} winner`, normalized_text: `${id} winner`,
        repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: `h-${id}-w`, source_hash: null,
      });
      const l = memRepo.insert({
        type: 'fact', text: `${id} loser`, normalized_text: `${id} loser`,
        repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: `h-${id}-l`, source_hash: null,
      });
      db.prepare(`
        INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
        VALUES (?, 'merge', ?, ?, ?, 'pending', ?, NULL)
      `).run(id, w, l, similarity, Date.now());
      return { winner: w, loser: l };
    };
    const low = seedMerge('prop-batch-low', 0.80);
    const high = seedMerge('prop-batch-high', 0.95);

    const result = await toolCall('resolve_consolidation_proposals_batch', {
      action: 'accept', kind: 'merge', minConfidence: 0.9,
    });
    expect(result.isError).toBe(false);
    const payload = result.payload as {
      ok: boolean; matched: number; resolved: number; skipped: unknown[]; remaining: number;
    };
    expect(payload).toMatchObject({ ok: true, matched: 1, resolved: 1, skipped: [], remaining: 0 });

    expect(new MemoryRepo(db).get(high.loser)!.superseded_by).toBe(high.winner);
    expect(new MemoryRepo(db).get(low.loser)!.superseded_by).toBeNull();

    const remaining = await toolCall('list_consolidation_proposals', {});
    const remainingIds = (remaining.payload as { proposals: Array<{ id: string }> }).proposals.map(p => p.id);
    expect(remainingIds).toEqual(['prop-batch-low']);
  });

  it('resolve_consolidation_proposals_batch action=reject marks matches rejected without touching memories', async () => {
    const memRepo = new MemoryRepo(db);
    const w = memRepo.insert({
      type: 'fact', text: 'reject-batch winner', normalized_text: 'reject-batch winner',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: 'h-rb-w', source_hash: null,
    });
    const l = memRepo.insert({
      type: 'fact', text: 'reject-batch loser', normalized_text: 'reject-batch loser',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: 'h-rb-l', source_hash: null,
    });
    db.prepare(`
      INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
      VALUES ('prop-reject-batch', 'merge', ?, ?, 0.9, 'pending', ?, NULL)
    `).run(w, l, Date.now());

    const result = await toolCall('resolve_consolidation_proposals_batch', { action: 'reject', kind: 'merge' });
    const payload = result.payload as { resolved: number; matched: number };
    expect(payload).toMatchObject({ matched: 1, resolved: 1 });
    expect(new MemoryRepo(db).get(l)!.superseded_by).toBeNull(); // reject never mutates memories

    const list = await toolCall('list_consolidation_proposals', { status: 'rejected' });
    const rows = (list.payload as { proposals: Array<{ id: string; status: string }> }).proposals;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('rejected');
  });

  it('resolve_consolidation_proposals_batch limit caps the batch and reports remaining > 0', async () => {
    const memRepo = new MemoryRepo(db);
    for (let i = 0; i < 3; i++) {
      const w = memRepo.insert({
        type: 'fact', text: `cap winner ${i}`, normalized_text: `cap winner ${i}`,
        repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: `h-cap-w${i}`, source_hash: null,
      });
      const l = memRepo.insert({
        type: 'fact', text: `cap loser ${i}`, normalized_text: `cap loser ${i}`,
        repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: `h-cap-l${i}`, source_hash: null,
      });
      db.prepare(`
        INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
        VALUES (?, 'merge', ?, ?, 0.9, 'pending', ?, NULL)
      `).run(`prop-cap-${i}`, w, l, Date.now() + i);
    }

    const result = await toolCall('resolve_consolidation_proposals_batch', { action: 'accept', limit: 2 });
    const payload = result.payload as { matched: number; resolved: number; remaining: number };
    expect(payload).toMatchObject({ matched: 2, resolved: 2, remaining: 1 });
  });

  // Review finding (PR #377, CRITICAL): `remaining` was computed as
  // `totalMatching - matched.length`, which counts a SKIPPED proposal (still
  // status='pending', still matching the filter) as resolved just because it
  // was fetched into this batch. A poisoned proposal — its winner or loser
  // memory purged out from under it between listing and accept — then makes
  // `remaining` read 0 while the proposal sits pending forever, and a caller
  // following this tool's own "call again while remaining is nonzero"
  // contract stops looping without ever noticing. Fixed to
  // `totalMatching - resolved`.
  it('resolve_consolidation_proposals_batch: a skipped (poisoned) proposal is still counted in remaining, not silently dropped', async () => {
    const memRepo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);

    const seedPair = (id: string): { winner: string; loser: string } => {
      const w = memRepo.insert({
        type: 'fact', text: `${id} winner`, normalized_text: `${id} winner`,
        repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: `h-${id}-w`, source_hash: null,
      });
      const l = memRepo.insert({
        type: 'fact', text: `${id} loser`, normalized_text: `${id} loser`,
        repo: 'r1', project: null, branch: null, agent: null, session_id: null, hash: `h-${id}-l`, source_hash: null,
      });
      db.prepare(`
        INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, metadata_json)
        VALUES (?, 'merge', ?, ?, 0.9, 'pending', ?, NULL)
      `).run(id, w, l, Date.now());
      return { winner: w, loser: l };
    };

    const healthy = seedPair('prop-remaining-healthy');
    const poisoned = seedPair('prop-remaining-poisoned');
    // Simulate the lifecycle race the batch tool must tolerate: the loser
    // memory is erased (e.g. by an unrelated erase_memory call) AFTER the
    // proposal was written but BEFORE this batch resolves it — accept() will
    // hit MemoryNotFoundError via mergeAsSupersede -> supersede().
    events.erase(poisoned.loser);

    const result = await toolCall('resolve_consolidation_proposals_batch', { action: 'accept' });
    const payload = result.payload as {
      matched: number; resolved: number; skipped: Array<{ id: string; reason: string }>; remaining: number;
    };
    expect(payload.matched).toBe(2);
    expect(payload.resolved).toBe(1);
    expect(payload.skipped).toHaveLength(1);
    expect(payload.skipped[0]!.id).toBe('prop-remaining-poisoned');
    // The bug: this used to read 0 (totalMatching(2) - matched.length(2)).
    // Correct: the poisoned proposal is still pending, so still 1 remains.
    expect(payload.remaining).toBe(1);

    expect(new MemoryRepo(db).get(healthy.loser)!.superseded_by).toBe(healthy.winner);
    expect(new ProposalRepo(db).get('prop-remaining-poisoned')!.status).toBe('pending');

    // A caller that follows the tool's own "loop while remaining is
    // nonzero" contract retries and correctly observes it can never drain —
    // remaining stays 1, not 0, on every subsequent call (poisoned, not
    // transient).
    const again = await toolCall('resolve_consolidation_proposals_batch', { action: 'accept' });
    const againPayload = again.payload as { matched: number; resolved: number; remaining: number };
    expect(againPayload).toMatchObject({ matched: 1, resolved: 0, remaining: 1 });
  });
});
