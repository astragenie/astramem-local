/**
 * FEAT-506 — meeting_captions ingest should default extract_profile='conversational'.
 *
 * Route-layer default (src/server/routes/ingest.ts, `ingestCanonicalTranscript`
 * — the exact function both `POST /ingest/transcript` and the spool-drain
 * worker call, per this file's sibling tests/feat-491/meeting-captions-round-
 * trip.test.ts): a meeting-captions envelope that omits the optional
 * `extract_profile` envelope field previously left `transcripts.extract_
 * profile` NULL, which `runPipeline` resolves to the 'engineering' default
 * (pipeline.ts:184). 'engineering' runs stage-4 LLM compaction BEFORE
 * extraction, and 04-compact.ts's own doc comment (plus FEAT-505's live
 * debugging) confirms compaction on conversational content destroys facts
 * including speaker names — degrading attribution regardless of the
 * (now-fixed) matching algorithm. FEAT-505's own live test only passed
 * because it explicitly set extract_profile.
 *
 * Exercises the real ingest route function per FEAT-506 AC-1 ("test through
 * the real ingest route, not the pipeline directly"), not a hand-rolled
 * resolution helper.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { CanonicalIngestSchema, ingestCanonicalTranscript } from '../../src/server/routes/ingest.js';
import { defaultConfig } from '../../src/config/config.js';
import type { DB } from '../../src/storage/db.js';

function buildEnvelope(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    event: 'session_end' as const,
    session_id: sessionId,
    project_id: 'proj-astramem',
    captured_at: '2026-07-15T10:00:00.000Z',
    kind: 'transcript' as const,
    turns: [
      { role: 'user' as const, text: 'hello' },
      { role: 'assistant' as const, text: 'hi there' },
    ],
    client_scrub_applied: true,
    client_scrub_hits: 0,
    client_version: '0.19.0',
    client_scrub_version: '1.2.0',
    wire_version: 'v1.0',
    ...overrides,
  };
}

function readExtractProfile(db: DB, transcriptId: string): string | null {
  const row = db
    .prepare('SELECT extract_profile FROM transcripts WHERE id = ?')
    .get(transcriptId) as { extract_profile: string | null };
  return row.extract_profile;
}

describe('FEAT-506 conversational profile default for meeting captions', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('capture_source=meeting_captions + extract_profile absent -> resolves to conversational', () => {
    const sessionId = randomUUID();
    const envelope = buildEnvelope(sessionId, {
      capture_source: 'meeting_captions',
      consent_disclosed: true,
    });
    const parsed = CanonicalIngestSchema.parse(envelope);
    const config = defaultConfig();
    config.captureSource.meetingCaptions.enabled = true; // operator opt-in, same as tests/feat-491

    const { transcriptId } = ingestCanonicalTranscript(db, config, parsed, null);
    expect(readExtractProfile(db, transcriptId)).toBe('conversational');
  });

  it('capture_source=meeting_captions + extract_profile explicitly set -> explicit value wins (override preserved)', () => {
    const sessionId = randomUUID();
    const envelope = buildEnvelope(sessionId, {
      capture_source: 'meeting_captions',
      consent_disclosed: true,
      extract_profile: 'engineering',
    });
    const parsed = CanonicalIngestSchema.parse(envelope);
    const config = defaultConfig();
    config.captureSource.meetingCaptions.enabled = true;

    const { transcriptId } = ingestCanonicalTranscript(db, config, parsed, null);
    expect(readExtractProfile(db, transcriptId)).toBe('engineering');
  });

  it('non-meeting-captions source + extract_profile absent -> stays NULL (unaffected)', () => {
    const sessionId = randomUUID();
    const envelope = buildEnvelope(sessionId, { capture_source: 'hook_close' });
    const parsed = CanonicalIngestSchema.parse(envelope);
    const config = defaultConfig();

    const { transcriptId } = ingestCanonicalTranscript(db, config, parsed, null);
    expect(readExtractProfile(db, transcriptId)).toBeNull();
  });

  it('capture_source entirely absent + extract_profile absent -> stays NULL (byte-identical to pre-FEAT-506)', () => {
    const sessionId = randomUUID();
    const envelope = buildEnvelope(sessionId);
    const parsed = CanonicalIngestSchema.parse(envelope);
    const config = defaultConfig();

    const { transcriptId } = ingestCanonicalTranscript(db, config, parsed, null);
    expect(readExtractProfile(db, transcriptId)).toBeNull();
  });
});
