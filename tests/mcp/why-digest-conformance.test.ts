/**
 * FEAT-417a conformance test: GET /memory/:id/why and GET /sessions/:id/digest
 * share buildWhyReceipt()/buildSessionDigest() (src/server/queries/provenance.ts)
 * with the why_memory/session_digest MCP tools. This test asserts
 * the REST route and the MCP tool return byte-identical output for the same
 * seeded data — the FEAT's top risk (the shared fn silently changing output
 * for one caller) would show up here as a failing deepEqual.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { makeFakeVec } from '../../src/search/search.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../src/storage/db.js';

const TOKEN = 'test-conformance-token';

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
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

describe('why/digest REST <-> MCP conformance (FEAT-417a)', () => {
  let db: DB;
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN, embed: buildMockEmbed() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('why: REST /memory/:id/why and MCP why_memory return byte-identical JSON', async () => {
    db.prepare(
      'INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s-conf-1', 'astramem-local', null, 'main', 'claude-code', 1000);
    const id = new MemoryRepo(db).insert({
      type: 'decision', text: 'Use SQLite', normalized_text: 'use SQLite',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: 's-conf-1', hash: 'h-conf-why-1', source_hash: 'src-abc',
      evidence: 'zero-config local file decided in review',
    });
    new MemoryEventRepo(db).invalidate(id, 'superseded in test');
    // Re-validate so the record still resolves for a clean comparison —
    // history should still carry the invalidate + usefulness events.

    const restRes = await fetch(`${baseUrl}/memory/${id}/why`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const restBody = await restRes.json();

    const mcpResult = await toolCall(baseUrl, 'why_memory', { id });

    expect(restRes.status).toBe(200);
    expect(mcpResult.isError).toBe(false);
    expect(mcpResult.payload).toEqual(restBody);
  });

  it('why: unknown id returns matching not-found payload on both surfaces', async () => {
    const restRes = await fetch(`${baseUrl}/memory/nope/why`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const restBody = await restRes.json();
    const mcpResult = await toolCall(baseUrl, 'why_memory', { id: 'nope' });

    expect(restRes.status).toBe(404);
    expect(mcpResult.isError).toBe(true);
    expect(mcpResult.payload).toEqual(restBody);
  });

  it('digest: REST /sessions/:id/digest and MCP session_digest return byte-identical JSON', async () => {
    db.prepare(
      'INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s-conf-2', 'astramem-local', null, 'main', 'claude-code', 1000);
    const repo = new MemoryRepo(db);
    repo.insert({
      type: 'decision', text: 'Use SQLite', normalized_text: 'use SQLite',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: 's-conf-2', hash: 'h-conf-digest-1', source_hash: null,
    });
    repo.insert({
      type: 'lesson', text: 'Bun lacks better-sqlite3 on Windows', normalized_text: 'bun lacks',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: 's-conf-2', hash: 'h-conf-digest-2', source_hash: null,
    });

    const restRes = await fetch(`${baseUrl}/sessions/s-conf-2/digest`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const restBody = await restRes.json();

    const mcpResult = await toolCall(baseUrl, 'session_digest', { session_id: 's-conf-2' });

    expect(restRes.status).toBe(200);
    expect(mcpResult.isError).toBe(false);
    expect(mcpResult.payload).toEqual(restBody);
  });

  // AC-13 (FEAT-456 SLICE-2): pending_contradictions is part of the shared
  // buildSessionDigest() shape — this locks in that REST and MCP agree on
  // it too, not just the pre-existing fields.
  it('digest: pending_contradictions is identical on REST and MCP', async () => {
    db.prepare(
      'INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('s-conf-3', 'astramem-local', null, 'main', 'claude-code', 1000);
    const repo = new MemoryRepo(db);
    const winnerId = repo.insert({
      type: 'fact', text: 'default port is now 8888', normalized_text: 'default port is now 8888',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: 's-conf-3', hash: 'h-conf-digest-3', source_hash: null,
    });
    const loserId = repo.insert({
      type: 'fact', text: 'default port is 7777', normalized_text: 'default port is 7777',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: 's-conf-3', hash: 'h-conf-digest-4', source_hash: null,
    });
    db.prepare(`
      INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at)
      VALUES (?, 'contradiction', ?, ?, ?, 'pending', ?)
    `).run('prop-conf-1', winnerId, loserId, 0.7, Date.now());

    const restRes = await fetch(`${baseUrl}/sessions/s-conf-3/digest`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const restBody = await restRes.json() as { pending_contradictions: number };

    const mcpResult = await toolCall(baseUrl, 'session_digest', { session_id: 's-conf-3' });

    expect(restRes.status).toBe(200);
    expect(restBody.pending_contradictions).toBe(1);
    expect(mcpResult.isError).toBe(false);
    expect(mcpResult.payload).toEqual(restBody);
  });

  it('digest: unknown explicit session_id is not-found on both surfaces (FEAT-417a harmonization)', async () => {
    // Pre-fix, the MCP tool did not check whether an explicitly-passed
    // session_id existed and silently returned an empty "ready" digest;
    // the REST route always 404'd. The shared getSessionDigest() query
    // closes that gap — both surfaces now agree.
    const restRes = await fetch(`${baseUrl}/sessions/nope/digest`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const restBody = await restRes.json();
    const mcpResult = await toolCall(baseUrl, 'session_digest', { session_id: 'nope' });

    expect(restRes.status).toBe(404);
    expect(restBody).toEqual({ error: 'not found', session_id: 'nope' });
    expect(mcpResult.isError).toBe(true);
    expect(mcpResult.payload).toEqual(restBody);
  });
});
