/**
 * Memory detail route:
 *   GET /memory/:id — returns full Memory record or 404
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { MemoryRepo } from '../../storage/memories.js';

export function memoryRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.get('/memory/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const repo = new MemoryRepo(db);
      const memory = repo.get(id);
      if (!memory) {
        return reply.code(404).send({ error: 'not found', id });
      }
      return memory;
    });
  };
}
