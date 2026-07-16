/**
 * #341 daemon-side contract half — flat top-level `project`/`agent` tags.
 *
 * Context: astragenie/runner-plugin#515 shipped a CONSUMER-side mitigation
 * (memory-sink.mts sends `project`/`agent` as top-level payload fields
 * alongside the legacy nested `metadata` copy) after discovering the
 * astramem-plugin in-process provider preserves flat top-level tags fine.
 * The residual daemon-side risk this test locks: a future regression that
 * makes either ingest surface go back to reading ONLY the nested
 * `metadata.project`/`metadata.agent` form would silently untag every
 * memory written by a flat-tag-only client, with green tests everywhere
 * else (the exact "guidance cannot fix a bad default" failure class this
 * repo has hit before — see CLAUDE.md's canary-must-measure-rate note).
 *
 * Two surfaces, both proven end-to-end (write with flat tags -> recall
 * filtered by project=/agent= returns them):
 *   - POST /remember       — direct insert. Was NESTED-ONLY before this
 *                             slice (search.ts's RememberBodySchema had no
 *                             top-level project/agent field at all) — fixed
 *                             here, additive + backward-compatible.
 *   - POST /ingest/transcript — legacy envelope (`project`/`agent`) and
 *                             canonical envelope (`project_id`/`agent_type`)
 *                             both already flat top-level on the wire and
 *                             already land on `sessions.project`/`.agent`
 *                             (ingest.ts's stmtUpsertSession) — this test is
 *                             the regression LOCK, not a fix, and follows
 *                             the chain all the way through the distill
 *                             pipeline to a recall-filterable memory, the
 *                             same way distillHandler is exercised in
 *                             tests/pipeline/handlers/distill.test.ts.
 *
 * Cross-repo residual (NOT fixed here, flagged in the PR body): the shared
 * `@astragenie/astramem-client@0.3.0` daemon-client's `remember()` still
 * nests project/agent under `metadata` before POSTing despite its own
 * `RememberRequest` type declaring them flat — a plugins-common fix, out of
 * scope for this daemon-side slice.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { distillHandler } from '../../src/pipeline/handlers/distill.js';
import { defaultConfig } from '../../src/config/config.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { makeFakeVec } from '../../src/search/search.js';
import type { ExtendedHandlerCtx } from '../../src/pipeline/handler-ctx-ext.js';
import type { DB } from '../../src/storage/db.js';
import type {
  EmbedProvider,
  LLMProvider,
  ChatMsg,
  ChatOpts,
  ChatResult,
  LLMHealth,
  EmbedHealth,
} from '../../src/contracts/index.js';
import type { FastifyInstance } from 'fastify';

const AUTH = { authorization: 'Bearer tok', 'content-type': 'application/json' } as const;

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

/** Extraction fires only when the transcript mentions "sqlite-vec" — same
 *  trigger convention as tests/pipeline/handlers/distill.test.ts's mock. */
function makeMockLLM(): LLMProvider {
  return {
    name: 'ollama' as const,
    model: 'test-model',
    async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
      const userContent = messages.find(m => m.role === 'user')?.content ?? '';
      const systemContent = messages.find(m => m.role === 'system')?.content ?? '';
      const isExtraction = opts?.json === true || systemContent.includes('atoms');
      if (isExtraction) {
        const mentions = userContent.toLowerCase().includes('sqlite-vec');
        const atoms = mentions
          ? [{ type: 'decision', text: 'use sqlite-vec for v1 vector storage', importance: 0.9, confidence: 0.9, evidence: 'sqlite-vec is the call' }]
          : [];
        return { text: JSON.stringify({ atoms }), usage: { in: 10, out: 10, usd: 0 } };
      }
      return { text: userContent, usage: { in: 10, out: 10, usd: 0 } };
    },
    async health(): Promise<LLMHealth> {
      return { ok: true, model: 'test-model', latency_ms: 0 };
    },
  };
}

function makeMockEmbedForPipeline(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'test-embed',
    dim: 1024 as const,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((_, i) => {
        const v = new Float32Array(1024);
        for (let j = 0; j < 1024; j++) v[j] = Math.sin(i + j * 0.01);
        return v;
      });
    },
    async health(): Promise<EmbedHealth> {
      return { ok: true, model: 'test-embed', dim: 1024 };
    },
  };
}

// ---------------------------------------------------------------------------
// POST /remember — flat top-level project/agent
// ---------------------------------------------------------------------------

describe('POST /remember — flat top-level project/agent (#341)', () => {
  let db: DB;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
  });

  it('preserves flat top-level project/agent end-to-end: write -> recall filtered by project=/agent= returns it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/remember',
      headers: AUTH,
      payload: {
        text: 'flat-tag remember write for issue 341',
        type: 'fact',
        project: 'proj-flat-341',
        agent: 'agent-flat-341',
      },
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json();

    // Persisted on the row itself, not just accepted-and-dropped.
    const row = db.prepare('SELECT project, agent FROM memories WHERE id = ?').get(id) as
      | { project: string | null; agent: string | null }
      | undefined;
    expect(row?.project).toBe('proj-flat-341');
    expect(row?.agent).toBe('agent-flat-341');

    // And recall-filterable — the end-to-end claim, not just a column check.
    const projectHit = await app.inject({
      method: 'GET',
      url: '/search?q=flat-tag&project=proj-flat-341',
      headers: AUTH,
    });
    expect(projectHit.statusCode).toBe(200);
    expect(projectHit.json().hits.map((h: { id: string }) => h.id)).toContain(id);

    const agentHit = await app.inject({
      method: 'GET',
      url: '/search?q=flat-tag&agent=agent-flat-341',
      headers: AUTH,
    });
    expect(agentHit.statusCode).toBe(200);
    expect(agentHit.json().hits.map((h: { id: string }) => h.id)).toContain(id);

    // A non-matching project must NOT return it — proves the filter is
    // actually discriminating, not just present.
    const miss = await app.inject({
      method: 'GET',
      url: '/search?q=flat-tag&project=some-other-project',
      headers: AUTH,
    });
    expect(miss.json().hits.map((h: { id: string }) => h.id)).not.toContain(id);
  });

  it('flat top-level project/agent take priority over deprecated nested metadata when both are supplied', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/remember',
      headers: AUTH,
      payload: {
        text: 'flat wins over nested for issue 341',
        type: 'fact',
        project: 'flat-project',
        agent: 'flat-agent',
        metadata: { project: 'nested-project', agent: 'nested-agent' },
      },
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json();
    const row = db.prepare('SELECT project, agent FROM memories WHERE id = ?').get(id) as
      | { project: string | null; agent: string | null }
      | undefined;
    expect(row?.project).toBe('flat-project');
    expect(row?.agent).toBe('flat-agent');
  });

  it('still honors the deprecated nested metadata.project/metadata.agent form when no flat field is sent (backward compat)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/remember',
      headers: AUTH,
      payload: {
        text: 'nested-only remember for issue 341 backward compat',
        type: 'fact',
        metadata: { project: 'nested-only-project', agent: 'nested-only-agent' },
      },
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json();
    const row = db.prepare('SELECT project, agent FROM memories WHERE id = ?').get(id) as
      | { project: string | null; agent: string | null }
      | undefined;
    expect(row?.project).toBe('nested-only-project');
    expect(row?.agent).toBe('nested-only-agent');
  });
});

// ---------------------------------------------------------------------------
// POST /ingest/transcript — flat top-level project/agent, both envelopes.
// Locks the chain: HTTP body -> sessions row -> distillHandler (run
// directly, same pattern as tests/pipeline/handlers/distill.test.ts) ->
// memories row -> recall filter.
// ---------------------------------------------------------------------------

describe('POST /ingest/transcript — flat top-level project/agent preserved end-to-end (#341)', () => {
  let db: DB;
  let app: FastifyInstance;
  let pipelineCtx: ExtendedHandlerCtx;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
    pipelineCtx = {
      db,
      config: defaultConfig(),
      providers: { llm: { compaction: makeMockLLM(), extraction: makeMockLLM() }, embed: makeMockEmbedForPipeline() },
      memoryRepo: new MemoryRepo(db),
      vecStore: new SqliteVecStore(db),
    };
  });

  it('legacy envelope: flat top-level project/agent land on sessions, survive distill, and are recall-filterable', async () => {
    const sessionId = `s-${randomUUID()}`;
    const ingestRes = await app.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: {
        session_id: sessionId,
        source: 'PreCompact',
        content: 'user: what vector store should we use for v1?\nassistant: sqlite-vec — no network dependency, single-process.',
        project: 'proj-legacy-341',
        agent: 'agent-legacy-341',
      },
    });
    expect(ingestRes.statusCode).toBe(200);

    // Locks the "accepted flat top-level, not nested-only" contract at the
    // durable session row — this is what a regression back to nested-only
    // reading would break first.
    const session = db.prepare('SELECT project, agent FROM sessions WHERE id = ?').get(sessionId) as
      | { project: string | null; agent: string | null }
      | undefined;
    expect(session?.project).toBe('proj-legacy-341');
    expect(session?.agent).toBe('agent-legacy-341');

    const transcript = db.prepare('SELECT id FROM transcripts WHERE session_id = ?').get(sessionId) as
      | { id: string }
      | undefined;
    expect(transcript).toBeDefined();

    await distillHandler.handle({ transcript_id: transcript!.id, session_id: sessionId }, pipelineCtx);

    const memories = db.prepare('SELECT id, project, agent FROM memories').all() as
      { id: string; project: string | null; agent: string | null }[];
    expect(memories.length).toBeGreaterThanOrEqual(1);
    for (const m of memories) {
      expect(m.project).toBe('proj-legacy-341');
      expect(m.agent).toBe('agent-legacy-341');
    }

    const projectHit = await app.inject({
      method: 'GET',
      url: '/search?q=sqlite-vec&project=proj-legacy-341',
      headers: AUTH,
    });
    expect(projectHit.json().hits.map((h: { id: string }) => h.id)).toContain(memories[0]!.id);

    const agentHit = await app.inject({
      method: 'GET',
      url: '/search?q=sqlite-vec&agent=agent-legacy-341',
      headers: AUTH,
    });
    expect(agentHit.json().hits.map((h: { id: string }) => h.id)).toContain(memories[0]!.id);
  });

  it('canonical envelope: flat top-level project_id/agent_type land on sessions, survive distill, and are recall-filterable', async () => {
    const sessionId = `s-${randomUUID()}`;
    const ingestRes = await app.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: AUTH,
      payload: {
        event: 'pre_compact',
        session_id: sessionId,
        project_id: 'proj-canonical-341',
        agent_type: 'agent-canonical-341',
        captured_at: '2026-07-16T10:00:00.000Z',
        turns: [
          { role: 'user', text: 'what vector store should we use for v1?' },
          { role: 'assistant', text: 'sqlite-vec — no network dependency, single-process.' },
        ],
        client_scrub_applied: true,
        client_scrub_hits: 0,
        client_version: '0.19.0',
        client_scrub_version: '1.2.0',
        wire_version: 'v1.0',
      },
    });
    expect(ingestRes.statusCode).toBe(200);

    const session = db.prepare('SELECT project, agent FROM sessions WHERE id = ?').get(sessionId) as
      | { project: string | null; agent: string | null }
      | undefined;
    expect(session?.project).toBe('proj-canonical-341');
    expect(session?.agent).toBe('agent-canonical-341');

    const transcript = db.prepare('SELECT id FROM transcripts WHERE session_id = ?').get(sessionId) as
      | { id: string }
      | undefined;
    expect(transcript).toBeDefined();

    await distillHandler.handle({ transcript_id: transcript!.id, session_id: sessionId }, pipelineCtx);

    const memories = db.prepare('SELECT id, project, agent FROM memories').all() as
      { id: string; project: string | null; agent: string | null }[];
    expect(memories.length).toBeGreaterThanOrEqual(1);
    for (const m of memories) {
      expect(m.project).toBe('proj-canonical-341');
      expect(m.agent).toBe('agent-canonical-341');
    }

    const projectHit = await app.inject({
      method: 'GET',
      url: '/search?q=sqlite-vec&project=proj-canonical-341',
      headers: AUTH,
    });
    expect(projectHit.json().hits.map((h: { id: string }) => h.id)).toContain(memories[0]!.id);

    const agentHit = await app.inject({
      method: 'GET',
      url: '/search?q=sqlite-vec&agent=agent-canonical-341',
      headers: AUTH,
    });
    expect(agentHit.json().hits.map((h: { id: string }) => h.id)).toContain(memories[0]!.id);
  });
});
