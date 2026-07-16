/**
 * `consolidate` job handler — scheduled/queued entry point for the ADR-004
 * stage 9 pass. The merge/propose pass itself is deterministic (no LLM);
 * FEAT-456 SLICE-1 adds an opt-in contradiction judge call (default off),
 * which is why `runConsolidation` — and this handler — are async now.
 *
 * FEAT-482 postscript: an earlier revision of this handler wired the judge
 * through `BudgetTracker` and caught `BudgetExceeded` to pause the job —
 * reverted, see contradiction-judge.ts's doc comment (neither shipped LLM
 * provider reports non-zero `usage.usd`, so that check could never trip).
 * `runConsolidation` now self-bounds the judge sweep via `maxPerRun`/
 * `maxWallClockMs` instead, so no BudgetExceeded is ever thrown from this
 * call and no pause-conversion is needed here.
 */

import { z } from 'zod';
import type { JobHandler } from '../handler.js';
import { isExtendedCtx } from '../handler-ctx-ext.js';
import { runConsolidation } from '../../consolidate/consolidate.js';

const ConsolidatePayloadSchema = z.object({
  merge_threshold: z.number().min(0).max(1).optional(),
  propose_threshold: z.number().min(0).max(1).optional(),
});

export const consolidateHandler: JobHandler = {
  kind: 'consolidate',
  async handle(payload, ctx): Promise<void> {
    const parsed = ConsolidatePayloadSchema.parse(payload ?? {});
    await runConsolidation(ctx.db, {
      mergeThreshold: parsed.merge_threshold,
      proposeThreshold: parsed.propose_threshold,
      // FEAT-442: scheduled/enqueued runs pick up the configured auto-accept
      // threshold (default null = OFF, byte-identical to pre-FEAT-442).
      autoAcceptThreshold: ctx.config.consolidation.autoAcceptThreshold,
      // FEAT-456: scheduled/enqueued runs pick up the configured
      // contradiction-detection mode too (default 'off', byte-identical to
      // pre-FEAT-456). The judge provider is only available with an
      // ExtendedHandlerCtx (real providers wired) — without one (e.g. a
      // unit test's bare ctx), mode!=='off' is disabled for the run rather
      // than crashing (see resolveContradictionDetection's non-fatal guard).
      contradictionDetection: ctx.config.consolidation.contradictionDetection,
      // `judge` is set by getProviders (dedicated provider when
      // consolidation.contradictionDetection.{provider,model} is configured,
      // else the extraction instance); the `?? extraction` fallback covers
      // hand-built ProviderSets that predate the optional field.
      judgeProvider: isExtendedCtx(ctx)
        ? ctx.providers.llm.judge ?? ctx.providers.llm.extraction
        : undefined,
      // P2.1 stabilization: scheduled/enqueued runs pick up the configured
      // candidate-selection strategy too (default 'full', byte-identical to
      // pre-P2.1 behavior). Reuse the already-wired vecStore off an
      // ExtendedHandlerCtx rather than let runConsolidation allocate a
      // second SqliteVecStore against the same connection — without one
      // (e.g. a unit test's bare ctx), runConsolidation falls back to
      // constructing its own.
      candidateSelection: ctx.config.consolidation.candidateSelection,
      knnK: ctx.config.consolidation.knnK,
      maxCandidatePairsPerRun: ctx.config.consolidation.maxCandidatePairsPerRun,
      vectorStore: isExtendedCtx(ctx) ? ctx.vecStore : undefined,
    });
  },
};
