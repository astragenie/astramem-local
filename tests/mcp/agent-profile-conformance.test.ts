/**
 * Agent Profile conformance test: GET /agents/:agent/profile and MCP
 * agent_profile share buildAgentProfile() (src/server/queries/agent-profile.ts)
 * — this test asserts the REST route and the MCP tool return byte-identical
 * output for the same seeded data, same pattern as
 * tests/mcp/why-digest-conformance.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { makeFakeVec } from '../../src/search/search.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { recordRecallUsed } from '../../src/storage/usefulness.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../src/storage/db.js';

const TOKEN = 'test-agent-profile-token';
const AGENT = 'claude-code';

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
  const resp = (await mcpPost(baseUrl, {
    jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 1,
  })) as { result?: { content?: Array<{ type: string; text: string }>; isError?: boolean } };
  const text = resp.result?.content?.[0]?.text ?? '{}';
  return { payload: JSON.parse(text), isError: resp.result?.isError === true };
}

describe('agent_profile REST <-> MCP conformance', () => {
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

  it('REST /agents/:agent/profile and MCP agent_profile return byte-identical JSON', async () => {
    const repo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);

    const lessonId = repo.insertWithCreateEvent(
      {
        type: 'lesson', text: 'Bun lacks better-sqlite3 on Windows', normalized_text: 'bun lacks',
        repo: 'astramem-local', project: null, branch: 'main', agent: AGENT,
        session_id: null, hash: 'h-agent-profile-1', source_hash: null,
      },
      events,
    ).id;
    recordRecallUsed(db, { atomId: lessonId, surface: 'mcp', signal: 'explicit' });

    repo.insertWithCreateEvent(
      {
        type: 'decision', text: 'Use SQLite', normalized_text: 'use sqlite',
        repo: 'astramem-local', project: null, branch: 'main', agent: AGENT,
        session_id: null, hash: 'h-agent-profile-2', source_hash: null,
      },
      events,
    );

    const wrongId = repo.insertWithCreateEvent(
      {
        type: 'fact', text: 'nomic-embed-text-v2-moe is the right default', normalized_text: 'nomic wrong',
        repo: 'astramem-local', project: null, branch: 'main', agent: AGENT,
        session_id: null, hash: 'h-agent-profile-3', source_hash: null,
      },
      events,
    ).id;
    events.invalidate(wrongId, 'wrong embed dim — hotfix v0.2.1');

    const restRes = await fetch(`${baseUrl}/agents/${AGENT}/profile`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const restBody = await restRes.json();

    const mcpResult = await toolCall(baseUrl, 'agent_profile', { agent: AGENT });

    expect(restRes.status).toBe(200);
    expect(mcpResult.isError).toBe(false);
    expect(mcpResult.payload).toEqual(restBody);

    // Sanity on shape, not just conformance.
    expect(restBody.agent).toBe(AGENT);
    expect(restBody.total).toBe(2); // the invalidated fact is no longer active
    expect(restBody.top_lessons).toHaveLength(1);
    expect(restBody.top_lessons[0].id).toBe(lessonId);
    expect(restBody.recent_decisions).toHaveLength(1);
    expect(restBody.corrections).toHaveLength(1);
    expect(restBody.corrections[0].id).toBe(wrongId);
    expect(restBody.corrections[0].action).toBe('invalidated');
  });

  it('unknown agent returns matching not-found payload on both surfaces', async () => {
    const restRes = await fetch(`${baseUrl}/agents/nobody/profile`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const restBody = await restRes.json();
    const mcpResult = await toolCall(baseUrl, 'agent_profile', { agent: 'nobody' });

    expect(restRes.status).toBe(404);
    expect(restBody).toEqual({ error: 'not found', agent: 'nobody' });
    expect(mcpResult.isError).toBe(true);
    expect(mcpResult.payload).toEqual(restBody);
  });

  it('REST route requires Bearer auth (existing global preHandler)', async () => {
    const res = await fetch(`${baseUrl}/agents/${AGENT}/profile`);
    expect(res.status).toBe(401);
  });
});
