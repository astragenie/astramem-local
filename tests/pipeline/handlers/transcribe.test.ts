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
import type { DB } from '../../../src/storage/db.js';
import type { HandlerCtx } from '../../../src/pipeline/handler.js';
import { AUDIO_ADDON_API_VERSION, type AudioSegment } from '../../../src/audio/addon-contract.js';

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
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'enabled' } } };
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
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'enabled' } } };
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
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'dry-run' } } };
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
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'enabled' } } };
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

  it('version mismatch: throws a distinct actionable error', async () => {
    probeAudioAddonMock.mockResolvedValue({ status: 'version-mismatch', installedVersion: 999 });
    ctx = { db, config: { ...defaultConfig(), audio: { mode: 'enabled' } } };
    const sessionId = randomUUID();
    insertSession(db, sessionId);

    await expect(
      transcribeHandler.handle({ audio_path: '/tmp/x.wav', session_id: sessionId }, ctx),
    ).rejects.toThrow(/unsupported/);
  });
});
