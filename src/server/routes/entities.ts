/**
 * Entity query routes (FEAT-402 slice 2, AC-5):
 *   GET /entities?q=&limit=          — autocomplete (name substring match)
 *   GET /entities/:id/memories       — every memory linked to this entity
 *
 * Both routes sit behind the same Bearer-auth preHandler as every other
 * non-public route (src/server/app.ts) — neither is in the /health,
 * /version, /dashboard allowlist.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { EntityRepo } from '../../storage/entities.js';
import { MemoryRepo } from '../../storage/memories.js';

export function entitiesRoute(db: DB) {
  return async (app: FastifyInstance) => {
    // GET /entities?q=pg — autocomplete. Empty q returns entities alphabetically.
    app.get('/entities', async (req, reply) => {
      const params = req.query as Record<string, string>;
      const q = params.q ?? '';
      const rawLimit = params.limit ? Number(params.limit) : 20;
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 20;

      const entityRepo = new EntityRepo(db);
      const entities = entityRepo.search(q, limit);
      return { entities };
    });

    // GET /entities/:id/memories — every memory currently linked to entity :id.
    app.get('/entities/:id/memories', async (req, reply) => {
      const { id } = req.params as { id: string };
      const entityRepo = new EntityRepo(db);
      const entity = entityRepo.getById(id);
      if (!entity) {
        return reply.code(404).send({ error: 'not found', id });
      }

      const memRepo = new MemoryRepo(db);
      const memoryIds = entityRepo.memoryIdsForEntities([id]);
      // Currently-valid only (valid_to IS NULL — same semantics as
      // validityFilterClause(undefined) in src/search/search.ts): a
      // superseded/invalidated/archived memory is retired, not "currently
      // linked" to the entity, even though the memory_entities row itself
      // still points at it.
      const memories = Array.from(memoryIds)
        .map(mid => memRepo.get(mid))
        .filter((m): m is NonNullable<typeof m> => m !== null && m.valid_to === null);

      return { entity, memories };
    });
  };
}
