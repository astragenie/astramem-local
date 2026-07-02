/**
 * Memory-pack endpoint (KF-B + Wave 4d injection policy):
 *   POST /recall/pack { repo, project?, branch?, budget_tokens?, prompt? }
 * Returns { pack: <markdown>, memories: [...] }. Empty pack on zero matches (200).
 *
 * When `prompt` is supplied, the ADR-005 injection-policy v1 layer decides
 * whether anything should be injected at all (task-type gating, confidence
 * threshold, token-budget shrink) and the response gains
 * `decision: { inject, reason, budget_tokens }`. Without `prompt` the legacy
 * always-select behavior is preserved (existing hook clients unaffected).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../../storage/db.js';
import type { Config } from '../../config/config.js';
import { selectPack, renderPack } from '../../recall/pack.js';
import { decideInjection } from '../../recall/policy.js';
import { recordRecallServed } from '../../storage/usefulness.js';
import { defaultConfig } from '../../config/config.js';

const PackRequestSchema = z.object({
  repo: z.string().min(1),
  project: z.string().nullish(),
  branch: z.string().nullish(),
  budget_tokens: z.number().int().positive().max(8000).optional(),
  /** Wave 4d: the user prompt about to be sent — activates the injection policy. */
  prompt: z.string().max(64_000).optional(),
});

export function recallRoute(db: DB, config: Config = defaultConfig()) {
  return async (app: FastifyInstance) => {
    app.post('/recall/pack', async (req, reply) => {
      const parsed = PackRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }

      // Wave 4d: prompt present → policy decides.
      if (parsed.data.prompt !== undefined) {
        const decision = decideInjection(db, config, {
          repo: parsed.data.repo,
          prompt: parsed.data.prompt,
          budgetTokens: parsed.data.budget_tokens,
        });
        return {
          pack: decision.pack,
          memories: decision.memories,
          decision: {
            inject: decision.inject,
            reason: decision.reason,
            budget_tokens: decision.budget_tokens,
          },
        };
      }

      // Legacy path (no prompt): always select — existing hook clients unaffected.
      const memories = selectPack(db, {
        repo: parsed.data.repo,
        project: parsed.data.project,
        branch: parsed.data.branch,
        budgetTokens: parsed.data.budget_tokens ?? config.recallPack.budgetTokens,
      });
      // ADR-010: recall-usefulness capture — measure only, does not feed ranking (v1).
      // No free-text query here; hash the structural selector instead.
      recordRecallServed(db, {
        query: `${parsed.data.repo}|${parsed.data.project ?? ''}|${parsed.data.branch ?? ''}`,
        atomIds: memories.map(m => m.id),
        scores: memories.map(m => m.score),
        surface: 'rest',
        mode: 'pack',
      });
      return { pack: renderPack(memories), memories };
    });
  };
}
