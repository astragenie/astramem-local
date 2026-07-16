/**
 * Consolidation routes (Wave 4b, ADR-004 stage 9):
 *   POST /consolidation/run                          -> 200 ConsolidateSummary
 *   GET  /consolidation/proposals?status=&kind=&limit=&offset=&min_confidence=
 *                                                     -> { proposals: [...], total }
 *   POST /consolidation/proposals/:id/accept         -> 200 proposal | 404 | 409
 *   POST /consolidation/proposals/:id/reject         -> 200 proposal | 404 | 409
 *
 * /run executes the deterministic pass inline (no LLM in v1 — cheap enough
 * to run synchronously); the `consolidate` job kind wraps the same call for
 * scheduled runs.
 *
 * FEAT-456 SLICE-2: `kind` is an optional second filter on the list route,
 * needed for the design's `?status=accepted&kind=contradiction` audit query
 * (§2.4) — `ProposalRepo.list()` already accepts it (proposals.ts).
 *
 * #372/#171: `limit`/`offset`/`min_confidence` are additive on top of that
 * same precedent — fixes #171's "ignored ?limit" and gives operators a way
 * to page a queue that has grown into the hundreds without pulling every
 * row (and every winner/loser text) in one response. `total` reflects the
 * status/kind/min_confidence filters but NOT the limit/offset slice, so a
 * client can render "showing N of total".
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DB } from '../../storage/db.js';
import type { Config } from '../../config/config.js';
import { runConsolidation } from '../../consolidate/consolidate.js';
import {
  ProposalRepo,
  ProposalNotFoundError,
  ProposalAlreadyResolvedError,
  type ConsolidationProposal,
} from '../../consolidate/proposals.js';
import { MemoryConflictError, MemoryNotFoundError } from '../../storage/memory-events.js';

const RunBodySchema = z.object({
  merge_threshold: z.number().min(0).max(1).optional(),
  propose_threshold: z.number().min(0).max(1).optional(),
}).refine(
  b => b.merge_threshold === undefined || b.propose_threshold === undefined
    || b.propose_threshold <= b.merge_threshold,
  { message: 'propose_threshold must be <= merge_threshold' },
);

const ListQuerySchema = z.object({
  status: z.enum(['pending', 'accepted', 'rejected']).optional(),
  kind: z.enum(['merge', 'contradiction']).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  min_confidence: z.coerce.number().min(0).max(1).optional(),
});

// FEAT-437 residual: `bulk` distinguishes the `consolidate accept --all` CLI
// path from a single manual accept — see ProposalRepo.accept's `opts` param.
// Ignored on reject (rejection carries no equivalent provenance to mark).
// Optional so existing accept callers sending no body at all are unaffected.
const AcceptBodySchema = z.object({ bulk: z.boolean().optional() }).optional();

export type ProposalResolveOutcome =
  | { ok: true; proposal: ConsolidationProposal }
  | { ok: false; status: 404 | 409; error: string; id: string };

/**
 * Shared accept/reject resolution — the ONE place that maps
 * ProposalRepo's thrown errors to (status, body) shapes. Both the
 * Bearer-gated API route below and the cookie-gated dashboard mutation
 * route (dashboard-consolidation-html.ts) call this rather than each
 * reimplementing not-found/conflict handling, so the two surfaces cannot
 * drift on resolution semantics.
 */
export function resolveProposal(
  proposals: ProposalRepo,
  id: string,
  action: 'accept' | 'reject',
  acceptOpts?: { bulkAccepted?: boolean },
): ProposalResolveOutcome {
  try {
    const proposal = action === 'reject'
      ? proposals.reject(id)
      : proposals.accept(id, undefined, acceptOpts);
    return { ok: true, proposal };
  } catch (err) {
    if (err instanceof ProposalNotFoundError) return { ok: false, status: 404, error: 'not found', id };
    if (err instanceof ProposalAlreadyResolvedError) return { ok: false, status: 409, error: err.message, id };
    // Accept can hit lifecycle conflicts if an atom was merged/erased since
    // the proposal was written — surface, don't 500.
    if (err instanceof MemoryNotFoundError) return { ok: false, status: 409, error: err.message, id };
    if (err instanceof MemoryConflictError) return { ok: false, status: 409, error: err.message, id };
    throw err;
  }
}

export function consolidationRoutes(db: DB, config: Config) {
  return async (app: FastifyInstance) => {
    const proposals = new ProposalRepo(db);

    app.post('/consolidation/run', async (req, reply) => {
      const parsed = RunBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      return await runConsolidation(db, {
        mergeThreshold: parsed.data.merge_threshold,
        proposeThreshold: parsed.data.propose_threshold,
        // FEAT-442: on-demand runs pick up the configured auto-accept
        // threshold too (default null = OFF), same as the scheduled job.
        autoAcceptThreshold: config.consolidation.autoAcceptThreshold,
        // P2.1 stabilization: on-demand runs pick up the configured
        // candidate-selection strategy too (default 'full', byte-identical
        // to pre-P2.1 behavior), same as the scheduled job.
        candidateSelection: config.consolidation.candidateSelection,
        knnK: config.consolidation.knnK,
        maxCandidatePairsPerRun: config.consolidation.maxCandidatePairsPerRun,
      });
    });

    app.get('/consolidation/proposals', async (req, reply) => {
      const parsed = ListQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      const { status, kind, limit, offset, min_confidence: minConfidence } = parsed.data;
      return {
        proposals: proposals.list(status, kind, { limit, offset, minConfidence }),
        total: proposals.count(status, kind, minConfidence),
      };
    });

    const resolveHandler = (action: 'accept' | 'reject') =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        let acceptOpts: { bulkAccepted?: boolean } | undefined;
        if (action === 'accept') {
          const parsedBody = AcceptBodySchema.safeParse(req.body ?? {});
          const bulk = parsedBody.success && parsedBody.data?.bulk === true;
          acceptOpts = bulk ? { bulkAccepted: true } : undefined;
        }
        const outcome = resolveProposal(proposals, id, action, acceptOpts);
        if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error, id: outcome.id });
        return outcome.proposal;
      };

    app.post('/consolidation/proposals/:id/accept', resolveHandler('accept'));
    app.post('/consolidation/proposals/:id/reject', resolveHandler('reject'));
  };
}
