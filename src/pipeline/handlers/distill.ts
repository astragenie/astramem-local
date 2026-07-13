/**
 * Distill handler — Wave 3 implementation.
 *
 * Validates the payload, fetches transcript from DB,
 * runs the 8-stage pipeline, and handles BudgetExceeded by
 * moving the job to paused (not failed).
 */

import { z } from 'zod';
import { ts } from '../../log/logger.js';
import type { JobHandler } from '../handler.js';
import { isExtendedCtx } from '../handler-ctx-ext.js';
import { runPipeline, BudgetExceeded } from '../../distill/pipeline.js';
import { flattenTranscriptContent } from '../../distill/flatten-turns.js';
import { backfillSummaryMemoryId } from '../../storage/ingest-idempotency.js';
import { deriveProject } from '../derive-project.js';
import { JobRepo } from '../job-repo.js';

/**
 * Flexible payload schema — ingest route writes {transcript_id, session_id}
 * without the `kind` discriminator. Accept both forms.
 */
const DistillPayloadFlexSchema = z.object({
  transcript_id: z.string().min(1),
  session_id: z.string().min(1),
  // kind is optional here — ingest route may or may not include it
  kind: z.string().optional(),
});

interface TranscriptRow {
  id: string;
  session_id: string;
  content: string;
  source: string;
  /** Canonical envelope's captured_at (epoch ms), NULL for legacy v0.0 ingests. */
  captured_at: number | null;
  /** FEAT-455 / ADR-012 decision 4, widened 2026-07-12: 'auto_capture' when
   *  this transcript came from the hook-tap auto-capture trigger,
   *  'hook_close' when it came from the ordinary close-capture hook, NULL
   *  for every other producer. Widened again FEAT-458 S3 (ADR-013): 'proxy'
   *  when it came from the LLM proxy relay's capture fork. */
  capture_source: 'auto_capture' | 'hook_close' | 'proxy' | null;
  /** FEAT-479 (D3 §3.2) AC-3: the optional per-ingest `extract_profile`
   *  envelope field, carried on the transcripts row at ingest time (see
   *  ingestCanonicalTranscript, src/server/routes/ingest.ts) — NULL for
   *  every envelope that omits it. */
  extract_profile: 'engineering' | 'conversational' | null;
}

interface SessionRow {
  id: string;
  repo: string | null;
  project: string | null;
  branch: string | null;
  agent: string | null;
  cwd: string | null;
}

export const distillHandler: JobHandler = {
  kind: 'distill',

  async handle(payload: unknown, ctx): Promise<void> {
    const parsed = DistillPayloadFlexSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid distill payload: ${parsed.error.message}`);
    }

    const { transcript_id, session_id } = parsed.data;

    // Fetch transcript content
    const transcript = ctx.db
      .prepare('SELECT id, session_id, content, source, captured_at, capture_source, extract_profile FROM transcripts WHERE id = ?')
      .get(transcript_id) as TranscriptRow | undefined;

    if (!transcript) {
      throw new Error(`Transcript not found: ${transcript_id}`);
    }

    // Fetch session metadata for memory context
    const session = ctx.db
      .prepare('SELECT id, repo, project, branch, agent, cwd FROM sessions WHERE id = ?')
      .get(session_id) as SessionRow | undefined;

    // D-DEF1: canonical transcripts store JSON.stringify(turns) in `content`
    // (structured [{role, text, ts}]). Flatten to "role: text" lines — the
    // format stages 1-3 (cleanup/normalize/chunk) actually parse — before it
    // enters the pipeline. Legacy plain-text content passes through as-is.
    const transcriptText = flattenTranscriptContent(transcript.content);

    // Derive source hash for idempotency
    const { createHash } = await import('node:crypto');
    const sourceHash = createHash('sha256')
      .update(transcript.content, 'utf8')
      .digest('hex');

    // Check if we have extended context with providers
    if (!isExtendedCtx(ctx)) {
      // Fallback: no providers available (e.g. in unit tests without providers)
      // Log and complete — no memories will be created
      console.warn(
        `${ts()} [distill] no providers in ctx — transcript ${transcript_id} logged but not distilled. ` +
          'Ensure ExtendedHandlerCtx is passed when providers are configured.',
      );
      return;
    }

    const pipelineCtx = {
      db: ctx.db,
      llmCompaction: ctx.providers.llm.compaction,
      llmExtraction: ctx.providers.llm.extraction,
      embed: ctx.providers.embed,
      capUsd: ctx.config.budget.daily_usd,
      sessionId: session_id,
      repo: session?.repo ?? null,
      project: session?.project ?? deriveProject(session?.cwd, session?.repo),
      branch: session?.branch ?? null,
      agent: session?.agent ?? null,
      sourceHash,
      // BUG FIX: as_of previously filtered on wall-clock ingest time only —
      // captured_at was stored on the transcripts row (ingest.ts) but never
      // read back here, so bitemporal valid_from always defaulted to "now".
      // NULL for legacy v0.0 envelopes, which have no captured_at and keep
      // the wall-clock default (see EmbedIndexContext.capturedAtMs).
      capturedAtMs: transcript.captured_at ?? null,
      // FEAT-455 / ADR-012 decision 4: carried on the transcripts row at
      // ingest time (see ingestCanonicalTranscript, src/server/routes/
      // ingest.ts) — NULL for every producer except the hook-tap
      // auto-capture trigger.
      captureSource: transcript.capture_source ?? null,
      // FEAT-479 (D3 §3.2) AC-3: carried on the transcripts row at ingest
      // time (see ingestCanonicalTranscript, src/server/routes/ingest.ts) —
      // NULL for every envelope that omits `extract_profile`. runPipeline
      // falls back to config.distill.extractProfile, then 'engineering'.
      extractProfile: transcript.extract_profile ?? null,
      // FEAT-441: durability gate mode + config threaded straight from the
      // running config — undefined durabilityGateMode falls back to 'off'
      // deep in embedAndIndex (AC-2 byte-identical default).
      durabilityGateMode: ctx.config.distill.durabilityGate,
      config: ctx.config,
    };

    try {
      const result = await runPipeline(transcriptText, pipelineCtx);
      console.log(
        `${ts()} [distill] transcript=${transcript_id} chunks=${result.chunksProcessed} atoms=${result.atomsExtracted} ` +
          `created=${result.memoriesCreated} deduped=${result.memoriesDeduped} gatedOut=${result.gatedOutCount}`,
      );

      // D-DEF2: backfill ingest_idempotency.summary_memory_id (currently the
      // transcript-id placeholder written at ingest time) with the real
      // memory id this run produced, so idempotent replays return it.
      if (result.memoryIds.length > 0) {
        backfillSummaryMemoryId(ctx.db, transcript_id, result.memoryIds[0]!);
      }
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        // Budget exceeded — move job to paused. The worker will not retry.
        // We need access to the job id — the worker passes it via the job object.
        // Since JobHandler.handle does not receive the job id directly,
        // we throw a special marker error that the worker catches.
        // Alternative: use a sentinel to signal paused state.
        throw new DistillBudgetPausedError(err.message);
      }
      throw err;
    }
  },
};

/**
 * Sentinel error thrown by the distill handler when the budget cap is hit.
 * The worker loop must catch this and call JobRepo.pause() instead of fail().
 */
export class DistillBudgetPausedError extends Error {
  constructor(budgetMessage: string) {
    super(`BUDGET_PAUSED:${budgetMessage}`);
    this.name = 'DistillBudgetPausedError';
  }

  static is(err: unknown): err is DistillBudgetPausedError {
    return err instanceof DistillBudgetPausedError;
  }
}
