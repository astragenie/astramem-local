import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../../src/storage/db.js';
import { migrate } from '../../../src/storage/migrate.js';
import { distillEventsHandler } from '../../../src/pipeline/handlers/distill-events.js';
import { defaultConfig } from '../../../src/config/config.js';
import { MemoryRepo } from '../../../src/storage/memories.js';
import { SqliteVecStore } from '../../../src/vector/sqlite-vec.js';
import type { ExtendedHandlerCtx } from '../../../src/pipeline/handler-ctx-ext.js';
import type { DB } from '../../../src/storage/db.js';
import type { EmbedProvider, EmbedHealth, LLMProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth } from '../../../src/contracts/index.js';

// ---------------------------------------------------------------------------
// ADR-008 events capture kind — handler coverage. Stages 6-8 only, no LLM
// calls, so the mock LLM provider here is never invoked (present only
// because ExtendedHandlerCtx.providers requires it).
// ---------------------------------------------------------------------------

function makeMockLLM(): LLMProvider {
  return {
    name: 'ollama' as const,
    model: 'test-model',
    async chat(_messages: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
      throw new Error('distill-events must not call the LLM provider — stages 1-5 are skipped');
    },
    async health(): Promise<LLMHealth> {
      return { ok: true, model: 'test-model', latency_ms: 0 };
    },
  };
}

function makeMockEmbed(): EmbedProvider {
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

function insertSession(db: DB, id: string, overrides: Partial<{ repo: string; project: string; branch: string; agent: string }> = {}): void {
  db.prepare(`
    INSERT INTO sessions (id, repo, project, branch, agent, started_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, overrides.repo ?? null, overrides.project ?? null, overrides.branch ?? null, overrides.agent ?? null, Date.now());
}

interface StoredEvent {
  type: string;
  text: string;
  importance?: number;
  confidence?: number;
  evidence?: string;
  occurred_at?: number;
}

/** Inserts a transcript row shaped exactly as the events-kind ingest path writes it. */
function insertEventsTranscript(db: DB, id: string, sessionId: string, events: StoredEvent[], source = 'runner-plugin-events'): void {
  db.prepare(`
    INSERT INTO transcripts (id, session_id, source, content, ingested_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, sessionId, source, JSON.stringify(events), Date.now());
}

describe('distillEventsHandler', () => {
  let db: DB;
  let ctx: ExtendedHandlerCtx;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    ctx = {
      db,
      config: defaultConfig(),
      providers: { llm: { compaction: makeMockLLM(), extraction: makeMockLLM() }, embed: makeMockEmbed() },
      memoryRepo: new MemoryRepo(db),
      vecStore: new SqliteVecStore(db),
    };
  });

  it('kind is registered as distill-events', () => {
    expect(distillEventsHandler.kind).toBe('distill-events');
  });

  it('creates memories with correct types/importance, applying defaults when omitted', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(db, sessionId, { repo: 'astramem-local', project: 'proj', branch: 'main', agent: 'runner-plugin' });
    insertEventsTranscript(db, transcriptId, sessionId, [
      { type: 'lesson', text: 'Bun does not support better-sqlite3 native bindings on Windows in CI.', importance: 0.8, confidence: 0.95, evidence: 'npm test failed' },
      { type: 'decision', text: 'Events kind ships stages 6-8 only, no schema change.' }, // no importance/confidence — defaults apply
    ]);

    await distillEventsHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const memories = db.prepare('SELECT id, type, text, importance, confidence, evidence, repo, project, branch, agent, session_id FROM memories ORDER BY text')
      .all() as Array<{ id: string; type: string; text: string; importance: number; confidence: number; evidence: string | null; repo: string; project: string; branch: string; agent: string; session_id: string }>;
    expect(memories).toHaveLength(2);

    const lesson = memories.find(m => m.type === 'lesson')!;
    expect(lesson).toBeDefined();
    expect(lesson.importance).toBeCloseTo(0.8);
    expect(lesson.confidence).toBeCloseTo(0.95);
    expect(lesson.evidence).toBe('npm test failed');
    expect(lesson.repo).toBe('astramem-local');
    expect(lesson.project).toBe('proj');
    expect(lesson.branch).toBe('main');
    expect(lesson.agent).toBe('runner-plugin');
    expect(lesson.session_id).toBe(sessionId);

    const decision = memories.find(m => m.type === 'decision')!;
    expect(decision).toBeDefined();
    // ADR-008 defaults: importance 0.7, confidence 0.9 when omitted.
    expect(decision.importance).toBeCloseTo(0.7);
    expect(decision.confidence).toBeCloseTo(0.9);
  });

  it('dedups two near-identical events into a single memory via stage 6 (reduce)', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(db, sessionId);
    insertEventsTranscript(db, transcriptId, sessionId, [
      { type: 'fact', text: '  Port 7777 is the default.  ', importance: 0.5 },
      { type: 'fact', text: 'port 7777 is the default.', importance: 0.9 }, // same normalized text, higher importance wins
    ]);

    await distillEventsHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const memories = db.prepare('SELECT importance FROM memories').all() as { importance: number }[];
    expect(memories).toHaveLength(1);
    expect(memories[0]!.importance).toBeCloseTo(0.9);
  });

  it('appends a create memory_event for each newly created memory (2b)', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(db, sessionId);
    insertEventsTranscript(db, transcriptId, sessionId, [
      { type: 'todo', text: 'wire up the runner-plugin events adapter end-to-end' },
    ]);

    await distillEventsHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const memories = db.prepare('SELECT id FROM memories').all() as { id: string }[];
    expect(memories).toHaveLength(1);

    const events = db.prepare('SELECT event_type, atom_id FROM memory_events WHERE atom_id = ?').all(memories[0]!.id) as { event_type: string; atom_id: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('create');
  });

  it('embeds and indexes each memory — vec row exists and embedding metadata is set', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(db, sessionId);
    insertEventsTranscript(db, transcriptId, sessionId, [
      { type: 'note', text: 'astramem-local uses sqlite-vec for vector storage.' },
    ]);

    await distillEventsHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const memories = db.prepare('SELECT id, embedding_provider, embedding_model, embedding_dim FROM memories').all() as
      { id: string; embedding_provider: string | null; embedding_model: string | null; embedding_dim: number | null }[];
    expect(memories).toHaveLength(1);
    expect(memories[0]!.embedding_provider).toBe('ollama');
    expect(memories[0]!.embedding_model).toBe('test-embed');
    expect(memories[0]!.embedding_dim).toBe(1024);

    const vecRows = db.prepare('SELECT rowid FROM memories_vec WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)').all(memories[0]!.id);
    expect(vecRows.length).toBe(1);
  });

  it('backfills ingest_idempotency.summary_memory_id from the transcript placeholder to the real memory id', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    const idemKey = 'events-idem-key-1';
    insertSession(db, sessionId);
    insertEventsTranscript(db, transcriptId, sessionId, [{ type: 'note', text: 'backfill parity with distillHandler' }]);
    db.prepare(`
      INSERT INTO ingest_idempotency (key, body_hash, summary_memory_id, created_at)
      VALUES (?, 'irrelevant-hash', ?, ?)
    `).run(idemKey, transcriptId, Date.now());

    await distillEventsHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const row = db.prepare('SELECT summary_memory_id FROM ingest_idempotency WHERE key = ?').get(idemKey) as { summary_memory_id: string };
    expect(row.summary_memory_id).not.toBe(transcriptId);
    const memories = db.prepare('SELECT id FROM memories').all() as { id: string }[];
    expect(memories.map(m => m.id)).toContain(row.summary_memory_id);
  });

  it('throws for an unknown transcript id (job should fail, not silently no-op)', async () => {
    await expect(
      distillEventsHandler.handle({ transcript_id: randomUUID(), session_id: randomUUID() }, ctx),
    ).rejects.toThrow(/Transcript not found/);
  });

  it('throws for content that is not a valid events JSON array (deterministic failure)', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(db, sessionId);
    db.prepare(`
      INSERT INTO transcripts (id, session_id, source, content, ingested_at)
      VALUES (?, ?, 'events', ?, ?)
    `).run(transcriptId, sessionId, JSON.stringify([{ role: 'user', text: 'this is a turns shape, not events' }]), Date.now());

    await expect(
      distillEventsHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx),
    ).rejects.toThrow(/does not match the events shape/);
  });

  it('does not crash and is a no-op when no providers are present in ctx', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(db, sessionId);
    insertEventsTranscript(db, transcriptId, sessionId, [{ type: 'note', text: 'no providers path' }]);

    const bareCtx = { db, config: defaultConfig() };
    await expect(
      distillEventsHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, bareCtx),
    ).resolves.toBeUndefined();

    const memories = db.prepare('SELECT id FROM memories').all();
    expect(memories).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// e2e-ish: POST events envelope -> job row -> run handler -> memory searchable
// ---------------------------------------------------------------------------

describe('distillEventsHandler — e2e-ish (ingest -> job -> handler -> searchable)', () => {
  it('POST events envelope, run the enqueued distill-events job, memory is searchable via FTS', async () => {
    const { buildApp } = await import('../../../src/server/app.js');
    const db = openDb(':memory:');
    migrate(db);
    const app = await buildApp({ db, token: 't' });

    const res = await app.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      payload: {
        event: 'session_end',
        session_id: 'sess-e2e-events',
        project_id: 'proj-e2e',
        captured_at: '2026-07-02T10:00:00.000Z',
        kind: 'events',
        tool: 'runner-plugin',
        client_scrub_applied: false,
        client_scrub_hits: 0,
        client_version: '0.1.0',
        client_scrub_version: 'n/a',
        wire_version: 'v1.0',
        events: [{ type: 'fact', text: 'distill-events e2e coverage exercises the full ingest-to-search path.' }],
      },
    });
    expect(res.statusCode).toBe(200);

    const job = db.prepare("SELECT id, kind, payload_json FROM jobs WHERE state = 'pending'").get() as
      { id: string; kind: string; payload_json: string } | undefined;
    expect(job).toBeDefined();
    expect(job!.kind).toBe('distill-events');
    const jobPayload = JSON.parse(job!.payload_json) as { transcript_id: string; session_id: string };

    const ctx: ExtendedHandlerCtx = {
      db,
      config: defaultConfig(),
      providers: { llm: { compaction: makeMockLLM(), extraction: makeMockLLM() }, embed: makeMockEmbed() },
      memoryRepo: new MemoryRepo(db),
      vecStore: new SqliteVecStore(db),
    };
    await distillEventsHandler.handle(jobPayload, ctx);

    // FTS5 query syntax treats bare hyphens as the NOT operator, so search on
    // an unhyphenated word from the stored text rather than "distill-events".
    const hits = new MemoryRepo(db).searchFts('coverage', 10);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some(h => h.text.includes('distill-events e2e coverage'))).toBe(true);
  });
});
