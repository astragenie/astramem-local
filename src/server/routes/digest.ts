/**
 * Session digest route (KF-C): "what I learned this session".
 *   GET /sessions/:id/digest
 * Derived at read time from memories(session_id); no stored digest state.
 * status=pending while a distill job for this session is queued/running.
 *
 * FEAT-417a: the digest is built by the shared getSessionDigest() query
 * (src/server/queries/digest.ts) — the session_digest MCP tool calls the
 * same function, so the two surfaces cannot drift apart.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { getSessionDigest } from '../queries/digest.js';

export function digestRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.get('/sessions/:id/digest', async (req, reply) => {
      const { id } = req.params as { id: string };

      const digest = getSessionDigest(db, id);
      if (!digest) {
        return reply.code(404).send({ error: 'not found', session_id: id });
      }

      return digest;
    });
  };
}
