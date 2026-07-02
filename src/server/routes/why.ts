/**
 * Provenance receipt route (KF-A):
 *   GET /memory/:id/why — memory + evidence + source session + transcript ref.
 * `history` is the memory_events lifecycle log for this atom (ADR-002,
 * Wave 2b) — empty for atoms that predate any lifecycle events.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { MemoryRepo } from '../../storage/memories.js';
import { MemoryEventRepo } from '../../storage/memory-events.js';

interface SessionBlock {
  id: string;
  repo: string | null;
  branch: string | null;
  agent: string | null;
  started_at: number;
}

export function whyRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.get('/memory/:id/why', async (req, reply) => {
      const { id } = req.params as { id: string };
      const memory = new MemoryRepo(db).get(id);
      if (!memory) {
        return reply.code(404).send({ error: 'not found', id });
      }

      let session: SessionBlock | null = null;
      if (memory.session_id) {
        session = (db
          .prepare('SELECT id, repo, branch, agent, started_at FROM sessions WHERE id = ?')
          .get(memory.session_id) as SessionBlock | undefined) ?? null;
      }

      return {
        id: memory.id,
        type: memory.type,
        text: memory.text,
        importance: memory.importance,
        confidence: memory.confidence,
        evidence: memory.evidence,
        session,
        transcript_ref: memory.source_hash,
        created_at: memory.created_at,
        history: new MemoryEventRepo(db).listForAtom(id),
      };
    });
  };
}
