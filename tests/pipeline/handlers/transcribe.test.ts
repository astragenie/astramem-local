/**
 * tests/pipeline/handlers/transcribe.test.ts — FEAT-489 Slice A / FEAT-490.
 *
 * `probeAudioAddon` is mocked (not the real dynamic import target — this
 * repo has no real `astramem-audio` package to install for a unit test)
 * so the "add-on present" path is exercisable; the "add-on genuinely
 * absent" test deliberately does NOT mock it, exercising the real default
 * importer against a package that truly isn't installed in this repo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../../src/storage/db.js';
import { migrate } from '../../../src/storage/migrate.js';
import { defaultConfig } from '../../../src/config/config.js';
import { MemoryRepo } from '../../../src/storage/memories.js';
import { SqliteVecStore } from '../../../src/vector/sqlite-vec.js';
import { distillHandler } from '../../../src/pipeline/handlers/distill.js';
import type { DB } from '../../../src/storage/db.js';
import type { HandlerCtx } from '../../../src/pipeline/handler.js';
import type { ExtendedHandlerCtx } from '../../../src/pipeline/handler-ctx-ext.js';
import type { LLMProvider, EmbedProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth, EmbedHealth } from '../../../src/contracts/index.js';
import { AUDIO_ADDON_API_VERSION, type AudioSegment } from '../../../src/audio/addon-contract.js';

// Same "only extract when the flattened transcript mentions 'sqlite-vec'"
// mock shape tests/pipeline/handlers/distill.test.ts uses — reused here
// (not imported from that test file) so this file stays a self-contained
// unit for the transcribe -> distill -> memory chain.
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

const probeAudioAddonMock = vi.fn();
let actualProbeAudioAddon: typeof import('../../../src/audio/addon-probe.js').probeAudioAddon;
vi.mock('../../../src/audio/addon-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/audio/addon-probe.js')>();
  actualProbeAudioAddon = actual.probeAudioAddon;
  return { ...actual, probeAudioAddon: (...args: unknown[]) => probeAudioAddonMock(...args) };
});

// Imported AFTER the mock is registered (vi.mock is hoisted by vitest anyway).
const { transcribeHandler } = await import('../../../src/pipeline/handlers/transcribe.js');

function insertSession(db: DB, id: string): void {
  db.prepare(`
    INSERT INTO sessions (id, repo, project, branch, agent, started_at)
    VALUES (?, NULL, NULL, NULL, NULL, ?)
  `).run(id, Date.now());
}

function seg(overrides: Partial<AudioSegment>): AudioSegment {
  return {
    text: 'hello world',
    startMs: 0,
    endMs: 1000,
    noSpeechProb: 0.05,
    avgLogprob: -0.2,
    compressionRatio: 1.1,
    ...overrides,
  };
}

describe('transcribeHandler', () => {
  let db: DB;
  let ctx: HandlerCtx;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    probeAudioAddonMock.mockReset();
  });

  it('mode off: throws an actionable error rather than silently processing (ADR-017)', async () => {
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'off' } } };
    const sessionId = randomUUID();
    insertSession(db, sessionId);

    await expect(
      transcribeHandler.handle({ audio_path: '/tmp/x.wav', session_id: sessionId }, ctx),
    ).rejects.toThrow(/audio\.mode is 'off'/);
    expect(probeAudioAddonMock).not.toHaveBeenCalled();
  });

  it('mode enabled, add-on genuinely absent (real probe, no astramem-audio package installed): throws an actionable error, never crashes', async () => {
    // Delegates to the REAL probeAudioAddon (captured from the mock factory's
    // importOriginal) with its default importer — genuinely attempts
    // `import('astramem-audio')` against this repo's real node_modules,
    // where the package truly isn't installed. Exercises the real
    // absent-branch, not a simulated one.
    probeAudioAddonMock.mockImplementation(() => actualProbeAudioAddon());
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'enabled', disclosureAcknowledged: true } } };
    const sessionId = randomUUID();
    insertSession(db, sessionId);

    await expect(
      transcribeHandler.handle({ audio_path: '/tmp/x.wav', session_id: sessionId }, ctx),
    ).rejects.toThrow(/add-on not installed/);

    const jobs = db.prepare("SELECT * FROM jobs WHERE kind = 'distill'").all();
    expect(jobs).toHaveLength(0);
  });

  it('mode enabled, add-on present: transcribes, filters, inserts a transcript row, enqueues distill', async () => {
    probeAudioAddonMock.mockResolvedValue({
      status: 'ok',
      module: {
        ASTRAMEM_AUDIO_ADDON_API_VERSION: AUDIO_ADDON_API_VERSION,
        transcribe: async () => [seg({ text: 'this is a real segment' })],
      },
    });
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'enabled', disclosureAcknowledged: true } } };
    const sessionId = randomUUID();
    insertSession(db, sessionId);

    await transcribeHandler.handle({ audio_path: '/tmp/meeting.wav', session_id: sessionId }, ctx);

    const transcripts = db.prepare("SELECT * FROM transcripts WHERE source = 'audio_transcribe'").all() as any[];
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].capture_source).toBe('audio_transcribe');
    expect(transcripts[0].consent_disclosed).toBe(1);
    expect(transcripts[0].content).toContain('this is a real segment');

    const distillJobs = db.prepare("SELECT * FROM jobs WHERE kind = 'distill'").all() as any[];
    expect(distillJobs).toHaveLength(1);
    const payload = JSON.parse(distillJobs[0].payload_json);
    expect(payload.transcript_id).toBe(transcripts[0].id);
  });

  it('mode dry-run, add-on present: transcribes but persists nothing (no transcript row, no distill job)', async () => {
    probeAudioAddonMock.mockResolvedValue({
      status: 'ok',
      module: {
        ASTRAMEM_AUDIO_ADDON_API_VERSION: AUDIO_ADDON_API_VERSION,
        transcribe: async () => [seg({ text: 'preview only' })],
      },
    });
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'dry-run', disclosureAcknowledged: true } } };
    const sessionId = randomUUID();
    insertSession(db, sessionId);

    await transcribeHandler.handle({ audio_path: '/tmp/meeting.wav', session_id: sessionId }, ctx);

    expect(db.prepare('SELECT * FROM transcripts').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM jobs').all()).toHaveLength(0);
  });

  it('FEAT-490: all segments filtered out (silence-only) -> no transcript, no distill job, not an error', async () => {
    probeAudioAddonMock.mockResolvedValue({
      status: 'ok',
      module: {
        ASTRAMEM_AUDIO_ADDON_API_VERSION: AUDIO_ADDON_API_VERSION,
        transcribe: async () => [
          seg({ text: 'you', noSpeechProb: 0.95, avgLogprob: -2.0 }),
          seg({ text: 'you', noSpeechProb: 0.95, avgLogprob: -2.0 }),
        ],
      },
    });
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'enabled', disclosureAcknowledged: true } } };
    const sessionId = randomUUID();
    insertSession(db, sessionId);

    await expect(
      transcribeHandler.handle({ audio_path: '/tmp/silence.wav', session_id: sessionId }, ctx),
    ).resolves.toBeUndefined();

    expect(db.prepare('SELECT * FROM transcripts').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM jobs').all()).toHaveLength(0);
    const drops = db.prepare('SELECT * FROM transcription_guard_drops').all() as any[];
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('silence_hallucination');
    expect(drops[0].count).toBe(2);
  });

  it('ADR-017 decision 6: consent_disclosed threads all the way onto the stored MEMORY row, not just the transcript', async () => {
    probeAudioAddonMock.mockResolvedValue({
      status: 'ok',
      module: {
        ASTRAMEM_AUDIO_ADDON_API_VERSION: AUDIO_ADDON_API_VERSION,
        transcribe: async () => [seg({ text: 'we decided to use sqlite-vec for v1 vector storage' })],
      },
    });
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'enabled', disclosureAcknowledged: true } } };
    const sessionId = randomUUID();
    insertSession(db, sessionId);

    await transcribeHandler.handle({ audio_path: '/tmp/meeting.wav', session_id: sessionId }, ctx);

    const transcript = db.prepare("SELECT * FROM transcripts WHERE source = 'audio_transcribe'").get() as any;
    expect(transcript.consent_disclosed).toBe(1);

    // Run the SAME 'distill' job the handler enqueued, through the real
    // distillHandler (mock LLM/embed providers) — this is the actual code
    // path an audio-sourced transcript takes to become a memory.
    const distillCtx: ExtendedHandlerCtx = {
      db,
      config: ctx.config,
      providers: { llm: { compaction: makeMockLLM(), extraction: makeMockLLM() }, embed: makeMockEmbed() },
      memoryRepo: new MemoryRepo(db),
      vecStore: new SqliteVecStore(db),
    };
    await distillHandler.handle({ transcript_id: transcript.id, session_id: sessionId }, distillCtx);

    const memories = db.prepare("SELECT id, capture_source, consent_disclosed FROM memories").all() as any[];
    expect(memories.length).toBeGreaterThanOrEqual(1);
    for (const m of memories) {
      expect(m.capture_source).toBe('audio_transcribe');
      // Stored as SQLite INTEGER 1, not JS `true` — MemoryRepo.get() would
      // hydrate it to boolean, but this is a raw row read (matching the
      // reviewer's ask: assert the STORED value, not a hydrated one).
      expect(m.consent_disclosed).toBe(1);
    }
  });

  it('version mismatch: throws a distinct actionable error', async () => {
    probeAudioAddonMock.mockResolvedValue({ status: 'version-mismatch', installedVersion: 999 });
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'enabled', disclosureAcknowledged: true } } };
    const sessionId = randomUUID();
    insertSession(db, sessionId);

    await expect(
      transcribeHandler.handle({ audio_path: '/tmp/x.wav', session_id: sessionId }, ctx),
    ).rejects.toThrow(/unsupported/);
  });

  it('ADR-017 decision 3: mode enabled, disclosureAcknowledged false (the default) — refuses with the full disclosure copy, never probes the add-on', async () => {
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'enabled', disclosureAcknowledged: false } } };
    const sessionId = randomUUID();
    insertSession(db, sessionId);

    let caught: Error | undefined;
    try {
      await transcribeHandler.handle({ audio_path: '/tmp/x.wav', session_id: sessionId }, ctx);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.message).toContain('audio.disclosureAcknowledged');
    // The full canonical disclosure copy must be embedded, not just referenced.
    expect(caught?.message).toContain('This will capture what other people say in your meetings/calls');
    expect(caught?.message).toContain('you are responsible for informing other participants');
    // The gate is unconditional — checked before the add-on probe fires at all.
    expect(probeAudioAddonMock).not.toHaveBeenCalled();
  });

  it('ADR-017 decision 3: mode dry-run, disclosureAcknowledged omitted (undefined, same as false) — same refusal', async () => {
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'dry-run' } } };
    const sessionId = randomUUID();
    insertSession(db, sessionId);

    await expect(
      transcribeHandler.handle({ audio_path: '/tmp/x.wav', session_id: sessionId }, ctx),
    ).rejects.toThrow(/disclosureAcknowledged/);
  });

  it('disclosureAcknowledged true: the gate no longer blocks (proceeds to the add-on probe)', async () => {
    probeAudioAddonMock.mockImplementation(() => actualProbeAudioAddon());
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'enabled', disclosureAcknowledged: true } } };
    const sessionId = randomUUID();
    insertSession(db, sessionId);

    // Passes the disclosure gate and reaches the (genuinely absent) add-on
    // probe — a DIFFERENT error than the disclosure refusal proves the gate
    // was cleared, not merely bypassed by an unrelated failure.
    await expect(
      transcribeHandler.handle({ audio_path: '/tmp/x.wav', session_id: sessionId }, ctx),
    ).rejects.toThrow(/add-on not installed/);
    expect(probeAudioAddonMock).toHaveBeenCalled();
  });
});
