import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../../src/storage/db.js';
import { migrate } from '../../../src/storage/migrate.js';
import { distillHandler } from '../../../src/pipeline/handlers/distill.js';
import { defaultConfig } from '../../../src/config/config.js';
import { MemoryRepo } from '../../../src/storage/memories.js';
import { SqliteVecStore } from '../../../src/vector/sqlite-vec.js';
import { search } from '../../../src/search/search.js';
import type { ExtendedHandlerCtx } from '../../../src/pipeline/handler-ctx-ext.js';
import type { DB } from '../../../src/storage/db.js';
import type { LLMProvider, EmbedProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth, EmbedHealth } from '../../../src/contracts/index.js';

// ---------------------------------------------------------------------------
// Mock providers — extraction triggers only when the (flattened) transcript
// text mentions "sqlite-vec", mirroring src/pipeline/mock-providers.ts.
// ---------------------------------------------------------------------------

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

function insertSession(db: DB, id: string): void {
  db.prepare(`
    INSERT INTO sessions (id, repo, project, branch, agent, started_at)
    VALUES (?, NULL, NULL, NULL, NULL, ?)
  `).run(id, Date.now());
}

/** FEAT-423: session carries only a cwd (no explicit repo/project). */
function insertSessionWithCwd(db: DB, id: string, cwd: string): void {
  db.prepare(`
    INSERT INTO sessions (id, repo, project, branch, agent, cwd, started_at)
    VALUES (?, NULL, NULL, NULL, NULL, ?, ?)
  `).run(id, cwd, Date.now());
}

/**
 * Inserts a transcript row shaped exactly as the canonical ingest path writes it
 * (JSON.stringify(turns)). `capturedAtMs` mirrors what POST /ingest/transcript
 * stores from the envelope's `captured_at` field — null reproduces a legacy
 * v0.0 ingest (no captured_at column value).
 */
function insertCanonicalTranscript(
  db: DB,
  id: string,
  sessionId: string,
  turns: Array<{ role: string; text: string }>,
  capturedAtMs: number | null = null,
  captureSource: 'auto_capture' | null = null,
): void {
  db.prepare(`
    INSERT INTO transcripts (id, session_id, source, content, ingested_at, captured_at, capture_source)
    VALUES (?, ?, 'claude-code-pre_compact', ?, ?, ?, ?)
  `).run(id, sessionId, JSON.stringify(turns), Date.now(), capturedAtMs, captureSource);
}

/** Inserts an ingest_idempotency row exactly as POST /ingest/transcript does at insert time: summary_memory_id === transcript id. */
function insertIdempotencyPlaceholder(db: DB, key: string, transcriptId: string): void {
  db.prepare(`
    INSERT INTO ingest_idempotency (key, body_hash, summary_memory_id, created_at)
    VALUES (?, 'irrelevant-hash', ?, ?)
  `).run(key, transcriptId, Date.now());
}

function readSummaryMemoryId(db: DB, key: string): string | null {
  const row = db.prepare('SELECT summary_memory_id FROM ingest_idempotency WHERE key = ?').get(key) as
    | { summary_memory_id: string | null }
    | undefined;
  return row?.summary_memory_id ?? null;
}

describe('distillHandler', () => {
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

  it('D-DEF1: processes canonical JSON-turns transcript content without error and creates a memory', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(db, sessionId);
    insertCanonicalTranscript(db, transcriptId, sessionId, [
      { role: 'user', text: 'what vector store should we use for v1?' },
      { role: 'assistant', text: 'sqlite-vec — no network dependency, single-process.' },
    ]);

    await distillHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const memories = db.prepare('SELECT id, text FROM memories').all() as { id: string; text: string }[];
    expect(memories.length).toBeGreaterThanOrEqual(1);
  });

  it('D-DEF2: backfills ingest_idempotency.summary_memory_id from the transcript placeholder to the real created memory id', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    const idemKey = 'idem-key-1';
    insertSession(db, sessionId);
    insertCanonicalTranscript(db, transcriptId, sessionId, [
      { role: 'user', text: 'what vector store should we use for v1?' },
      { role: 'assistant', text: 'sqlite-vec — no network dependency, single-process.' },
    ]);
    // Simulate what POST /ingest/transcript already did synchronously before
    // this job ran: summary_memory_id === transcript id (placeholder).
    insertIdempotencyPlaceholder(db, idemKey, transcriptId);
    expect(readSummaryMemoryId(db, idemKey)).toBe(transcriptId);

    await distillHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const memories = db.prepare('SELECT id FROM memories').all() as { id: string }[];
    expect(memories.length).toBeGreaterThanOrEqual(1);

    // The idempotency row must now point at a REAL memory id, not the transcript id.
    const backfilled = readSummaryMemoryId(db, idemKey);
    expect(backfilled).not.toBe(transcriptId);
    expect(memories.map(m => m.id)).toContain(backfilled);
  });

  it('D-DEF2: is a no-op when no idempotency row exists for the transcript (no Idempotency-Key was sent)', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(db, sessionId);
    insertCanonicalTranscript(db, transcriptId, sessionId, [
      { role: 'user', text: 'what vector store should we use for v1?' },
      { role: 'assistant', text: 'sqlite-vec — no network dependency, single-process.' },
    ]);

    // No ingest_idempotency row seeded — handler must not throw.
    await expect(
      distillHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx),
    ).resolves.toBeUndefined();

    const rows = db.prepare('SELECT * FROM ingest_idempotency').all();
    expect(rows).toHaveLength(0);
  });

  it('FEAT-423: derives a non-null project from session cwd when session.project is null', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSessionWithCwd(db, sessionId, '/home/user/my-repo');
    insertCanonicalTranscript(db, transcriptId, sessionId, [
      { role: 'user', text: 'what vector store should we use for v1?' },
      { role: 'assistant', text: 'sqlite-vec — no network dependency, single-process.' },
    ]);

    await distillHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const memories = db.prepare('SELECT id, project FROM memories').all() as { id: string; project: string | null }[];
    expect(memories.length).toBeGreaterThanOrEqual(1);
    for (const m of memories) {
      expect(m.project).toBe('my-repo');
    }
  });

  it('does not create memories or crash when extraction yields zero atoms (no sqlite-vec mention)', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(db, sessionId);
    insertCanonicalTranscript(db, transcriptId, sessionId, [
      { role: 'user', text: 'what is the weather today?' },
      { role: 'assistant', text: 'I do not have access to weather data.' },
    ]);

    await distillHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const memories = db.prepare('SELECT id FROM memories').all();
    expect(memories).toHaveLength(0);
  });

  // BUG FIX: as_of was keyed on ingest wall-clock time because captured_at
  // (stored on the transcripts row by the ingest route) was never read back
  // and threaded into the atom's valid_from at distill time. This proves the
  // full plumb: canonical envelope captured_at -> transcripts.captured_at ->
  // distillHandler -> PipelineContext.capturedAtMs -> embedAndIndex ->
  // memories.valid_from -> as_of bitemporal search.
  const SEARCH_WEIGHTS = { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1 };

  it('BUG FIX: captured_at threads into memories.valid_from, driving as_of correctly', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    const capturedAtMs = Date.parse('2023-06-01T00:00:00.000Z');
    insertSession(db, sessionId);
    insertCanonicalTranscript(db, transcriptId, sessionId, [
      { role: 'user', text: 'what vector store should we use for v1?' },
      { role: 'assistant', text: 'sqlite-vec — no network dependency, single-process.' },
    ], capturedAtMs);

    await distillHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const memories = db.prepare('SELECT id, valid_from FROM memories').all() as { id: string; valid_from: number }[];
    expect(memories.length).toBeGreaterThanOrEqual(1);
    // valid_from must be the captured_at instant, not "now" (Date.now() at
    // distill time would be many years later than 2023-06-01).
    for (const m of memories) {
      expect(m.valid_from).toBe(capturedAtMs);
    }

    const searchOpts = { db, embed: ctx.providers.embed, weights: SEARCH_WEIGHTS };

    // as_of before captured_at: the memory is not yet valid at that instant.
    const before = await search('sqlite-vec vector storage', { as_of: Date.parse('2023-01-01T00:00:00.000Z') }, 10, searchOpts);
    expect(before.map(h => h.id)).not.toContain(memories[0]!.id);

    // as_of after captured_at: the memory is valid at that instant and is found.
    const after = await search('sqlite-vec vector storage', { as_of: Date.parse('2023-12-01T00:00:00.000Z') }, 10, searchOpts);
    expect(after.map(h => h.id)).toContain(memories[0]!.id);
  });

  it('legacy v0.0 envelope (no captured_at): valid_from falls back to wall-clock ingest time', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    const beforeInsert = Date.now();
    insertSession(db, sessionId);
    // capturedAtMs omitted (defaults to null) — reproduces a legacy ingest,
    // which never wrote transcripts.captured_at.
    insertCanonicalTranscript(db, transcriptId, sessionId, [
      { role: 'user', text: 'what vector store should we use for v1?' },
      { role: 'assistant', text: 'sqlite-vec — no network dependency, single-process.' },
    ]);

    await distillHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);
    const afterInsert = Date.now();

    const memories = db.prepare('SELECT id, valid_from FROM memories').all() as { id: string; valid_from: number }[];
    expect(memories.length).toBeGreaterThanOrEqual(1);
    for (const m of memories) {
      expect(m.valid_from).toBeGreaterThanOrEqual(beforeInsert);
      expect(m.valid_from).toBeLessThanOrEqual(afterInsert);
    }
  });

  // FEAT-455 / ADR-012 decision 4: proves the full plumb — transcripts.
  // capture_source -> distillHandler -> PipelineContext.captureSource ->
  // embedAndIndex -> memories.capture_source — mirrors the captured_at
  // plumbing test above.
  it('FEAT-455: transcripts.capture_source threads into memories.capture_source', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(db, sessionId);
    insertCanonicalTranscript(db, transcriptId, sessionId, [
      { role: 'user', text: 'what vector store should we use for v1?' },
      { role: 'assistant', text: 'sqlite-vec — no network dependency, single-process.' },
    ], null, 'auto_capture');

    await distillHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const memories = db.prepare('SELECT id, capture_source FROM memories').all() as
      { id: string; capture_source: string | null }[];
    expect(memories.length).toBeGreaterThanOrEqual(1);
    for (const m of memories) {
      expect(m.capture_source).toBe('auto_capture');
    }
  });

  it('every other producer (transcripts.capture_source NULL): memories.capture_source stays NULL', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(db, sessionId);
    insertCanonicalTranscript(db, transcriptId, sessionId, [
      { role: 'user', text: 'what vector store should we use for v1?' },
      { role: 'assistant', text: 'sqlite-vec — no network dependency, single-process.' },
    ]);

    await distillHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const memories = db.prepare('SELECT id, capture_source FROM memories').all() as
      { id: string; capture_source: string | null }[];
    expect(memories.length).toBeGreaterThanOrEqual(1);
    for (const m of memories) {
      expect(m.capture_source).toBeNull();
    }
  });
});
