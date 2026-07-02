/**
 * MCP server instance for astramemory-local.
 *
 * Exposes 11 tools over the Streamable HTTP transport (POST /mcp):
 *   - search_memory      — hybrid FTS + vector search
 *   - recall_memory      — top-K semantic recall (alias of search with k default 5)
 *   - remember           — direct memory insert
 *   - get_health         — daemon health probe
 *   - why_memory         — provenance receipt (evidence, session, transcript ref)
 *   - session_digest     — per-session "what I learned" summary (derived at read time)
 *   - invalidate_memory  — lifecycle: mark a memory invalid (ADR-002 memory_events log)
 *   - supersede_memory   — lifecycle: replace one memory with another
 *   - promote_memory     — lifecycle: upward-only scope promotion (ADR-009)
 *   - memory_history     — lifecycle: full event log for a memory (supersession chain)
 *   - mark_memory_used   — ADR-010 explicit recall-used signal for a served memory
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
import {
  MemoryEventRepo,
  MemoryNotFoundError,
  MemoryConflictError,
  InvalidScopeTransitionError,
} from '../storage/memory-events.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';
import { recordRecallServed, recordRecallUsed } from '../storage/usefulness.js';
import { search, type SearchFilters } from '../search/search.js';
import { defaultConfig, type Config } from '../config/config.js';
import { childLogger } from '../log/logger.js';
import { PKG_VERSION } from '../server/lib/wire-meta.js';
import { redactIfEnabled } from '../redact/index.js';
import { recordRedactionEvents } from '../storage/redaction-log.js';

export interface McpServerDeps {
  db: DB;
  embed: EmbedProvider;
  config?: Config;
}

/**
 * Build and return a configured McpServer instance.
 * Caller is responsible for connecting it to a transport.
 */
export function buildMcpServer(deps: McpServerDeps): McpServer {
  const { db, embed } = deps;
  const cfg = deps.config ?? defaultConfig();
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
      // ADR-010: recall-usefulness capture — measure only, does not feed ranking (v1).
      recordRecallServed(db, {
        query: args.query,
        atomIds: hits.map(h => h.id),
        scores: hits.map(h => h.score),
        surface: 'mcp',
        mode: 'search',
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
      // ADR-010: recall-usefulness capture — measure only, does not feed ranking (v1).
      recordRecallServed(db, {
        query: args.query,
        atomIds: hits.map(h => h.id),
        scores: hits.map(h => h.score),
        surface: 'mcp',
        mode: 'recall',
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
      const { type, metadata } = args;

      // Stage-0 secret redaction (SEC-3/5, OQ-2) — same choke point as
      // POST /remember, applied before persistence AND before the embed call.
      const { text, events: redactionEvents } = redactIfEnabled(args.text, cfg);
      recordRedactionEvents(db, redactionEvents, null);

      const hash = createHash('sha256').update(text).digest('hex').slice(0, 32);

      const repo = new MemoryRepo(db);
      const events = new MemoryEventRepo(db);
      const { id } = repo.insertWithCreateEvent({
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
      }, events);

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

  // ---- why_memory ----------------------------------------------------------
  server.registerTool(
    'why_memory',
    {
      description:
        'Provenance receipt for a memory: evidence excerpt, source session, transcript ref. Answers: why do I remember this?',
      inputSchema: z.object({
        id: z.string().min(1).describe('Memory id'),
      }),
    },
    async (args) => {
      const memRepo = new MemoryRepo(db);
      const memory = memRepo.get(args.id);
      if (!memory) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', id: args.id }) }],
          isError: true,
        };
      }
      let session: unknown = null;
      if (memory.session_id) {
        session = db
          .prepare('SELECT id, repo, branch, agent, started_at FROM sessions WHERE id = ?')
          .get(memory.session_id) ?? null;
      }
      const receipt = {
        id: memory.id, type: memory.type, text: memory.text,
        importance: memory.importance, confidence: memory.confidence,
        evidence: memory.evidence, session,
        transcript_ref: memory.source_hash, created_at: memory.created_at,
        history: new MemoryEventRepo(db).listForAtom(args.id),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(receipt) }] };
    }
  );

  // ---- session_digest ------------------------------------------------------
  server.registerTool(
    'session_digest',
    {
      description:
        'What I learned this session: per-type counts + texts of memories formed. Defaults to the latest session.',
      inputSchema: z.object({
        session_id: z.string().optional().describe('Session id; defaults to most recent session'),
      }),
    },
    async (args) => {
      let sessionId = args.session_id;
      if (!sessionId) {
        const latest = db
          .prepare('SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1')
          .get() as { id: string } | undefined;
        if (!latest) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'no sessions recorded' }) }],
            isError: true,
          };
        }
        sessionId = latest.id;
      }
      const activeJob = db.prepare(`
        SELECT id FROM jobs
        WHERE kind = 'distill' AND state IN ('pending', 'running')
          AND json_extract(payload_json, '$.session_id') = ?
        LIMIT 1
      `).get(sessionId);
      const rows = db.prepare(
        'SELECT id, type, text FROM memories WHERE session_id = ? ORDER BY created_at ASC'
      ).all(sessionId) as Array<{ id: string; type: string; text: string }>;
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.type] = (counts[r.type] ?? 0) + 1;
      const digest = {
        session_id: sessionId,
        status: activeJob ? 'pending' : 'ready',
        counts,
        memories: rows,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(digest) }] };
    }
  );

  // ---- invalidate_memory ----------------------------------------------------
  server.registerTool(
    'invalidate_memory',
    {
      description: 'Mark a memory invalid (soft delete). Appends an invalidate event to the memory_events log.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Memory id to invalidate'),
        reason: z.string().optional().describe('Optional reason for invalidation'),
      }),
    },
    async (args) => {
      const events = new MemoryEventRepo(db);
      try {
        events.invalidate(args.id, args.reason);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id: args.id }) }] };
      } catch (err) {
        if (err instanceof MemoryNotFoundError) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', id: args.id }) }],
            isError: true,
          };
        }
        if (err instanceof MemoryConflictError) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'already invalid', id: args.id }) }],
            isError: true,
          };
        }
        throw err;
      }
    }
  );

  // ---- supersede_memory ------------------------------------------------------
  server.registerTool(
    'supersede_memory',
    {
      description: 'Replace an old memory with a new one: invalidates old_id and links it to new_id via the memory_events log.',
      inputSchema: z.object({
        old_id: z.string().min(1).describe('Memory id being superseded'),
        new_id: z.string().min(1).describe('Memory id that replaces old_id'),
      }),
    },
    async (args) => {
      const events = new MemoryEventRepo(db);
      try {
        events.supersede(args.old_id, args.new_id);
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ ok: true, old_id: args.old_id, new_id: args.new_id }) },
          ],
        };
      } catch (err) {
        if (err instanceof MemoryNotFoundError) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', id: err.atomId }) }],
            isError: true,
          };
        }
        if (err instanceof MemoryConflictError) {
          if (err.message.includes('must be valid to supersede')) {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({ error: 'invalid new_id', new_id: args.new_id }) }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'already invalid', id: args.old_id }) }],
            isError: true,
          };
        }
        throw err;
      }
    }
  );

  // ---- promote_memory ---------------------------------------------------------
  server.registerTool(
    'promote_memory',
    {
      description: 'Promote a memory\'s scope upward — personal -> team -> org (ADR-009). Downward/same-scope requests error.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Memory id to promote'),
        scope: z.enum(['team', 'org']).describe('Target scope; must be upward from the memory\'s current scope'),
      }),
    },
    async (args) => {
      const events = new MemoryEventRepo(db);
      try {
        events.promoteScope(args.id, args.scope);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id: args.id, scope: args.scope }) }],
        };
      } catch (err) {
        if (err instanceof MemoryNotFoundError) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', id: args.id }) }],
            isError: true,
          };
        }
        if (err instanceof InvalidScopeTransitionError) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message, id: args.id }) }],
            isError: true,
          };
        }
        throw err;
      }
    }
  );

  // ---- memory_history -----------------------------------------------------
  server.registerTool(
    'memory_history',
    {
      description: 'Full memory_events log for a memory, in append order — the supersession/invalidation/promotion chain.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Memory id'),
      }),
    },
    async (args) => {
      const memRepo = new MemoryRepo(db);
      const memory = memRepo.get(args.id);
      if (!memory) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', id: args.id }) }],
          isError: true,
        };
      }
      const events = new MemoryEventRepo(db).listForAtom(args.id);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ id: args.id, events }) }] };
    }
  );

  // ---- mark_memory_used -----------------------------------------------------
  server.registerTool(
    'mark_memory_used',
    {
      description:
        'ADR-010 explicit recall-used signal: tell astramemory a previously-served memory actually ' +
        'mattered in this turn. This is the explicit feedback channel — heuristic client-side ' +
        'detection (content referenced in a later turn) is separate adapter work, out of scope here. ' +
        'v1: feeds the recall-usefulness rate on doctor/dashboard/health only, does not affect ranking.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Memory id that was useful'),
        note: z.string().optional().describe('Optional free-text note (not persisted — reserved for future use)'),
      }),
    },
    async (args) => {
      const memRepo = new MemoryRepo(db);
      const memory = memRepo.get(args.id);
      if (!memory) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', id: args.id }) }],
          isError: true,
        };
      }
      recordRecallUsed(db, { atomId: args.id, surface: 'mcp', signal: 'explicit' });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id: args.id }) }] };
    }
  );

  return server;
}
