/**
 * Distill handler — Wave 3 implementation.
 *
 * Validates the payload, fetches transcript from DB,
 * runs the 8-stage pipeline, and handles BudgetExceeded by
 * moving the job to paused (not failed).
 */

import { z } from 'zod';
import type { JobHandler } from '../handler.js';
import { isExtendedCtx } from '../handler-ctx-ext.js';
import { runPipeline, BudgetExceeded } from '../../distill/pipeline.js';
import { flattenTranscriptContent } from '../../distill/flatten-turns.js';
import { backfillSummaryMemoryId } from '../../storage/ingest-idempotency.js';
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
}

interface SessionRow {
  id: string;
  repo: string | null;
  project: string | null;
  branch: string | null;
  agent: string | null;
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
      .prepare('SELECT id, session_id, content, source FROM transcripts WHERE id = ?')
      .get(transcript_id) as TranscriptRow | undefined;

    if (!transcript) {
      throw new Error(`Transcript not found: ${transcript_id}`);
    }

    // Fetch session metadata for memory context
    const session = ctx.db
      .prepare('SELECT id, repo, project, branch, agent FROM sessions WHERE id = ?')
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
        `[distill] no providers in ctx — transcript ${transcript_id} logged but not distilled. ` +
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
      project: session?.project ?? null,
      branch: session?.branch ?? null,
      agent: session?.agent ?? null,
      sourceHash,
    };

    try {
      const result = await runPipeline(transcriptText, pipelineCtx);
      console.log(
        `[distill] transcript=${transcript_id} chunks=${result.chunksProcessed} atoms=${result.atomsExtracted} ` +
          `created=${result.memoriesCreated} deduped=${result.memoriesDeduped}`,
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
