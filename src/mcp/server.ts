/**
 * MCP server instance for astramemory-local.
 *
 * Exposes 4 tools over the Streamable HTTP transport (POST /mcp):
 *   - search_memory  — hybrid FTS + vector search
 *   - recall_memory  — top-K semantic recall (alias of search with k default 5)
 *   - remember       — direct memory insert
 *   - get_health     — daemon health probe
 *
 * No HTTP self-calls: all tools call the internal service layer directly.
 * Auth is enforced at the Fastify route level via the existing preHandler.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { DB } from '../storage/db.js';
import type { EmbedProvider } from '../contracts/index.js';
import { MemoryRepo } from '../storage/memories.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';
import { search, type SearchFilters } from '../search/search.js';
import { defaultConfig } from '../config/config.js';
import { childLogger } from '../log/logger.js';
import { PKG_VERSION } from '../server/lib/wire-meta.js';

export interface McpServerDeps {
  db: DB;
  embed: EmbedProvider;
}

/**
 * Build and return a configured McpServer instance.
 * Caller is responsible for connecting it to a transport.
 */
export function buildMcpServer(deps: McpServerDeps): McpServer {
  const { db, embed } = deps;
  const cfg = defaultConfig();
  const weights = cfg.search;

  const server = new McpServer(
    { name: 'astramemory-local', version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );

  // ---- search_memory -------------------------------------------------------
  server.registerTool(
    'search_memory',
    {
      description:
        'Hybrid FTS + vector search over stored memories. Returns ranked hits.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Search query text'),
        limit: z.number().int().positive().max(100).default(10).describe('Max results'),
        type: z
          .array(z.enum(['decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event']))
          .optional()
          .describe('Filter by memory type'),
        repo: z.string().optional().describe('Filter by repo name'),
        project: z.string().optional().describe('Filter by project name'),
        since: z
          .number()
          .optional()
          .describe('Epoch-ms lower bound on created_at'),
      }),
    },
    async (args) => {
      const filters: SearchFilters = {};
      if (args.type) filters.type = args.type;
      if (args.repo) filters.repo = args.repo;
      if (args.project) filters.project = args.project;
      if (args.since !== undefined) filters.since = args.since;

      const hits = await search(args.query, filters, args.limit ?? 10, {
        db,
        embed,
        weights,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ hits }),
          },
        ],
      };
    }
  );

  // ---- recall_memory -------------------------------------------------------
  server.registerTool(
    'recall_memory',
    {
      description:
        'Top-K semantic recall over stored memories. Alias of search_memory with k default 5.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Query text for semantic recall'),
        k: z.number().int().positive().max(100).default(5).describe('Number of results'),
        type: z
          .array(z.enum(['decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event']))
          .optional()
          .describe('Filter by memory type'),
        repo: z.string().optional().describe('Filter by repo name'),
        project: z.string().optional().describe('Filter by project name'),
        since: z
          .number()
          .optional()
          .describe('Epoch-ms lower bound on created_at'),
      }),
    },
    async (args) => {
      const filters: SearchFilters = {};
      if (args.type) filters.type = args.type;
      if (args.repo) filters.repo = args.repo;
      if (args.project) filters.project = args.project;
      if (args.since !== undefined) filters.since = args.since;

      const hits = await search(args.query, filters, args.k ?? 5, {
        db,
        embed,
        weights,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ hits }),
          },
        ],
      };
    }
  );

  // ---- remember ------------------------------------------------------------
  server.registerTool(
    'remember',
    {
      description:
        'Directly insert a memory into the store, bypassing the distillation pipeline.',
      inputSchema: z.object({
        text: z.string().min(1).describe('Memory text to store'),
        type: z
          .enum(['decision', 'fact', 'lesson', 'command', 'todo', 'note', 'event'])
          .describe('Memory type'),
        metadata: z
          .object({
            repo: z.string().optional(),
            project: z.string().optional(),
            branch: z.string().optional(),
            agent: z.string().optional(),
            importance: z.number().min(0).max(1).optional(),
            confidence: z.number().min(0).max(1).optional(),
          })
          .optional()
          .describe('Optional metadata fields'),
      }),
    },
    async (args) => {
      const { text, type, metadata } = args;
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
        embedding_dim: embed.dim,
      });

      // Embed + upsert into vec store (non-fatal on failure)
      try {
        const vecs = await embed.embed([text]);
        const vecStore = new SqliteVecStore(db);
        if (!vecs[0]) throw new Error('embed provider returned empty result');
        await vecStore.upsert(id, vecs[0]);
      } catch (err) {
        childLogger({}).warn(
          {
            error_message:
              err instanceof Error ? err.message : String(err),
            id,
          },
          'mcp remember: embed/vec upsert failed'
        );
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ id, ok: true }),
          },
        ],
      };
    }
  );

  // ---- get_health ----------------------------------------------------------
  server.registerTool(
    'get_health',
    {
      description: 'Returns daemon health status and version.',
      inputSchema: z.object({}),
    },
    async () => {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, version: PKG_VERSION }),
          },
        ],
      };
    }
  );

  return server;
}
