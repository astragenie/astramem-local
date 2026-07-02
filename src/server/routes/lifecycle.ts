/**
 * Memory lifecycle routes (Wave 2b, ADR-002 memory_events log):
 *   POST /memory/:id/invalidate { reason? } -> 200 { ok: true } | 404 | 409
 *   POST /memory/:id/supersede  { new_id }  -> 200 { ok: true } | 404 | 409
 *   POST /memory/:id/promote    { scope }   -> 200 { ok: true } | 400 | 404
 *   GET  /memory/:id/history                -> { id, history: MemoryEvent[] }
 *   POST /memory/:id/used                   -> 200 { ok: true } | 404
 *
 * `history` also backs the Wave 2c MCP `memory_history` tool.
 * `used` is the ADR-010 (2e) explicit recall-used signal — REST twin of the
 * MCP `mark_memory_used` tool (src/mcp/server.ts).
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { MemoryRepo } from '../../storage/memories.js';
import {
  MemoryEventRepo,
  MemoryNotFoundError,
  MemoryConflictError,
  InvalidScopeTransitionError,
} from '../../storage/memory-events.js';
import { recordRecallUsed } from '../../storage/usefulness.js';

const InvalidateBodySchema = z.object({ reason: z.string().optional() });
const SupersedeBodySchema = z.object({ new_id: z.string().min(1) });
const PromoteBodySchema = z.object({ scope: z.enum(['personal', 'team', 'org']) });

export function lifecycleRoutes(db: DB) {
  return async (app: FastifyInstance) => {
    const events = new MemoryEventRepo(db);

    app.post('/memory/:id/invalidate', async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = InvalidateBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      try {
        events.invalidate(id, parsed.data.reason);
        return { ok: true };
      } catch (err) {
        if (err instanceof MemoryNotFoundError) return reply.code(404).send({ error: 'not found', id });
        if (err instanceof MemoryConflictError) return reply.code(409).send({ error: err.message, id });
        throw err;
      }
    });

    app.post('/memory/:id/supersede', async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = SupersedeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      try {
        events.supersede(id, parsed.data.new_id);
        return { ok: true };
      } catch (err) {
        if (err instanceof MemoryNotFoundError) return reply.code(404).send({ error: 'not found', id: err.atomId });
        if (err instanceof MemoryConflictError) return reply.code(409).send({ error: err.message });
        throw err;
      }
    });

    app.post('/memory/:id/promote', async (req, reply) => {
      const { id } = req.params as { id: string };
      const parsed = PromoteBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      try {
        events.promoteScope(id, parsed.data.scope);
        return { ok: true };
      } catch (err) {
        if (err instanceof MemoryNotFoundError) return reply.code(404).send({ error: 'not found', id });
        if (err instanceof InvalidScopeTransitionError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    });

    app.get('/memory/:id/history', async (req, reply) => {
      const { id } = req.params as { id: string };
      const memory = new MemoryRepo(db).get(id);
      if (!memory) return reply.code(404).send({ error: 'not found', id });
      return { id, history: events.listForAtom(id) };
    });

    // ADR-010 (2e): explicit recall-used signal — the REST twin of the MCP
    // mark_memory_used tool. v1 feeds doctor/dashboard/health only.
    app.post('/memory/:id/used', async (req, reply) => {
      const { id } = req.params as { id: string };
      const memory = new MemoryRepo(db).get(id);
      if (!memory) return reply.code(404).send({ error: 'not found', id });
      recordRecallUsed(db, { atomId: id, surface: 'rest', signal: 'explicit' });
      return { ok: true };
    });
  };
}
