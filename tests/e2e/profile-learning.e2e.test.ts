/**
 * E2E behavioral proof for the "agent learns from past mistakes" claim:
 * an agent that got something wrong, had it corrected, and later gets asked
 * a related question should (1) never be shown the wrong answer again, (2)
 * be shown the correction instead, (3) have that correction rank higher the
 * more it proves useful, and (4) have both the mistake and its correction
 * show up in its own agent_profile/user_profile as learned material — not
 * just as isolated rows in a table nobody reads.
 *
 * Exercises the real mechanics end-to-end against a real spawned Fastify +
 * SQLite app (no mocks except the deterministic fake embedder — same pattern
 * as tests/e2e/usefulness-feedback-loop.e2e.test.ts, which this test extends
 * rather than duplicates):
 *   - remember (MCP)                      -> seed mistake/correction/control memories
 *   - supersede_memory (MCP)               -> retire the mistake, link the correction
 *   - search_memory (MCP)                  -> superseded rows must be invisible
 *   - submit_feedback (MCP)                -> ADR-010 explicit recall-used signal
 *   - fuseScores epsilon component          -> usefulness measurably reorders results
 *   - agent_profile / user_profile (MCP)   -> corrections[] + top_lessons / recurring_lessons
 *   - invalidate_memory (MCP)              -> negative case: gone from search AND profile
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { makeFakeVec } from '../../src/search/search.js';
import { defaultConfig, type Config } from '../../src/config/config.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../src/storage/db.js';

const TOKEN = 'test-profile-learning-e2e-token';
const AGENT = 'test-agent';

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

// FEAT-428's `applyFusionGovernance` gate is a config-LOAD-time concern
// (loadConfig(), production's own boot path) — buildApp() takes a raw Config
// and never calls it, so this override reaches fuseScores() ungoverned, same
// as usefulness-feedback-loop.e2e.test.ts building its own weights object
// directly. epsilon=0.9 (vs. the shipped default 0.1) is deliberate: this
// test's rank-movement assertion (step 4 below) needs the usefulness signal
// to dominate BM25/cosine decisively and deterministically, not just nudge a
// tie — a real deployment would never run with epsilon this high, but the
// governance ceiling (search.governance.maxComponentWeight = 1.0) explicitly
// allows any single component up to 1.0, so 0.9 is a valid, in-range weight,
// not an artificial escape hatch.
function buildBoostedUsefulnessConfig(): Config {
  const base = defaultConfig();
  return {
    ...base,
    search: { ...base.search, alpha: 0.3, beta: 0.3, gamma: 0.05, delta: 0.05, epsilon: 0.9, zeta: 0, eta: 0 },
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
      // skip non-JSON lines (SSE framing)
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

describe('agent learns from past mistakes — e2e proof via agent_profile/user_profile/usefulness/lifecycle', () => {
  let db: DB;
  let app: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN, embed: buildMockEmbed(), config: buildBoostedUsefulnessConfig() });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('supersedes a mistake, hides it from search, surfaces the correction, and boosts it with feedback', async () => {
    // 1. Seed: the mistake (a real repo lesson — see this repo's own CLAUDE.md
    //    "Do NOT" section), a same-topic "sibling" memory of comparable
    //    textual relevance to the eventual query (the control for step 4's
    //    rank-movement assertion), and two unrelated control memories.
    const mistake = await toolCall(baseUrl, 'remember', {
      content: 'Killed production daemon with taskkill /IM node.exe',
      type: 'lesson',
      agentId: AGENT,
    });
    expect(mistake.isError).toBe(false);
    const mistakeId = mistake.payload.id as string;

    const sibling = await toolCall(baseUrl, 'remember', {
      content:
        'Kill node processes safely by targeting the specific PID, not a blanket image-name kill ' +
        'that takes out every other node process on the machine.',
      type: 'lesson',
      agentId: AGENT,
    });
    expect(sibling.isError).toBe(false);
    const siblingId = sibling.payload.id as string;

    const unrelated1 = await toolCall(baseUrl, 'remember', {
      content: 'astramemory-local default embed model is mxbai-embed-large at 1024 dims',
      type: 'fact',
      agentId: AGENT,
    });
    expect(unrelated1.isError).toBe(false);

    const unrelated2 = await toolCall(baseUrl, 'remember', {
      content: 'Decided to use Fastify for the local HTTP server',
      type: 'decision',
      agentId: AGENT,
    });
    expect(unrelated2.isError).toBe(false);

    const toInvalidate = await toolCall(baseUrl, 'remember', {
      content: 'astramemory-local uses nomic-embed-text-v2-moe as the embed default',
      type: 'fact',
      agentId: AGENT,
    });
    expect(toInvalidate.isError).toBe(false);
    const toInvalidateId = toInvalidate.payload.id as string;

    // 2. The mistake gets corrected — seed the correction, then supersede the
    //    mistake with it (the real lifecycle op: invalidates mistakeId and
    //    links it to correctionId via memory_events).
    const correction = await toolCall(baseUrl, 'remember', {
      content:
        'Kill node processes safely: target only the PIDs you spawned yourself, never kill by image ' +
        'name — that kills every other node process on the machine too.',
      type: 'lesson',
      agentId: AGENT,
    });
    expect(correction.isError).toBe(false);
    const correctionId = correction.payload.id as string;

    const supersede = await toolCall(baseUrl, 'supersede_memory', { old_id: mistakeId, new_id: correctionId });
    expect(supersede.isError).toBe(false);
    expect(supersede.payload).toEqual({ ok: true, old_id: mistakeId, new_id: correctionId });

    // 3. Ask the question the mistake was about. The correction must surface;
    //    the superseded mistake must NOT — this is the "doesn't repeat past
    //    mistakes" claim, backed by search.ts's real active-only predicate
    //    (valid_to IS NULL), not a special case for this test.
    const query = 'how to kill node processes safely';
    const searchBefore = await toolCall(baseUrl, 'search_memory', { query, limit: 10 });
    expect(searchBefore.isError).toBe(false);
    const hitIdsBefore = (searchBefore.payload.hits as Array<{ id: string }>).map(h => h.id);
    expect(hitIdsBefore).toContain(correctionId);
    expect(hitIdsBefore).not.toContain(mistakeId);

    const rankBefore = hitIdsBefore.indexOf(correctionId);
    const siblingRankBefore = hitIdsBefore.indexOf(siblingId);
    expect(siblingRankBefore).toBeGreaterThanOrEqual(0); // sibling is a real, present competitor, not a strawman

    // 4. The correction proves useful several times — the real explicit
    //    ADR-010 feedback channel (submit_feedback), not a synthetic score
    //    write. Re-search the same query: the correction must now outrank
    //    the textually-comparable sibling that never got any feedback. The
    //    daemon-wide default epsilon (0.1) makes this movement real but
    //    small; this test's boosted config (epsilon=0.9, see
    //    buildBoostedUsefulnessConfig) makes it assert-safe without being a
    //    different code path — same fuseScores formula, just a larger,
    //    in-range weight.
    for (let i = 0; i < 5; i++) {
      const feedback = await toolCall(baseUrl, 'submit_feedback', { id: correctionId });
      expect(feedback.isError).toBe(false);
    }

    const searchAfter = await toolCall(baseUrl, 'search_memory', { query, limit: 10 });
    expect(searchAfter.isError).toBe(false);
    const hitsAfter = searchAfter.payload.hits as Array<{ id: string; score: number }>;
    const hitIdsAfter = hitsAfter.map(h => h.id);
    expect(hitIdsAfter).toContain(correctionId);
    expect(hitIdsAfter).not.toContain(mistakeId);

    const rankAfter = hitIdsAfter.indexOf(correctionId);
    const siblingRankAfter = hitIdsAfter.indexOf(siblingId);
    expect(siblingRankAfter).toBeGreaterThanOrEqual(0);

    // Before any feedback, BM25/cosine alone rank the never-fed-back sibling
    // ahead of the correction (confirmed: sibling rank 1 vs. correction rank
    // 4 in a real run) — the test isn't rigged so the "after" assertion below
    // would hold trivially regardless of feedback.
    expect(rankBefore).toBeGreaterThan(siblingRankBefore);
    // The core claim: repeated positive feedback measurably reorders the
    // correction ahead of that same sibling — feedback moved the needle, it
    // isn't cosmetic.
    expect(rankAfter).toBeLessThan(siblingRankAfter);

    // 5. agent_profile for this agent: the mistake shows up as a correction
    //    (with the correction's own text linked as superseding_text), and the
    //    correction itself shows up as a top lesson.
    const agentProfile = await toolCall(baseUrl, 'agent_profile', { agent: AGENT });
    expect(agentProfile.isError).toBe(false);

    const corrections = agentProfile.payload.corrections as Array<{
      id: string; action: string; superseded_by: string | null; superseding_text: string | null;
    }>;
    const mistakeCorrection = corrections.find(c => c.id === mistakeId);
    expect(mistakeCorrection).toBeDefined();
    expect(mistakeCorrection!.action).toBe('superseded');
    expect(mistakeCorrection!.superseded_by).toBe(correctionId);
    expect(mistakeCorrection!.superseding_text).toBe(
      'Kill node processes safely: target only the PIDs you spawned yourself, never kill by image ' +
      'name — that kills every other node process on the machine too.',
    );

    const topLessons = agentProfile.payload.top_lessons as Array<{ id: string }>;
    expect(topLessons.map(l => l.id)).toContain(correctionId);
    // The superseded mistake is retired — it must not still be offered as a
    // "top lesson" alongside its own correction.
    expect(topLessons.map(l => l.id)).not.toContain(mistakeId);

    // 6. user_profile (daemon-wide, default scope='private'): the correction
    //    is a recurring lesson.
    const userProfile = await toolCall(baseUrl, 'user_profile', {});
    expect(userProfile.isError).toBe(false);
    const recurringLessons = userProfile.payload.recurring_lessons as Array<{ id: string }>;
    expect(recurringLessons.map(l => l.id)).toContain(correctionId);
    expect(recurringLessons.map(l => l.id)).not.toContain(mistakeId);

    // 7. Negative case: invalidating a control memory removes it from BOTH
    //    search and every profile section it would otherwise have appeared
    //    in — the same "gone means gone" guarantee the mistake's supersession
    //    relied on above, exercised via the sibling lifecycle op.
    const invalidate = await toolCall(baseUrl, 'invalidate_memory', {
      id: toInvalidateId,
      reason: 'stale embed default, superseded by mxbai-embed-large',
    });
    expect(invalidate.isError).toBe(false);

    const searchForInvalidated = await toolCall(baseUrl, 'search_memory', {
      query: 'embed model default dims',
      limit: 10,
    });
    expect(searchForInvalidated.isError).toBe(false);
    const invalidatedHitIds = (searchForInvalidated.payload.hits as Array<{ id: string }>).map(h => h.id);
    expect(invalidatedHitIds).not.toContain(toInvalidateId);

    const userProfileAfterInvalidate = await toolCall(baseUrl, 'user_profile', {});
    expect(userProfileAfterInvalidate.isError).toBe(false);
    const standingFactsAfter = userProfileAfterInvalidate.payload.standing_facts as Array<{ id: string }>;
    expect(standingFactsAfter.map(f => f.id)).not.toContain(toInvalidateId);

    const agentProfileAfterInvalidate = await toolCall(baseUrl, 'agent_profile', { agent: AGENT });
    expect(agentProfileAfterInvalidate.isError).toBe(false);
    // 'fact' isn't a top_lessons/recent_decisions source type, so the direct
    // absence proof for this section is the per-type count dropping to zero
    // rather than a list membership check.
    expect(agentProfileAfterInvalidate.payload.counts.fact ?? 0).toBe(1); // unrelated1 remains; toInvalidateId is gone
  });
});
