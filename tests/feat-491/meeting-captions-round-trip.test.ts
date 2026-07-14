/**
 * FEAT-491 (ADR-017) round-trip conformance test.
 *
 * Repo-wide dominant bug class (see CLAUDE.md "zod as filter silently drops
 * data"): a new wire field that zod's default STRIP mode silently deletes at
 * parse, or that gets dropped somewhere between the ingest schema and the
 * stored atom. This test exercises a REALISTIC multi-speaker meeting-caption
 * payload through the actual production path — CanonicalIngestSchema.parse
 * -> ingestCanonicalTranscript (the exact function POST /ingest/transcript
 * calls) -> distillHandler.handle (the exact function the job worker calls)
 * -> the stored `memories` row — and asserts every FEAT-491 field survives.
 * A silent strip anywhere in that chain fails this test, not just a schema
 * unit test in isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import {
  CanonicalIngestSchema,
  ingestCanonicalTranscript,
  MeetingCaptionsDisabledError,
} from '../../src/server/routes/ingest.js';
import { distillHandler } from '../../src/pipeline/handlers/distill.js';
import { defaultConfig } from '../../src/config/config.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import type { ExtendedHandlerCtx } from '../../src/pipeline/handler-ctx-ext.js';
import type { DB } from '../../src/storage/db.js';
import type { LLMProvider, EmbedProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth, EmbedHealth } from '../../src/contracts/index.js';

// The exact utterance the mock extractor will select as evidence for its one
// atom — must appear verbatim in ONE speaker's turn only, so a correct
// attribution is unambiguous (a wrong/stripped speaker_label would either be
// null or the WRONG speaker, both of which the assertions below catch).
const BOB_UTTERANCE = "one thing though, we still need the doctor WARN row before this ships.";

function makeMockLLM(): LLMProvider {
  return {
    name: 'ollama' as const,
    model: 'test-model',
    async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
      const userContent = messages.find(m => m.role === 'user')?.content ?? '';
      const systemContent = messages.find(m => m.role === 'system')?.content ?? '';
      const isExtraction = opts?.json === true || systemContent.includes('atoms');
      if (isExtraction) {
        const mentions = userContent.includes('doctor WARN row');
        const atoms = mentions
          ? [{
              type: 'todo',
              text: 'ship the doctor WARN row before cutting caption capture over to the new consent gate',
              importance: 0.8,
              confidence: 0.9,
              evidence: BOB_UTTERANCE,
            }]
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

/** A realistic 3-speaker meeting-captions envelope, mirroring
 *  contracts/fixtures/valid/capture-envelope-v1-meeting-captions.json. */
function buildMeetingCaptionsEnvelope(sessionId: string) {
  return {
    event: 'session_end' as const,
    session_id: sessionId,
    project_id: 'proj-astramem',
    captured_at: '2026-07-14T15:03:00.000Z',
    kind: 'transcript' as const,
    capture_source: 'meeting_captions' as const,
    platform: 'google_meet',
    meeting_id: 'abc-defg-hij',
    consent_disclosed: true,
    turns: [
      { role: 'user' as const, text: 'should we cut the caption capture over to the new consent gate today?', speaker: 'Alice Chen' },
      { role: 'assistant' as const, text: 'yeah, I think so — ADR-017 landed and the disclosure copy is ready.', speaker: 'Bob Okafor' },
      { role: 'assistant' as const, text: BOB_UTTERANCE, speaker: 'Priya Nair' },
    ],
    client_scrub_applied: true,
    client_scrub_hits: 0,
    client_version: '0.19.0',
    client_scrub_version: '1.2.0',
    wire_version: 'v1.0',
  };
}

describe('FEAT-491 meeting-captions round trip', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('CanonicalIngestSchema does not silently strip any FEAT-491 field', () => {
    const envelope = buildMeetingCaptionsEnvelope(randomUUID());
    const parsed = CanonicalIngestSchema.parse(envelope);

    expect(parsed.capture_source).toBe('meeting_captions');
    expect(parsed.platform).toBe('google_meet');
    expect(parsed.meeting_id).toBe('abc-defg-hij');
    expect(parsed.consent_disclosed).toBe(true);
    expect(parsed.turns?.[1]?.speaker).toBe('Bob Okafor');
    expect(parsed.turns?.[2]?.speaker).toBe('Priya Nair');
  });

  it('rejects a meeting_captions envelope missing consent_disclosed (ADR-017 hard reject)', () => {
    const envelope = buildMeetingCaptionsEnvelope(randomUUID());
    const { consent_disclosed: _drop, ...withoutConsent } = envelope;
    const result = CanonicalIngestSchema.safeParse(withoutConsent);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map(i => i.path.join('.'));
      expect(paths).toContain('consent_disclosed');
    }
  });

  it('ingestCanonicalTranscript refuses meeting_captions when captureSource.meetingCaptions.enabled is off (default)', () => {
    const sessionId = randomUUID();
    const envelope = buildMeetingCaptionsEnvelope(sessionId);
    const parsed = CanonicalIngestSchema.parse(envelope);
    const config = defaultConfig(); // meetingCaptions.enabled: false by default

    expect(() => ingestCanonicalTranscript(db, config, parsed, null)).toThrow(MeetingCaptionsDisabledError);
  });

  it('ingest -> distill -> stored atom: platform/meeting_id/consent_disclosed/speaker_label all survive, none silently stripped', async () => {
    const sessionId = randomUUID();
    const envelope = buildMeetingCaptionsEnvelope(sessionId);
    const parsed = CanonicalIngestSchema.parse(envelope);

    const config = defaultConfig();
    config.captureSource.meetingCaptions.enabled = true; // explicit operator opt-in

    const { transcriptId, jobId } = ingestCanonicalTranscript(db, config, parsed, null);
    expect(transcriptId).toBeTruthy();
    expect(jobId).toBeTruthy();

    // Transcript-row survival — the capture-session metadata a strip bug
    // would delete before distill ever runs.
    const transcriptRow = db
      .prepare('SELECT platform, meeting_id, consent_disclosed FROM transcripts WHERE id = ?')
      .get(transcriptId) as { platform: string | null; meeting_id: string | null; consent_disclosed: number | null };
    expect(transcriptRow.platform).toBe('google_meet');
    expect(transcriptRow.meeting_id).toBe('abc-defg-hij');
    expect(transcriptRow.consent_disclosed).toBe(1);

    const ctx: ExtendedHandlerCtx = {
      db,
      config,
      providers: { llm: { compaction: makeMockLLM(), extraction: makeMockLLM() }, embed: makeMockEmbed() },
      memoryRepo: new MemoryRepo(db),
      vecStore: new SqliteVecStore(db),
    };

    await distillHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

    const memories = db
      .prepare('SELECT id, text, capture_source, consent_disclosed, speaker_label FROM memories')
      .all() as Array<{ id: string; text: string; capture_source: string | null; consent_disclosed: number | null; speaker_label: string | null }>;

    expect(memories.length).toBeGreaterThanOrEqual(1);
    const atom = memories[0]!;

    // capture_source and consent_disclosed flow straight through from the
    // transcript to every atom it produces (ADR-017 "stamped on atoms from
    // this source").
    expect(atom.capture_source).toBe('meeting_captions');
    expect(atom.consent_disclosed).toBe(1);

    // The load-bearing assertion: speaker_label must be the CORRECT
    // speaker (Priya Nair, whose turn's text was selected as evidence) —
    // not null (would mean the speaker marker never reached the flattened
    // text, or attribution silently failed) and not Alice/Bob (would mean
    // attribution matched the wrong line).
    expect(atom.speaker_label).toBe('Priya Nair');
  });
});
