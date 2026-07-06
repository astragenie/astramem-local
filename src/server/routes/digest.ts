/**
 * Session digest route (KF-C): "what I learned this session".
 *   GET /sessions/:id/digest
 * Derived at read time from memories(session_id); no stored digest state.
 * status=pending while a distill job for this session is queued/running.
 * Digest shape is built by server/queries/provenance.ts, shared with the
 * MCP session_digest tool (mcp/server.ts) so both transports stay in sync.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { buildSessionDigest } from '../queries/provenance.js';

export function digestRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.get('/sessions/:id/digest', async (req, reply) => {
      const { id } = req.params as { id: string };

      const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
      if (!session) {
        return reply.code(404).send({ error: 'not found', session_id: id });
      }

      return buildSessionDigest(db, id);
    });
  };
}
