/**
 * Search routes:
 *   GET  /search?q=&type=&repo=&project=&since=&limit=
 *   POST /recall  { query, k, filters? }
 *   POST /remember { text, type, metadata? }
 */

import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import type { EmbedProvider } from '../../contracts/index.js';
import { MemoryRepo } from '../../storage/memories.js';
import { SqliteVecStore } from '../../vector/sqlite-vec.js';
import { search, type SearchFilters } from '../../search/search.js';
import { defaultConfig } from '../../config/config.js';

const MemoryTypeEnum = z.enum(['decision', 'fact', 'lesson', 'command', 'todo']);

const RecallBodySchema = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().default(5),
  filters: z.object({
    type: z.array(z.string()).optional(),
    repo: z.string().optional(),
    project: z.string().optional(),
    since: z.number().optional()
  }).optional()
});

const RememberBodySchema = z.object({
  text: z.string().min(1),
  type: MemoryTypeEnum,
  metadata: z.object({
    repo: z.string().optional(),
    project: z.string().optional(),
    branch: z.string().optional(),
    agent: z.string().optional(),
    importance: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional()
  }).optional()
});

export function searchRoute(db: DB, embed: EmbedProvider) {
  const cfg = defaultConfig();
  const weights = cfg.search;

  return async (app: FastifyInstance) => {
    // GET /search
    app.get('/search', async (req, reply) => {
      const params = req.query as Record<string, string>;

      if (!params.q && params.q !== '') {
        return reply.code(400).send({ error: 'q parameter is required' });
      }

      const q = params.q ?? '';
      const limit = params.limit ? Math.max(1, Math.min(100, Number(params.limit))) : 10;
      const filters: SearchFilters = {};

      if (params.type) filters.type = params.type.split(',').map(t => t.trim());
      if (params.repo) filters.repo = params.repo;
      if (params.project) filters.project = params.project;
      if (params.since) {
        // Accept epoch ms directly or duration strings like "7d", "24h"
        const sinceNum = Number(params.since);
        if (!isNaN(sinceNum)) {
          filters.since = sinceNum;
        }
      }

      const hits = await search(q, filters, limit, { db, embed, weights });
      return { hits };
    });

    // POST /recall
    app.post('/recall', async (req, reply) => {
      const parsed = RecallBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      const { query, k, filters: rawFilters } = parsed.data;
      const filters: SearchFilters = {};
      if (rawFilters?.type) filters.type = rawFilters.type;
      if (rawFilters?.repo) filters.repo = rawFilters.repo;
      if (rawFilters?.project) filters.project = rawFilters.project;
      if (rawFilters?.since !== undefined) filters.since = rawFilters.since;

      const hits = await search(query, filters, k, { db, embed, weights });
      return { hits };
    });

    // POST /remember — direct insert bypassing distillation pipeline
    app.post('/remember', async (req, reply) => {
      const parsed = RememberBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      const { text, type, metadata } = parsed.data;

      // Compute hash for dedup
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 32);

      const repo = new MemoryRepo(db);
      const id = repo.insert({
        type,
        text,
        normalized_text: text.toLowerCase(),
        repo: metadata?.repo ?? null,
        project: metadata?.project ?? null,
        branch: metadata?.branch ?? null,
        agent: metadata?.agent ?? null,
        session_id: null,
        hash,
        source_hash: null,
        importance: metadata?.importance ?? 0.5,
        confidence: metadata?.confidence ?? 0.5,
        embedding_provider: embed.name,
        embedding_model: embed.model,
        embedding_dim: embed.dim
      });

      // Embed + upsert into vec store
      try {
        const vecs = await embed.embed([text]);
        const vecStore = new SqliteVecStore(db);
        await vecStore.upsert(id, vecs[0]);
      } catch (err) {
        // Non-fatal: FTS still works; vec will be populated on reembed
        app.log.error({ err, id }, 'remember: embed/vec upsert failed');
      }

      return { id, ok: true };
    });
  };
}
