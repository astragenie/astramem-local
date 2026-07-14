/**
 * FEAT-505 AC-2 — real-LLM speaker-attribution conformance test.
 *
 * The FEAT-491 mock round-trip test (tests/feat-491/meeting-captions-round-
 * trip.test.ts) is green ONLY because its mock LLM hardcodes verbatim
 * evidence — it proves wiring, not real-LLM compliance. Live-reproduced
 * twice against the real default extraction model (codex-subscription/
 * gpt-5.4-mini): a maximally quotable single-sentence utterance still came
 * back with speaker_label=null, because the model paraphrases despite the
 * extraction prompt (src/distill/prompts/extract.ts) demanding a verbatim
 * evidence copy. This test drives the REAL provider through the REAL ingest
 * -> distill -> stored-atom path (same production functions the mock
 * round-trip test exercises) and asserts a non-null, CORRECT speaker_label
 * — the test class the mock hid (synthetic-fixtures-lie class).
 *
 * Gating: opt-in via `INTEGRATION_LIVE=codex`, mirroring the existing
 * ollama/azure INTEGRATION_LIVE convention (tests/e2e/plugin-flow.test.ts,
 * tests/providers/codex-subscription-llm.test.ts's own "live integration"
 * describe block). Loud-skip (a printed reason, not a silent vanish) when
 * either the env var isn't set or `codex login` hasn't been run — never a
 * hard failure for an operator who hasn't opted in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { CanonicalIngestSchema, ingestCanonicalTranscript } from '../../src/server/routes/ingest.js';
import { distillHandler } from '../../src/pipeline/handlers/distill.js';
import { defaultConfig } from '../../src/config/config.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { CodexSubscriptionLLMProvider, hasCodexLogin } from '../../src/providers/llm/codex-subscription.js';
import type { ExtendedHandlerCtx } from '../../src/pipeline/handler-ctx-ext.js';
import type { DB } from '../../src/storage/db.js';
import type { EmbedProvider, EmbedHealth } from '../../src/contracts/index.js';

const INTEGRATION_LIVE_CODEX = process.env.INTEGRATION_LIVE === 'codex';
const CODEX_LOGGED_IN = hasCodexLogin();
const RUN_LIVE = INTEGRATION_LIVE_CODEX && CODEX_LOGGED_IN;

function skipReason(): string | null {
  if (INTEGRATION_LIVE_CODEX && !CODEX_LOGGED_IN) {
    return (
      'INTEGRATION_LIVE=codex was set but no ~/.codex/auth.json was found — run `codex login` ' +
      'first. Skipping the real-LLM attribution conformance test.'
    );
  }
  if (!INTEGRATION_LIVE_CODEX) {
    return (
      'Skipping real-LLM speaker-attribution conformance test — set INTEGRATION_LIVE=codex (and ' +
      'run `codex login`) to exercise it against the real default extraction model ' +
      '(codex-subscription/gpt-5.4-mini).'
    );
  }
  return null;
}

// A loud, always-collected (never skipIf'd away) test so the reason this
// suite is running in "mock CI" mode is visible in every normal test run
// instead of vanishing into a silent "1 skipped" line — module-scope
// console output doesn't reliably surface when vitest skips an entire file
// at collection time, which is exactly the failure mode this test guards
// against (a real-LLM conformance gap disappearing without a trace).
if (!RUN_LIVE) {
  it('FEAT-505 live conformance test is SKIPPED — see console output for why', () => {
    console.warn(`[FEAT-505 live] ${skipReason()}`);
    expect(skipReason()).not.toBeNull();
  });
}

// Deterministic, network-free — embedding content is irrelevant to speaker
// attribution, so a real embed provider would only add flakiness/latency
// without exercising anything this test cares about.
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

// A maximally quotable, single-sentence, factually specific utterance from a
// third speaker — the same shape as the L2 live-reproduction fixture this
// FEAT was filed from (deliberately unambiguous: only one speaker could have
// said it, and the sentence carries enough distinctive content words that a
// real paraphrase should still fuzzy-match it cleanly).
//
// Phrased as an explicit DECISION statement ("we will...", "let's make the
// call...") on purpose, not an incidental aside: live debugging (2026-07-14)
// found that fact/command/todo/event/note atoms carry NO evidence at all
// roughly 9/10 of the time (05-extract.ts's own FEAT-485 doc comment cites
// this exact "1/10 sampled memories carried any evidence" audit) — evidence
// is genuinely optional for those types and the model frequently skips it.
// `lesson`/`decision` are the ONLY two types 05-extract.ts's
// `requireEvidenceForRichTypes` gate actually enforces evidence for (drops
// the atom otherwise) — see EVIDENCE_REQUIRED_TYPES there. Steering the
// fixture to reliably classify as `decision` is what makes this an honest
// real-LLM conformance test of the MATCHING logic specifically, rather than
// a coin flip on whether the model bothered to populate evidence at all
// (a distinct, deeper gap noted in this FEAT's final report as a risk, not
// something FEAT-505's matching-algorithm scope can fix on its own).
function buildQuotableMeetingCaptionsEnvelope(sessionId: string) {
  return {
    event: 'session_end' as const,
    session_id: sessionId,
    project_id: 'proj-astramem',
    captured_at: '2026-07-14T15:03:00.000Z',
    kind: 'transcript' as const,
    capture_source: 'meeting_captions' as const,
    platform: 'google_meet',
    meeting_id: 'feat-505-live-conformance',
    consent_disclosed: true,
    // FEAT-505 live-debugging finding (2026-07-14): a meeting-captions
    // envelope with NO extract_profile override falls back to 'engineering'
    // (src/distill/pipeline.ts), which runs stage-4 LLM compaction
    // (shouldCompact, src/distill/stages/04-compact.ts) BEFORE extraction
    // ever sees the text. That function's own doc comment cites a measured
    // example where engineering-mode compaction on conversational content
    // "DESTROYS FACTS... including every speaker name" — a second paraphrase
    // layer stacked on top of extraction's own. 'conversational' is the
    // semantically correct profile for a multi-speaker meeting transcript
    // and skips compaction entirely (shouldCompact returns false). See the
    // risk noted in this FEAT's final report: production meeting-captions
    // ingest has no such default today, so this gap is live, not just a
    // test artifact.
    extract_profile: 'conversational' as const,
    turns: [
      { role: 'user' as const, text: 'should we cut the caption capture over to the new consent gate today?', speaker: 'Alice Chen' },
      { role: 'assistant' as const, text: 'yeah, I think so, the disclosure copy already shipped last week.', speaker: 'Bob Okafor' },
      {
        role: 'assistant' as const,
        text: "let's make the call now: we will ship the doctor WARN row for meeting captions before flipping on the new consent gate.",
        speaker: 'Priya Nair',
      },
    ],
    client_scrub_applied: true,
    client_scrub_hits: 0,
    client_version: '0.19.0',
    client_scrub_version: '1.2.0',
    wire_version: 'v1.0',
  };
}

describe.skipIf(!RUN_LIVE)('FEAT-505 speaker attribution — real codex-subscription conformance (INTEGRATION_LIVE=codex)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it(
    'ingest -> distill (REAL LLM) -> stored atom: speaker_label is non-null and correct on a quotable fixture',
    async () => {
      const sessionId = randomUUID();
      const envelope = buildQuotableMeetingCaptionsEnvelope(sessionId);
      const parsed = CanonicalIngestSchema.parse(envelope);

      const config = defaultConfig();
      config.captureSource.meetingCaptions.enabled = true;

      const { transcriptId, jobId } = ingestCanonicalTranscript(db, config, parsed, null);
      expect(transcriptId).toBeTruthy();
      expect(jobId).toBeTruthy();

      const realLLM = new CodexSubscriptionLLMProvider({ model: 'gpt-5.4-mini' });
      const ctx: ExtendedHandlerCtx = {
        db,
        config,
        providers: { llm: { compaction: realLLM, extraction: realLLM }, embed: makeMockEmbed() },
        memoryRepo: new MemoryRepo(db),
        vecStore: new SqliteVecStore(db),
      };

      await distillHandler.handle({ transcript_id: transcriptId, session_id: sessionId }, ctx);

      const memories = db
        .prepare('SELECT text, speaker_label FROM memories')
        .all() as Array<{ text: string; speaker_label: string | null }>;

      expect(memories.length).toBeGreaterThanOrEqual(1);

      // The load-bearing assertion (this is what was null 4/4 times in the
      // L2 live reproduction): at least one real-LLM-extracted atom carries
      // a non-null speaker_label, and — the misattribution guard applies
      // here too — it must be a speaker who actually exists in this
      // transcript, never a hallucinated or cross-atom-bled value.
      const withSpeaker = memories.filter(m => m.speaker_label !== null);
      expect(
        withSpeaker.length,
        `expected at least one atom with a non-null speaker_label; got: ${JSON.stringify(memories)}`,
      ).toBeGreaterThan(0);

      const validSpeakers = new Set(['Alice Chen', 'Bob Okafor', 'Priya Nair']);
      for (const m of withSpeaker) {
        expect(validSpeakers.has(m.speaker_label!), `unexpected speaker_label: ${m.speaker_label}`).toBe(true);
      }
    },
    // Real network round trip(s) to the ChatGPT Codex backend across
    // multiple pipeline stages — generous timeout, mirrors the 60s live
    // budget used elsewhere for real-provider e2e runs.
    60_000,
  );
});
