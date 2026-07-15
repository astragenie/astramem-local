/**
 * Memory lifecycle routes (Wave 2b, ADR-002 memory_events log):
 *   POST /memory/:id/invalidate { reason? } -> 200 { ok: true } | 400 | 401 | 404 | 409
 *   POST /memory/:id/supersede  { new_id }  -> 200 { ok: true } | 400 | 401 | 404 | 409
 *   POST /memory/:id/promote    { scope }   -> 200 { ok: true } | 400 | 401 | 404 | 409
 *   POST /memory/:id/restore                -> 200 { ok: true } | 401 | 404 | 409   (FEAT-416, un-archive)
 *   POST /memory/:id/unsupersede             -> 200 { ok: true } | 401 | 404 | 409   (FEAT-442, un-supersede)
 *   GET  /memory/:id/history                -> { id, history: MemoryEvent[] } | 401 | 404
 *   POST /memory/:id/used                   -> 200 { ok: true } | 401 | 404
 *   DELETE /memory/:id                      -> 200 { ok: true } | 401 | 404   (erasure v1, ADR-006 W5)
 *
 * `history` also backs the Wave 2c MCP `memory_history` tool.
 * `used` is the ADR-010 (2e) explicit recall-used signal — REST twin of the
 * MCP `submit_feedback` tool (src/mcp/server.ts; U5 canonical name — the
 * former `mark_memory_used` is now a one-release deprecated alias).
 * `restore` un-archives a memory previously archived by the W4.4 TTL policy
 * (src/storage/archival.ts) or by a manual `archive` event — mirrors
 * `invalidate`'s 404/409 semantics exactly (MemoryEventRepo.restore() already
 * throws MemoryNotFoundError/MemoryConflictError for the same two cases).
 * `unsupersede` (FEAT-442 reversal primitive) is the analogous un-do for
 * `supersede` — most commonly used to reverse an autonomous-consolidation
 * auto-accept, but works for any supersede (manual or auto). Un-hides the
 * LOSER; the winner is untouched (see MemoryEventRepo.unsupersede()'s doc
 * comment for exact semantics). Same 404/409 mapping.
 *
 * Error-class -> status mapping is centralized in `mapLifecycleError` below
 * (FEAT-435 conformance): MemoryNotFoundError always -> 404, and both
 * MemoryConflictError and InvalidScopeTransitionError (a valid id whose
 * current state makes the requested transition inapplicable — e.g. a
 * downward scope promotion) -> 409. 400 is reserved exclusively for
 * malformed/invalid request bodies (zod parse failures). Every verb below
 * routes its typed-error catch through this one helper so a future 5th verb
 * can't silently diverge — see tests/server/lifecycle.test.ts's
 * "lifecycle error-status conformance" suite.
 *
 * Exported (not just used internally) so `server/routes/capture-purge.ts`
 * (FEAT-467) reuses the exact same mapping for its batch-scoped verbs rather
 * than inventing a parallel error-status convention.
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DB } from '../../storage/db.js';
import { MemoryRepo } from '../../storage/memories.js';
import {
  MemoryEventRepo,
  MemoryNotFoundError,
  MemoryConflictError,
  InvalidScopeTransitionError,
} from '../../storage/memory-events.js';
import { recordRecallUsed } from '../../storage/usefulness.js';
import { normalizeScopeAlias } from '../../contracts/index.js';
import { withDeadline } from '../lib/deadline.js';

const InvalidateBodySchema = z.object({ reason: z.string().optional() });
const SupersedeBodySchema = z.object({ new_id: z.string().min(1) });
// One-release alias (U7-local astramem-local#110, DEC-048): 'personal' is
// still accepted from older clients/plugins and normalized to 'private'
// before it reaches promoteScope() — no new row ever persists the literal
// 'personal'. TODO(remove-personal-alias): drop 'personal' from this enum
// in the release AFTER this one — tracked in astramem-local#115.
const PromoteBodySchema = z.object({
  scope: z.enum(['private', 'team', 'org', 'personal']).transform(normalizeScopeAlias),
});

/**
 * Uniform mapping from the repo's typed lifecycle errors to HTTP status +
 * error-body shape. `id` is the route's :id param, used as the 409 body's
 * `id` field (MemoryConflictError/InvalidScopeTransitionError carry no
 * atomId of their own). 404 uses `err.atomId` instead of the route `id`
 * because supersede's not-found can refer to either the source id or the
 * `new_id` target — both still surface under the same `id` key. Anything
 * else is rethrown for Fastify's default error handler.
 */
export function mapLifecycleError(err: unknown, id: string, reply: FastifyReply) {
  if (err instanceof MemoryNotFoundError) {
    return reply.code(404).send({ error: 'not found', id: err.atomId });
  }
  if (err instanceof MemoryConflictError || err instanceof InvalidScopeTransitionError) {
    return reply.code(409).send({ error: err.message, id });
  }
  throw err;
}

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
        return mapLifecycleError(err, id, reply);
      }
    });

    // Erasure v1 (ADR-006 W5): hard-delete + tombstone event. The row and
    // its FTS/vec entries are gone; the erase_request event (with content
    // hash) is the tombstone that powers the replay filter and cloud sync.
    app.delete('/memory/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { reason?: string };
      try {
        events.erase(id, typeof body.reason === 'string' ? body.reason : undefined);
        return { ok: true };
      } catch (err) {
        return mapLifecycleError(err, id, reply);
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
        return mapLifecycleError(err, id, reply);
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
        return mapLifecycleError(err, id, reply);
      }
    });

    app.post('/memory/:id/restore', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        events.restore(id);
        return { ok: true };
      } catch (err) {
        return mapLifecycleError(err, id, reply);
      }
    });

    // FEAT-442 reversal primitive: un-hide a memory previously superseded
    // (manual accept, containment auto-merge, or autonomous-consolidation
    // auto-accept). The winner is untouched — see
    // MemoryEventRepo.unsupersede()'s doc comment for exact semantics.
    app.post('/memory/:id/unsupersede', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        events.unsupersede(id);
        return { ok: true };
      } catch (err) {
        return mapLifecycleError(err, id, reply);
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
    //
    // ADR-019 Tier 1 (issue #347) Decision 1b: bound the DB work in a
    // deadline race so a hang inside THIS handler's own async chain returns
    // a clean 504 instead of hanging to the client's cap. See
    // src/server/lib/deadline.ts's doc comment for what this does and does
    // NOT protect against (it does not close #347 — 1a does).
    app.post('/memory/:id/used', async (req, reply) => {
      const { id } = req.params as { id: string };
      return withDeadline('POST /memory/:id/used', reply, async () => {
        const memory = new MemoryRepo(db).get(id);
        if (!memory) return reply.code(404).send({ error: 'not found', id });
        recordRecallUsed(db, { atomId: id, surface: 'rest', signal: 'explicit' });
        return { ok: true };
      });
    });
  };
}
