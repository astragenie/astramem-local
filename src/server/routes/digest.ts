/**
 * Session digest route (KF-C): "what I learned this session".
 *   GET /sessions/:id/digest
 * Derived at read time from memories(session_id); no stored digest state.
 * status=pending while a distill job for this session is queued/running.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';

interface MemRow { id: string; type: string; text: string }

export function digestRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.get('/sessions/:id/digest', async (req, reply) => {
      const { id } = req.params as { id: string };

      const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
      if (!session) {
        return reply.code(404).send({ error: 'not found', session_id: id });
      }

      // A distill job for this session still queued or running → pending.
      // json_extract (SQLite JSON1, bundled with better-sqlite3) — exact match,
      // immune to LIKE-wildcard injection and payload key reordering.
      const activeJob = db.prepare(`
        SELECT id FROM jobs
        WHERE kind = 'distill' AND state IN ('pending', 'running')
          AND json_extract(payload_json, '$.session_id') = ?
        LIMIT 1
      `).get(id);

      const rows = db.prepare(
        'SELECT id, type, text FROM memories WHERE session_id = ? ORDER BY created_at ASC'
      ).all(id) as MemRow[];

      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.type] = (counts[r.type] ?? 0) + 1;

      return {
        session_id: id,
        status: activeJob ? 'pending' : 'ready',
        counts,
        memories: rows,
      };
    });
  };
}
