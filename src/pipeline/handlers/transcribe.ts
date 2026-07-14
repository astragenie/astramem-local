/**
 * Transcribe handler (FEAT-489 Slice A) — audio file -> on-device ASR ->
 * FEAT-490 confidence filter -> transcripts row -> existing `distill` job,
 * unchanged (this repo's own "feeds the existing 8-stage distill" design —
 * distillHandler/the pipeline itself are not touched by this FEAT at all).
 *
 * Registered in src/cli/serve.ts's HandlerRegistry alongside distill/
 * consolidate/reembed/cleanup. Enqueued by `astramem-local ingest-audio`
 * (src/cli/audio.ts), which upserts the session row the same way the
 * canonical ingest route does — this handler assumes `payload.session_id`
 * already resolves to a real `sessions` row (mirrors distillHandler's own
 * assumption about `transcript_id`).
 *
 * ADR-017 gate: `config.audio.mode` is re-checked HERE, not just at
 * enqueue time — a stray job left over from a config change (mode flipped
 * back to 'off' between enqueue and drain) must not silently process third-
 * party audio the operator no longer consents to capturing. Throwing
 * (rather than silently no-op'ing/completing) surfaces the stale job as a
 * visible failure in `queue`/doctor rather than a silent skip (ADR-015: no
 * silent success-shaped failure).
 *
 * ADR-017 decision 3 disclosure enforcement (v1 surface — see
 * Config['audio']'s doc comment): also refuses whenever
 * `audio.disclosureAcknowledged !== true`, embedding the full canonical
 * disclosure copy in the thrown error. Checked before the add-on probe so
 * the consent gate is unconditional, never merely one more precondition an
 * operator could satisfy without ever reading the disclosure.
 *
 * Add-on absence/version-mismatch (packaging design pass decisions 1-2):
 * throws a specific, actionable Error — caught by the worker's normal
 * handler-failure path (JobRepo.fail -> retry/poison), same as every other
 * handler's thrown errors. NEVER a crash: this file has no code path that
 * can bring down the daemon process on a missing/incompatible add-on.
 */
import { z } from 'zod';
import { ts } from '../../log/logger.js';
import type { JobHandler } from '../handler.js';
import { JobRepo } from '../job-repo.js';
import { probeAudioAddon, describeProbeFailure } from '../../audio/addon-probe.js';
import { AUDIO_ADDON_API_VERSION } from '../../audio/addon-contract.js';
import { filterLowConfidenceSegments } from '../../audio/confidence-filter.js';
import { recordTranscriptionGuardDrops } from '../../storage/transcription-guard-log.js';
import { redactIfEnabled } from '../../redact/index.js';
import { THIRD_PARTY_SPEAKER_CONSENT_DISCLOSURE } from '../../config/config.js';
import { randomUUID } from 'node:crypto';

const TranscribePayloadFlexSchema = z.object({
  audio_path: z.string().min(1),
  session_id: z.string().min(1),
  kind: z.string().optional(),
});

/** Local calendar YYYY-MM-DD for `transcripts.captured_at_local_date`
 *  (2026-07-13 timezone bugfix precedent — see that migration's comment). */
function localDatePrefix(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export const transcribeHandler: JobHandler = {
  kind: 'transcribe',

  async handle(payload: unknown, ctx): Promise<void> {
    const parsed = TranscribePayloadFlexSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid transcribe payload: ${parsed.error.message}`);
    }
    const { audio_path: audioPath, session_id: sessionId } = parsed.data;

    const mode = ctx.config.audio.mode;
    if (mode === 'off') {
      throw new Error(
        'transcribe job dequeued while audio.mode is \'off\' — refusing to process a stale/stray job rather ' +
        'than silently transcribing audio the operator no longer consents to capturing (ADR-017). If audio ' +
        'capture is genuinely wanted, set audio.mode to \'dry-run\' or \'enabled\' in config.yaml and re-enqueue.',
      );
    }

    // ADR-017 decision 3 enforcement gate (v1 disclosure surface — see
    // Config['audio']'s doc comment for why this replaces an init-wizard
    // prompt in this slice). Checked BEFORE the add-on probe: an operator
    // who hasn't acknowledged the disclosure must never learn "add-on
    // missing" first and "you need to acknowledge consent" second — the
    // consent gate is unconditional, not merely one more precondition.
    if (!ctx.config.audio.disclosureAcknowledged) {
      throw new Error(
        `audio.mode is '${mode}' but audio.disclosureAcknowledged is not true — refusing to transcribe. ` +
        `${THIRD_PARTY_SPEAKER_CONSENT_DISCLOSURE} Set audio.disclosureAcknowledged: true in config.yaml ` +
        'after reading and understanding this, then re-enqueue.',
      );
    }

    const probe = await probeAudioAddon();
    if (probe.status !== 'ok') {
      throw new Error(
        `astramem-audio add-on not installed; audio.mode is '${mode}' but the package is absent or incompatible: ` +
        describeProbeFailure(probe, AUDIO_ADDON_API_VERSION),
      );
    }

    const rawSegments = await probe.module.transcribe(audioPath, { modelPath: ctx.config.audio.modelPath });
    const { kept, dropped } = filterLowConfidenceSegments(rawSegments);

    console.log(
      `${ts()} [transcribe] ${audioPath} -> ${rawSegments.length} raw segment(s), ${kept.length} kept, ` +
      `${rawSegments.length - kept.length} dropped (${dropped.map(d => `${d.reason}=${d.count}`).join(', ') || 'none'})`,
    );
    if (dropped.length > 0) {
      recordTranscriptionGuardDrops(ctx.db, dropped, sessionId);
    }

    if (kept.length === 0) {
      // FEAT-490 acceptance hint: a silence-only/music-only source is not a
      // failure — nothing durable to distill, and nothing is persisted.
      console.log(`${ts()} [transcribe] ${audioPath} — every segment dropped by the confidence filter, nothing to distill`);
      return;
    }

    if (mode === 'dry-run') {
      // Mirrors contradictionDetection's dry-run semantics: produce the
      // transcript/preview, do not persist. No transcripts row, no distill
      // job — the preview IS the kept-segment text, logged for inspection.
      console.log(`${ts()} [transcribe] ${audioPath} — dry-run, would persist ${kept.length} segment(s), nothing written`);
      return;
    }

    const { text: redactedText } = redactIfEnabled(kept.map(s => s.text).join('\n'), ctx.config);

    const transcriptId = randomUUID();
    const now = Date.now();
    ctx.db.prepare(`
      INSERT INTO transcripts (
        id, session_id, source, content, ingested_at,
        captured_at, capture_source, consent_disclosed,
        extract_profile, captured_at_local_date
      ) VALUES (?, ?, 'audio_transcribe', ?, ?, ?, 'audio_transcribe', 1, ?, ?)
    `).run(
      transcriptId, sessionId, redactedText, now,
      now, ctx.config.distill.extractProfile, localDatePrefix(now),
    );

    new JobRepo(ctx.db).enqueue('distill', { kind: 'distill', transcript_id: transcriptId, session_id: sessionId });
    console.log(`${ts()} [transcribe] ${audioPath} -> transcript ${transcriptId}, distill job enqueued`);
  },
};
