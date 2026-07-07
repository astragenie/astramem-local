/**
 * MCP server instance for astramemory-local.
 *
 * Exposes 15 tools over the Streamable HTTP transport (POST /mcp):
 *   - search_memory      — hybrid FTS + vector search
 *   - recall_memory      — top-K semantic recall (alias of search with k default 5)
 *   - remember           — direct memory insert
 *   - get_health         — daemon health probe
 *   - why_memory         — provenance receipt (evidence, session, transcript ref)
 *   - session_digest     — per-session "what I learned" summary (derived at read time)
 *   - invalidate_memory  — lifecycle: mark a memory invalid (ADR-002 memory_events log)
 *   - supersede_memory   — lifecycle: replace one memory with another
 *   - promote_memory     — lifecycle: upward-only scope promotion (ADR-009)
 *   - restore_memory     — lifecycle: un-archive a memory archived by the W4.4 TTL policy (FEAT-416)
 *   - memory_history     — lifecycle: full event log for a memory (supersession chain)
 *   - mark_memory_used   — ADR-010 explicit recall-used signal for a served memory
 *   - erase_memory       — erasure v1 (ADR-006): hard-delete + tombstone
 *   - list_consolidation_proposals / resolve_consolidation_proposal — stage-9 propose-only queue (ADR-004)
 *
 * No HTTP self-calls: all tools call the internal service layer directly.
 * Auth is enforced at the Fastify route level via the existing preHandler.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
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
import { search, parseAsOf, type SearchFilters } from '../search/search.js';
import { resolveRerankOpts } from '../search/rerank.js';
import { clampScores } from '../server/lib/score-contract.js';
import { defaultConfig, type Config } from '../config/config.js';
import { childLogger } from '../log/logger.js';
import { PKG_VERSION } from '../server/lib/wire-meta.js';
import { redactIfEnabled } from '../redact/index.js';
import { recordRedactionEvents } from '../storage/redaction-log.js';
import { ProjectFilterSchema, AgentFilterSchema, EntityFilterSchema } from '../contracts/recall-filters.js';
// FEAT-429: project/agent/entity arg-parsing derives from the shared
// filter-descriptor registry — see src/contracts/filter-registry.ts.
import { assignStructuredFilterValues } from '../contracts/filter-registry.js';
import { contentHash } from '../storage/content-hash.js';
import { buildWhyReceipt, buildSessionDigest } from '../server/queries/provenance.js';
import {
  ProposalRepo,
  ProposalNotFoundError,
  ProposalAlreadyResolvedError,
} from '../consolidate/proposals.js';
// Canonical cross-repo save-contract unification: `remember`'s type enum and
// the REST POST /remember route (src/server/routes/search.ts) both derive
// from this single source of truth instead of a hand-copied list.
import { MEMORY_TYPES } from '../contracts/memory.js';

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
  // issue #26 / ADR-005: cross-encoder rerank stage — undefined (search()
  // takes zero extra branches) unless crossEncoder.enabled is set.
  const rerank = resolveRerankOpts(cfg);

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
        /** FEAT-423/FEAT-424: canonical recall-filter contract (contracts/schemas/retrieval-query.v1.schema.json). */
        project: ProjectFilterSchema.describe('Filter by project name(s) — string or list (OR)'),
        agent: AgentFilterSchema.describe('Filter by provenance agent/agent_type — string or list (OR)'),
        agentMode: z.enum(['filter', 'boost']).optional().describe("FEAT-426: 'filter' (default) hard-excludes non-matching agents; 'boost' keeps them but ranks agent matches higher (requires search.eta > 0)"),
        entity: EntityFilterSchema.describe(
          'Entity name filter (FEAT-402); resolved via the normalize seam (case/whitespace-insensitive, exact match then substring fallback). Unresolvable names yield zero results.'
        ),
        since: z
          .number()
          .optional()
          .describe('Epoch-ms lower bound on created_at'),
        as_of: z
          .string()
          .optional()
          .describe(
            'ISO-8601 date-time — bitemporal time-travel snapshot (FEAT-401): return memories as they stood at this instant rather than the current snapshot.'
          ),
      }),
    },
    async (args) => {
      const filters: SearchFilters = {};
      if (args.type) filters.type = args.type;
      if (args.repo) filters.repo = args.repo;
      // FEAT-429: project/agent/entity — registry-driven (was 3 hand-rolled lines).
      assignStructuredFilterValues(args, filters as unknown as Record<string, unknown>);
      if (args.agentMode) filters.agentMode = args.agentMode;
      if (args.since !== undefined) filters.since = args.since;
      if (args.as_of !== undefined) {
        try {
          filters.as_of = parseAsOf(args.as_of);
        } catch (err) {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ error: err instanceof Error ? err.message : 'invalid as_of' }) },
            ],
            isError: true,
          };
        }
      }

      const hits = await search(args.query, filters, args.limit ?? 10, {
        db,
        embed,
        weights,
        rerank,
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
            text: JSON.stringify({ hits: clampScores(hits, 'mcp search_memory') }),
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
        /** FEAT-423/FEAT-424: canonical recall-filter contract (contracts/schemas/retrieval-query.v1.schema.json). */
        project: ProjectFilterSchema.describe('Filter by project name(s) — string or list (OR)'),
        agent: AgentFilterSchema.describe('Filter by provenance agent/agent_type — string or list (OR)'),
        agentMode: z.enum(['filter', 'boost']).optional().describe("FEAT-426: 'filter' (default) hard-excludes non-matching agents; 'boost' keeps them but ranks agent matches higher (requires search.eta > 0)"),
        entity: EntityFilterSchema.describe(
          'Entity name filter (FEAT-402); resolved via the normalize seam (case/whitespace-insensitive, exact match then substring fallback). Unresolvable names yield zero results.'
        ),
        since: z
          .number()
          .optional()
          .describe('Epoch-ms lower bound on created_at'),
        as_of: z
          .string()
          .optional()
          .describe(
            'ISO-8601 date-time — bitemporal time-travel snapshot (FEAT-401): return memories as they stood at this instant rather than the current snapshot.'
          ),
      }),
    },
    async (args) => {
      const filters: SearchFilters = {};
      if (args.type) filters.type = args.type;
      if (args.repo) filters.repo = args.repo;
      // FEAT-429: project/agent/entity — registry-driven (was 3 hand-rolled lines).
      assignStructuredFilterValues(args, filters as unknown as Record<string, unknown>);
      if (args.agentMode) filters.agentMode = args.agentMode;
      if (args.since !== undefined) filters.since = args.since;
      if (args.as_of !== undefined) {
        try {
          filters.as_of = parseAsOf(args.as_of);
        } catch (err) {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ error: err instanceof Error ? err.message : 'invalid as_of' }) },
            ],
            isError: true,
          };
        }
      }

      const hits = await search(args.query, filters, args.k ?? 5, {
        db,
        embed,
        weights,
        rerank,
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
            text: JSON.stringify({ hits: clampScores(hits, 'mcp recall_memory') }),
          },
        ],
      };
    }
  );

  // ---- remember ------------------------------------------------------------
  // Canonical cross-repo save-contract (thin wrapper): a superset shared
  // with cloud `memory_save`. Local honors every field its storage backs
  // (content/type/scope/tags*/importance/confidence/evidence/project/agent/
  // session) and NEVER silently drops what it can't store — decisionJson/
  // reviewJson (cloud-only) and tags (no `memories.tags` column/table
  // exists locally today) are accepted, the memory is still saved, and each
  // supplied unsupported field is named back in the response's
  // `unsupported_fields` array.
  server.registerTool(
    'remember',
    {
      description:
        'Directly insert a memory into the store, bypassing the distillation pipeline. ' +
        'Accepts the canonical cross-repo save contract shared with cloud memory_save; ' +
        'fields astramem-local cannot store are echoed back in `unsupported_fields`, never silently dropped.',
      inputSchema: z.object({
        // Canonical field name (shared with cloud memory_save). `text` is a
        // deprecated one-release alias, mapped onto `content` when absent.
        content: z.string().min(1).optional().describe('Memory text to store (canonical name)'),
        text: z.string().min(1).optional().describe('DEPRECATED alias for `content` — prefer `content`.'),
        type: z.enum(MEMORY_TYPES).describe('Memory type — canonical 10-value union (ADR D4)'),
        /** ADR-009 scope. remember() is a born-at-scope path: any value
         *  (including team/org) is inserted directly, NOT routed through
         *  promote_memory's upward-only transition. */
        scope: z
          .enum(['private', 'team', 'org'])
          .optional()
          .describe("ADR-009 scope. Defaults to 'private'. team/org insert directly — no promote step required."),
        /** Canonical cloud field (tags: string[]) with no local storage
         *  backing today. Accepted but not persisted — see `unsupported_fields`. */
        tags: z
          .array(z.string())
          .optional()
          .describe('Free-form tags (cloud canonical field). Not stored locally today — echoed in `unsupported_fields` if supplied.'),
        importance: z.number().min(0).max(1).optional(),
        confidence: z.number().min(0).max(1).optional(),
        evidence: z.string().min(1).optional().describe('Free-text excerpt supporting the atom (ADR-001 provenance).'),
        // Flat canonical aliases — take priority over the deprecated nested
        // `metadata` object below when both are supplied.
        projectId: z.string().optional().describe('Flat canonical alias for metadata.project'),
        agentId: z.string().optional().describe('Flat canonical alias for metadata.agent'),
        sessionId: z.string().optional().describe('Flat canonical alias for the memory session_id'),
        /** Cloud-only attachments. Never stored locally — the memory is
         *  still saved, and each supplied field is echoed in `unsupported_fields`. */
        decisionJson: z.unknown().optional().describe('Cloud-only: decision record payload. Not stored locally.'),
        reviewJson: z.unknown().optional().describe('Cloud-only: review record payload. Not stored locally.'),
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
          .describe('DEPRECATED nested metadata form — prefer the flat top-level fields.'),
      }).refine((v) => (v.content ?? v.text) !== undefined, {
        message: 'content (or deprecated `text` alias) is required',
        path: ['content'],
      }),
    },
    async (args) => {
      const { type, metadata } = args;
      // refine() above guarantees at least one of content/text is present.
      const rawContent = args.content ?? args.text!;

      // Stage-0 secret redaction (SEC-3/5, OQ-2) — same choke point as
      // POST /remember, applied before persistence AND before the embed call.
      const { text, events: redactionEvents } = redactIfEnabled(rawContent, cfg);
      recordRedactionEvents(db, redactionEvents, null);

      const hash = contentHash(text);

      const repo = new MemoryRepo(db);
      const events = new MemoryEventRepo(db);
      const { id } = repo.insertWithCreateEvent({
        type,
        text,
        normalized_text: text.toLowerCase(),
        repo: metadata?.repo ?? null,
        // Flat canonical alias wins over the deprecated nested form when both are present.
        project: args.projectId ?? metadata?.project ?? null,
        branch: metadata?.branch ?? null,
        agent: args.agentId ?? metadata?.agent ?? null,
        session_id: args.sessionId ?? null,
        hash,
        source_hash: null,
        importance: args.importance ?? metadata?.importance ?? 0.5,
        confidence: args.confidence ?? metadata?.confidence ?? 0.5,
        embedding_provider: embed.name,
        embedding_model: embed.model,
        embedding_dim: embed.dim,
        evidence: args.evidence ?? null,
        // Born-at-scope insert — MemoryRepo defaults undefined to 'private'.
        scope: args.scope,
      }, events);

      // Embed + upsert into vec store (non-fatal on failure)
      try {
        const vecs = await embed.embed([text]);
        const vecStore = new SqliteVecStore(db, embed.dim);
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

      // Canonical-save-contract fields with no local storage backing: never
      // silently dropped — the memory above is still saved, and every
      // supplied field of this kind is named here so the caller knows it
      // wasn't persisted.
      const unsupportedFields: string[] = [];
      if (args.tags !== undefined) unsupportedFields.push('tags');
      if (args.decisionJson !== undefined) unsupportedFields.push('decisionJson');
      if (args.reviewJson !== undefined) unsupportedFields.push('reviewJson');

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              unsupportedFields.length > 0
                ? { id, ok: true, unsupported_fields: unsupportedFields }
                : { id, ok: true }
            ),
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
      const receipt = buildWhyReceipt(db, args.id);
      if (!receipt) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', id: args.id }) }],
          isError: true,
        };
      }
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
      } else {
        // FEAT-417a harmonization: an explicit, unknown session_id errors here
        // too (REST route semantics win) instead of silently returning an
        // empty "ready" digest — buildSessionDigest() never verifies the
        // session itself exists (see its own doc comment).
        const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
        if (!session) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', session_id: sessionId }) }],
            isError: true,
          };
        }
      }
      const digest = buildSessionDigest(db, sessionId);
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
      description: 'Promote a memory\'s scope upward — private -> team -> org (ADR-009). Downward/same-scope requests error.',
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

  // ---- restore_memory ---------------------------------------------------------
  server.registerTool(
    'restore_memory',
    {
      description: 'Un-archive a memory previously archived by the W4.4 TTL policy or a manual archive event. Appends a restore event to the memory_events log.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Memory id to restore'),
      }),
    },
    async (args) => {
      const events = new MemoryEventRepo(db);
      try {
        events.restore(args.id);
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
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not archived', id: args.id }) }],
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

  // ---- erase_memory ---------------------------------------------------------
  server.registerTool(
    'erase_memory',
    {
      description:
        'Erasure v1 (ADR-006): PERMANENTLY hard-delete a memory (text unrecoverable) leaving only a ' +
        'tombstone event. The tombstone blocks re-distillation from resurrecting it and ships to the ' +
        'cloud ledger for team/org-scoped memories. Prefer invalidate_memory unless deletion is required.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Memory id to erase'),
        reason: z.string().optional().describe('Why (recorded in the tombstone payload, counts only)'),
      }),
    },
    async (args) => {
      const eventsRepo = new MemoryEventRepo(db);
      try {
        eventsRepo.erase(args.id, args.reason);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, id: args.id }) }] };
      } catch (err) {
        if (err instanceof MemoryNotFoundError) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', id: args.id }) }],
            isError: true,
          };
        }
        throw err;
      }
    }
  );

  // ---- list_consolidation_proposals ----------------------------------------
  server.registerTool(
    'list_consolidation_proposals',
    {
      description:
        'Pending (or resolved) consolidation proposals from the stage-9 pass (ADR-004): borderline ' +
        'near-duplicate pairs awaiting an explicit merge/keep decision. Nothing is changed until a ' +
        'proposal is resolved via resolve_consolidation_proposal.',
      inputSchema: z.object({
        status: z.enum(['pending', 'accepted', 'rejected']).default('pending').describe('Filter by status'),
      }),
    },
    async (args) => {
      const proposals = new ProposalRepo(db).list(args.status);
      const memRepo = new MemoryRepo(db);
      const enriched = proposals.map(p => ({
        ...p,
        winner_text: memRepo.get(p.winner_id)?.text ?? null,
        loser_text: memRepo.get(p.loser_id)?.text ?? null,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ proposals: enriched }) }] };
    }
  );

  // ---- resolve_consolidation_proposal ---------------------------------------
  server.registerTool(
    'resolve_consolidation_proposal',
    {
      description:
        'Accept or reject a pending consolidation proposal. Accept executes the non-destructive ' +
        'merge-as-supersede (loser kept as superseded, winner gains derived_from lineage); reject ' +
        'keeps both memories untouched.',
      inputSchema: z.object({
        id: z.string().min(1).describe('Proposal id'),
        action: z.enum(['accept', 'reject']).describe('Resolution'),
      }),
    },
    async (args) => {
      const repo = new ProposalRepo(db);
      try {
        const resolved = args.action === 'accept' ? repo.accept(args.id) : repo.reject(args.id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, proposal: resolved }) }] };
      } catch (err) {
        if (err instanceof ProposalNotFoundError) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', id: args.id }) }],
            isError: true,
          };
        }
        if (
          err instanceof ProposalAlreadyResolvedError ||
          err instanceof MemoryNotFoundError ||
          err instanceof MemoryConflictError
        ) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message, id: args.id }) }],
            isError: true,
          };
        }
        throw err;
      }
    }
  );

  return server;
}
