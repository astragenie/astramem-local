/**
 * User Profile route (FEAT-451 slice 1):
 *   GET /profile — read-time synthesized daemon-wide "what does this owner
 *   keep coming back to" profile (standing facts, preferences, recurring
 *   lessons, recent decisions, known entities).
 * Receipt shape is built by server/queries/user-profile.ts, shared with the
 * MCP user_profile tool (mcp/server.ts) so both transports stay in sync.
 * Bearer auth is enforced by the existing global preHandler (app.ts) — no
 * route-local auth here, same as agents.ts/why.ts/digest.ts. No per-scope
 * caller authorization exists (design doc §3, AC-4) — an authenticated
 * caller may widen `?scope=` to any value, same trust boundary /search and
 * /recall already operate under.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { buildUserProfile, isValidProfileScope } from '../queries/user-profile.js';

export function profileRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.get('/profile', async (req, reply) => {
      const params = req.query as Record<string, string>;
      const rawScope = params.scope;

      if (rawScope !== undefined && !isValidProfileScope(rawScope)) {
        return reply.code(400).send({ error: 'invalid scope', scope: rawScope });
      }

      return buildUserProfile(db, rawScope ?? 'private');
    });
  };
}
