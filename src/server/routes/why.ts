/**
 * Provenance receipt route (KF-A):
 *   GET /memory/:id/why — memory + evidence + source session + transcript ref.
 * `history` is the memory_events lifecycle log for this atom (ADR-002,
 * Wave 2b) — empty for atoms that predate any lifecycle events.
 *
 * FEAT-417a: the receipt is built by the shared getWhyReceipt() query
 * (src/server/queries/why.ts) — the why_memory MCP tool calls the same
 * function, so the two surfaces cannot drift apart.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { getWhyReceipt } from '../queries/why.js';

export function whyRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.get('/memory/:id/why', async (req, reply) => {
      const { id } = req.params as { id: string };
      const receipt = getWhyReceipt(db, id);
      if (!receipt) {
        return reply.code(404).send({ error: 'not found', id });
      }
      return receipt;
    });
  };
}
