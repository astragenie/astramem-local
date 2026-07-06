/**
 * Provenance receipt route (KF-A):
 *   GET /memory/:id/why — memory + evidence + source session + transcript ref.
 * `history` is the memory_events lifecycle log for this atom (ADR-002,
 * Wave 2b) — empty for atoms that predate any lifecycle events.
 * Receipt shape is built by server/queries/provenance.ts, shared with the
 * MCP why_memory tool (mcp/server.ts) so both transports stay in sync.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { buildWhyReceipt } from '../queries/provenance.js';

export function whyRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.get('/memory/:id/why', async (req, reply) => {
      const { id } = req.params as { id: string };
      const receipt = buildWhyReceipt(db, id);
      if (!receipt) {
        return reply.code(404).send({ error: 'not found', id });
      }

      return receipt;
    });
  };
}
