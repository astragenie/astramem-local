import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../../src/storage/db.js';
import { migrate } from '../../../src/storage/migrate.js';
import { distillHandler } from '../../../src/pipeline/handlers/distill.js';
import { defaultConfig } from '../../../src/config/config.js';
import { MemoryRepo } from '../../../src/storage/memories.js';
import { SqliteVecStore } from '../../../src/vector/sqlite-vec.js';
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

/** Inserts a transcript row shaped exactly as the canonical ingest path writes it (JSON.stringify(turns)). */
function insertCanonicalTranscript(db: DB, id: string, sessionId: string, turns: Array<{ role: string; text: string }>): void {
  db.prepare(`
    INSERT INTO transcripts (id, session_id, source, content, ingested_at)
    VALUES (?, ?, 'claude-code-pre_compact', ?, ?)
  `).run(id, sessionId, JSON.stringify(turns), Date.now());
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
});
