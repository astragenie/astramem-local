/**
 * Consolidation routes (Wave 4b, ADR-004 stage 9):
 *   POST /consolidation/run                     -> 200 ConsolidateSummary
 *   GET  /consolidation/proposals?status=       -> { proposals: [...] }
 *   POST /consolidation/proposals/:id/accept    -> 200 proposal | 404 | 409
 *   POST /consolidation/proposals/:id/reject    -> 200 proposal | 404 | 409
 *
 * /run executes the deterministic pass inline (no LLM in v1 — cheap enough
 * to run synchronously); the `consolidate` job kind wraps the same call for
 * scheduled runs.
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DB } from '../../storage/db.js';
import { runConsolidation } from '../../consolidate/consolidate.js';
import {
  ProposalRepo,
  ProposalNotFoundError,
  ProposalAlreadyResolvedError,
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
});

export function consolidationRoutes(db: DB) {
  return async (app: FastifyInstance) => {
    const proposals = new ProposalRepo(db);

    app.post('/consolidation/run', async (req, reply) => {
      const parsed = RunBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      return runConsolidation(db, {
        mergeThreshold: parsed.data.merge_threshold,
        proposeThreshold: parsed.data.propose_threshold,
      });
    });

    app.get('/consolidation/proposals', async (req, reply) => {
      const parsed = ListQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      return { proposals: proposals.list(parsed.data.status) };
    });

    const resolveHandler = (action: 'accept' | 'reject') =>
      async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = req.params as { id: string };
        try {
          return action === 'accept' ? proposals.accept(id) : proposals.reject(id);
        } catch (err) {
          if (err instanceof ProposalNotFoundError) return reply.code(404).send({ error: 'not found', id });
          if (err instanceof ProposalAlreadyResolvedError) return reply.code(409).send({ error: err.message, id });
          // Accept can hit lifecycle conflicts if an atom was merged/erased
          // since the proposal was written — surface, don't 500.
          if (err instanceof MemoryNotFoundError) return reply.code(409).send({ error: err.message, id });
          if (err instanceof MemoryConflictError) return reply.code(409).send({ error: err.message, id });
          throw err;
        }
      };

    app.post('/consolidation/proposals/:id/accept', resolveHandler('accept'));
    app.post('/consolidation/proposals/:id/reject', resolveHandler('reject'));
  };
}
