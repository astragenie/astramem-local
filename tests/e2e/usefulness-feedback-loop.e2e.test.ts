/**
 * E2E proof for the 2026-07-12 production finding: the ADR-010 usefulness
 * feedback loop is fully built (submit_feedback/mark_memory_used MCP tools,
 * usefulnessScores() Laplace smoothing, buildUserProfile/buildAgentProfile
 * consuming it, fuse.ts's epsilon component) but has NEVER fired in
 * production — GET /profile on the live daemon returned 30 entries, every
 * one pinned at the neutral prior 0.5. This is the "built, wired, never
 * invoked" bug class (same shape as the auto-capture-hook bug fixed the same
 * day).
 *
 * Written FIRST, confirmed RED against the pre-fix... except there is no fix
 * here: the daemon-side mechanism already works end-to-end when actually
 * invoked. The red run (see PR/handoff notes) failed only because this test
 * did not exist yet — once written, it is GREEN, because the wiring itself
 * is sound. The actual production bug is that nothing in the real usage path
 * ever calls submit_feedback/mark_memory_used — that is an invocation-site
 * gap (client/runner dispatch), not a daemon defect, and is explicitly out of
 * scope for this test (see team-lead handoff: "do NOT wire the feedback loop
 * yet").
 *
 * Crosses the same boundaries the live bug report crossed: real Fastify app,
 * real SQLite storage, real MCP tool dispatch (search_memory,
 * submit_feedback, invalidate_memory), real buildUserProfile query — the
 * exact GET /profile / MCP user_profile path that showed the frozen 0.5s in
 * production. Only a mock EmbedProvider stands in for Ollama (same pattern
 * as every other MCP conformance test in this repo — tests/mcp/*.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { makeFakeVec } from '../../src/search/search.js';
import { usefulnessScores } from '../../src/storage/usefulness.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../src/storage/db.js';

const TOKEN = 'test-usefulness-e2e-token';

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

async function toolCall(baseUrl: string, name: string, args: object): Promise<{ payload: any; isError: boolean }> {
  const resp = (await mcpPost(baseUrl, {
    jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 1,
  })) as { result?: { content?: Array<{ type: string; text: string }>; isError?: boolean } };
  const text = resp.result?.content?.[0]?.text ?? '{}';
  return { payload: JSON.parse(text), isError: resp.result?.isError === true };
}

async function getProfile(baseUrl: string): Promise<any> {
  const res = await fetch(`${baseUrl}/profile`, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  return res.json();
}

describe('ADR-010 usefulness feedback loop — e2e proof it actually moves the needle', () => {
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

  it('ingest -> recall -> mark_memory_used moves usefulness off 0.5 AND reorders standing_facts', async () => {
    // 1. Ingest two facts through the real save path (mcp remember), both
    //    landing at the neutral defaults (importance 0.5, no feedback yet)
    //    so they tie on every ranking key except the id ASC tiebreak.
    const a = await toolCall(baseUrl, 'remember', {
      content: 'astramem-local default embed model is mxbai-embed-large at 1024 dims',
      type: 'fact',
    });
    expect(a.isError).toBe(false);
    const idA = a.payload.id as string;

    const b = await toolCall(baseUrl, 'remember', {
      content: 'astramem-local daemon binds port 7777 by default in foreground dev mode',
      type: 'fact',
    });
    expect(b.isError).toBe(false);
    const idB = b.payload.id as string;

    // 2. Baseline profile read — this is the exact shape that showed 30
    //    entries frozen at 0.5 in production. Confirm the bug's starting
    //    condition locally: both facts at the Laplace prior, deterministic
    //    id-order tiebreak (buildUserProfile's documented sort key).
    const before = await getProfile(baseUrl);
    const beforeFacts = before.standing_facts as Array<{ id: string; usefulness: number }>;
    expect(beforeFacts).toHaveLength(2);
    expect(beforeFacts.every(f => f.usefulness === 0.5)).toBe(true);
    const firstBefore = beforeFacts[0]!;
    const secondBefore = beforeFacts[1]!;
    expect(firstBefore.id).toBe(idA < idB ? idA : idB);
    expect(secondBefore.id).toBe(idA < idB ? idB : idA);

    // 3. Recall both — real search_memory MCP call, records recall_served
    //    events on the real ADR-010 path (recordRecallServed). This alone
    //    must NOT move the score — only explicit feedback does.
    const search = await toolCall(baseUrl, 'search_memory', { query: 'astramem-local default', limit: 10 });
    expect(search.isError).toBe(false);
    const hitIds = (search.payload.hits as Array<{ id: string }>).map(h => h.id);
    expect(hitIds).toEqual(expect.arrayContaining([idA, idB]));

    const afterRecallOnly = await getProfile(baseUrl);
    expect((afterRecallOnly.standing_facts as Array<{ usefulness: number }>).every(f => f.usefulness === 0.5))
      .toBe(true); // recall_served alone must not move the needle — only explicit feedback does

    // 4. Mark the SECOND-ranked atom used — the real submit_feedback MCP
    //    tool (canonical name; mark_memory_used is the deprecated alias for
    //    the same handler). This is the exact call production never makes.
    const usedId = secondBefore.id;
    const feedback = await toolCall(baseUrl, 'submit_feedback', { id: usedId });
    expect(feedback.isError).toBe(false);
    expect(feedback.payload).toEqual({ ok: true, id: usedId });

    // 5. Re-read the profile through the SAME surface production users hit.
    const after = await getProfile(baseUrl);
    const afterFacts = after.standing_facts as Array<{ id: string; usefulness: number }>;

    const usedEntry = afterFacts.find(f => f.id === usedId)!;
    const untouchedEntry = afterFacts.find(f => f.id !== usedId)!;

    // The core assertion the production bug violated: score MOVES off 0.5.
    expect(usedEntry.usefulness).toBeCloseTo(2 / 3, 10); // (used=1+1)/(used=1+corrected=0+2)
    expect(usedEntry.usefulness).not.toBe(0.5);
    expect(untouchedEntry.usefulness).toBe(0.5); // unaffected sibling stays at the prior

    // Ranking actually reorders as a consequence — a score that moves but
    // doesn't reorder anything is still useless (team-lead's framing).
    expect(afterFacts[0]!.id).toBe(usedId);
    expect(afterFacts[1]!.id).toBe(untouchedEntry.id);
  });

  it('memory_corrected (invalidate_memory) pushes usefulness DOWN below the prior', async () => {
    const seeded = await toolCall(baseUrl, 'remember', {
      content: 'astramem-local uses nomic-embed-text-v2-moe as the embed default',
      type: 'fact',
    });
    expect(seeded.isError).toBe(false);
    const id = seeded.payload.id as string;

    // Baseline via the real storage function every ranking surface consumes
    // (usefulnessScores — src/storage/usefulness.ts, the same function
    // buildUserProfile/buildAgentProfile/fuse.ts all call). Not a mock of
    // the thing under test: it IS the production scoring function.
    expect(usefulnessScores(db, [id]).get(id)).toBe(0.5);

    // The fact was wrong (stale default) — correct it via the real MCP tool.
    const corrected = await toolCall(baseUrl, 'invalidate_memory', { id, reason: 'stale embed default, superseded by mxbai-embed-large' });
    expect(corrected.isError).toBe(false);

    // Document the real (and only) production behavior here: invalidate_memory
    // deactivates the atom (valid_to set), so it drops out of EVERY active
    // ranking surface (GET /profile, MCP user_profile/agent_profile,
    // fuse.ts search results) — there is currently no "corrected but still
    // visible, ranked lower" surface in this codebase, because the only two
    // real call sites for the memory_corrected signal (invalidate_memory,
    // supersede_memory) both retire the atom in the same transaction that
    // appends the correction event (src/storage/memory-events.ts:218-240,
    // :272-318). 'demoted'/'edited' correction actions exist in the type
    // union but have no wired call site yet (usefulness.ts file header).
    const afterCorrection = await getProfile(baseUrl);
    expect((afterCorrection.standing_facts as Array<{ id: string }>).some(f => f.id === id)).toBe(false);

    // The negative signal DID register on the real scoring function, even
    // though no active surface currently exposes it for a live atom.
    expect(usefulnessScores(db, [id]).get(id)).toBeCloseTo(1 / 3, 10); // (used=0+1)/(used=0+corrected=1+2)
  });
});
