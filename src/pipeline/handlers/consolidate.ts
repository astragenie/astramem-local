/**
 * `consolidate` job handler — scheduled/queued entry point for the ADR-004
 * stage 9 pass. The merge/propose pass itself is deterministic (no LLM);
 * FEAT-456 SLICE-1 adds an opt-in contradiction judge call (default off),
 * which is why `runConsolidation` — and this handler — are async now.
 *
 * FEAT-482: the judge now spends against the SAME daily BudgetTracker cap
 * distill uses (src/budget/tracker.ts) — a `BudgetExceeded` thrown mid-sweep
 * (see contradiction-judge.ts) is caught here and converted to
 * `BudgetPausedError`, exactly mirroring pipeline/handlers/distill.ts, so
 * the worker's existing pause-not-fail path (worker.ts) applies to
 * `consolidate` jobs too — a cap hit no longer burns retries toward poison.
 */

import { z } from 'zod';
import type { JobHandler } from '../handler.js';
import { isExtendedCtx } from '../handler-ctx-ext.js';
import { runConsolidation } from '../../consolidate/consolidate.js';
import { BudgetTracker, BudgetExceeded } from '../../budget/tracker.js';
import { BudgetPausedError } from '../errors.js';

const ConsolidatePayloadSchema = z.object({
  merge_threshold: z.number().min(0).max(1).optional(),
  propose_threshold: z.number().min(0).max(1).optional(),
});

export const consolidateHandler: JobHandler = {
  kind: 'consolidate',
  async handle(payload, ctx): Promise<void> {
    const parsed = ConsolidatePayloadSchema.parse(payload ?? {});
    try {
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
        judgeProvider: isExtendedCtx(ctx) ? ctx.providers.llm.extraction : undefined,
        // FEAT-482: same tracker + cap distill uses — one `budget_spend`
        // table, one daily total, shared across job kinds.
        budget: new BudgetTracker(ctx.db),
        capUsd: ctx.config.budget.daily_usd,
      });
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        // Mirrors pipeline/handlers/distill.ts exactly — see that file's
        // catch block for the full rationale.
        throw new BudgetPausedError(err.message);
      }
      throw err;
    }
  },
};
