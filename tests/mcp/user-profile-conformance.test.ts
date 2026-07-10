/**
 * User Profile conformance test (FEAT-451 slice 1): GET /profile and MCP
 * user_profile share buildUserProfile() (src/server/queries/user-profile.ts)
 * — this test asserts the REST route and the MCP tool return byte-identical
 * output for the same seeded data, same pattern as
 * tests/mcp/agent-profile-conformance.test.ts. Also covers AC-4 (401 with no
 * Bearer, no per-scope 403) and AC-6 (deterministic ordering across repeated
 * calls against the same fixture DB).
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

const TOKEN = 'test-user-profile-token';

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

/** Strips the build-time `generated_at` timestamp so REST and MCP calls —
 *  each their own independent buildUserProfile() invocation, milliseconds
 *  apart — can be compared for structural (not literal-timestamp) equality. */
function withoutGeneratedAt(body: Record<string, unknown>): Record<string, unknown> {
  const { generated_at, ...rest } = body;
  void generated_at;
  return rest;
}

function seedProfileCorpus(db: DB): void {
  const repo = new MemoryRepo(db);
  const events = new MemoryEventRepo(db);

  repo.insertWithCreateEvent(
    {
      type: 'fact', text: 'mxbai-embed-large is 1024-dim', normalized_text: 'mxbai 1024',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-user-profile-fact-1', source_hash: null, evidence: 'config.yaml comment',
    },
    events,
  );
  repo.insertWithCreateEvent(
    {
      type: 'note', text: 'prefers concise commit messages', normalized_text: 'prefers concise',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-user-profile-note-1', source_hash: null,
    },
    events,
  );
  repo.insertWithCreateEvent(
    {
      type: 'lesson', text: 'never git stash across worktrees', normalized_text: 'never stash',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-user-profile-lesson-1', source_hash: null,
    },
    events,
  );
  repo.insertWithCreateEvent(
    {
      type: 'decision', text: 'ship v1 as live-computed, no cache', normalized_text: 'live computed',
      repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
      session_id: null, hash: 'h-user-profile-decision-1', source_hash: null,
    },
    events,
  );
}

describe('user_profile REST <-> MCP conformance', () => {
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

  it('REST /profile and MCP user_profile return byte-identical JSON', async () => {
    seedProfileCorpus(db);

    const restRes = await fetch(`${baseUrl}/profile`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const restBody = await restRes.json();

    const mcpResult = await toolCall(baseUrl, 'user_profile', {});

    expect(restRes.status).toBe(200);
    expect(mcpResult.isError).toBe(false);
    expect(withoutGeneratedAt(mcpResult.payload as Record<string, unknown>)).toEqual(withoutGeneratedAt(restBody));

    expect(restBody.scope).toBe('private');
    expect(restBody.standing_facts).toHaveLength(1);
    expect(restBody.standing_facts[0].evidence).toBe('config.yaml comment');
    expect(restBody.preferences).toHaveLength(1);
    expect(restBody.recurring_lessons).toHaveLength(1);
    expect(restBody.recent_decisions).toHaveLength(1);
    expect(restBody.total).toBe(4);
  });

  it('REST route requires Bearer auth (existing global preHandler) — 401, no per-scope 403 (AC-4)', async () => {
    const res = await fetch(`${baseUrl}/profile`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('rejects an unrecognized ?scope= value with 400 rather than silently defaulting', async () => {
    const res = await fetch(`${baseUrl}/profile?scope=bogus`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(400);
  });

  it('?scope=all widens the filter across scope values on both transports', async () => {
    const repo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    repo.insertWithCreateEvent(
      {
        type: 'fact', text: 'team-scoped fact', normalized_text: 'team scoped',
        repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
        session_id: null, hash: 'h-user-profile-scope-team', source_hash: null, scope: 'team',
      },
      events,
    );

    const restRes = await fetch(`${baseUrl}/profile?scope=all`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const restBody = await restRes.json();
    const mcpResult = await toolCall(baseUrl, 'user_profile', { scope: 'all' });

    expect(restBody.scope).toBe('all');
    expect(restBody.standing_facts).toHaveLength(1);
    expect(withoutGeneratedAt(mcpResult.payload as Record<string, unknown>)).toEqual(withoutGeneratedAt(restBody));
  });

  it('AC-6: buildUserProfile output is byte-stable across repeated calls against the same fixture DB', async () => {
    seedProfileCorpus(db);
    // Extra facts at the neutral 0.5 usefulness/importance default so ties
    // are actually exercised, not just theoretical.
    const repo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    for (let i = 0; i < 5; i++) {
      repo.insertWithCreateEvent(
        {
          type: 'fact', text: `tied fact ${i}`, normalized_text: `tied fact ${i}`,
          repo: 'astramem-local', project: null, branch: 'main', agent: 'claude-code',
          session_id: null, hash: `h-user-profile-tie-${i}`, source_hash: null,
        },
        events,
      );
    }

    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${baseUrl}/profile`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const body = await res.json();
      // generated_at is a build-time timestamp, not part of the ordering
      // guarantee — strip it before the byte-identity comparison.
      delete body.generated_at;
      results.push(JSON.stringify(body));
    }

    expect(new Set(results).size).toBe(1);
  });
});
