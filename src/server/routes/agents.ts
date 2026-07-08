/**
 * Agent Profile route:
 *   GET /agents/:agent/profile — read-time synthesized "what has this agent
 *   learned" profile (top lessons, recent decisions, corrections, counts).
 * Receipt shape is built by server/queries/agent-profile.ts, shared with the
 * MCP agent_profile tool (mcp/server.ts) so both transports stay in sync.
 * Bearer auth is enforced by the existing global preHandler (app.ts) — no
 * route-local auth here, same as why.ts/digest.ts.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { buildAgentProfile } from '../queries/agent-profile.js';

export function agentsRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.get('/agents/:agent/profile', async (req, reply) => {
      const { agent } = req.params as { agent: string };
      const profile = buildAgentProfile(db, agent);
      if (!profile) {
        return reply.code(404).send({ error: 'not found', agent });
      }

      return profile;
    });
  };
}
