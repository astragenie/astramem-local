/**
 * Memory-tool adapter REST surface (ADR-007 Wave 4a, migration-map 4a):
 *   POST /memory-tool { command, path, ... } -> { content: string } | { error: string }
 *
 * Bearer-authed via the app-level preHandler (src/server/app.ts) — no route-
 * local auth here. Body is the raw Anthropic memory-tool command JSON; the
 * response shape is exactly what a harness needs to relay back to the model
 * as a tool_result. See docs/memory-tool-adapter.md for the command mapping
 * and limitations, and src/memory-tool/adapter.ts for the mapping logic.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { defaultConfig, type Config } from '../../config/config.js';
import { handleMemoryToolCommand, type MemoryToolCommand } from '../../memory-tool/adapter.js';

export function memoryToolRoute(db: DB, config: Config = defaultConfig()) {
  return async (app: FastifyInstance) => {
    app.post('/memory-tool', async (req, reply) => {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body.command !== 'string') {
        return reply.code(400).send({ error: 'invalid: command is required' });
      }
      // `path` defaults to '' rather than being required at the HTTP layer —
      // the adapter maps a missing/invalid path to a clean { error } result
      // (e.g. 'rename' never needs one), matching the "never throws" contract.
      const cmd: MemoryToolCommand = { path: '', ...body, command: body.command } as MemoryToolCommand;
      return handleMemoryToolCommand(db, config, cmd);
    });
  };
}
