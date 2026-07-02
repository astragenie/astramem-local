/**
 * Memory-pack endpoint (KF-B):
 *   POST /recall/pack { repo, project?, branch?, budget_tokens? }
 * Returns { pack: <markdown>, memories: [...] }. Empty pack on zero matches (200).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../storage/db.js';
import { selectPack, renderPack } from '../../recall/pack.js';
import { defaultConfig } from '../../config/config.js';

const PackRequestSchema = z.object({
  repo: z.string().min(1),
  project: z.string().nullish(),
  branch: z.string().nullish(),
  budget_tokens: z.number().int().positive().max(8000).optional(),
});

export function recallRoute(db: DB) {
  return async (app: FastifyInstance) => {
    app.post('/recall/pack', async (req, reply) => {
      const parsed = PackRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const cfg = defaultConfig();
      const memories = selectPack(db, {
        repo: parsed.data.repo,
        project: parsed.data.project,
        branch: parsed.data.branch,
        budgetTokens: parsed.data.budget_tokens ?? cfg.recallPack.budgetTokens,
      });
      return { pack: renderPack(memories), memories };
    });
  };
}
