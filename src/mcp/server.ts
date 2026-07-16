/**
 * MCP server instance for astramemory-local.
 *
 * Canonical tool-name SoT: contracts/manifests/mcp-tools.v1.json (U5,
 * astragenie/memory#671, astragenie/astramem-local#120) — cross-repo
 * cross-check lives in tests/contracts/mcp-tool-manifest-parity.test.ts. The
 * list below is a human-readable summary kept in sync by that test, not a
 * second SoT.
 *
 * Exposes the following tools over the Streamable HTTP transport (POST /mcp).
 * The count is not restated here — it drifts the moment a tool is added and
 * nothing catches it. The actual count is enforced by two tests that read it
 * from the wire, not from a maintained number:
 *   - tests/mcp/server.test.ts (compares tools/list against this file's own
 *     cross-repo manifest, contracts/manifests/mcp-tools.v1.json)
 *   - tests/contracts/mcp-tool-manifest-parity.test.ts (full name-level
 *     parity between that manifest and tools/list)
 *   - search_memory      — hybrid FTS + vector search
 *   - recall_memory      — top-K semantic recall (alias of search with k default 15)
 *   - remember           — direct memory insert
 *   - get_health         — daemon health probe
 *   - why_memory         — provenance receipt (evidence, session, transcript ref)
 *   - session_digest     — per-session "what I learned" summary (derived at read time)
 *   - agent_profile      — per-agent "what has this agent learned" summary (derived at read time)
 *   - user_profile       — daemon-wide "what does this owner keep coming back to" summary (FEAT-451, derived at read time)
 *   - get_entity_related — FEAT-481 SLICE-3: entity-to-entity relations (subject/object/both, bitemporal as_of), field-for-field parity with cloud's EntityTools.cs
 *   - get_entity_timeline — FEAT-481 SLICE-3: memories mentioning an entity, newest-first, optional since (epoch-ms) lower bound
 *   - invalidate_memory  — lifecycle: mark a memory invalid (ADR-002 memory_events log)
 *   - supersede_memory   — lifecycle: replace one memory with another
 *   - promote_memory     — lifecycle: upward-only scope promotion (ADR-009)
 *   - restore_memory     — lifecycle: un-archive a memory archived by the W4.4 TTL policy (FEAT-416)
 *   - memory_history     — lifecycle: full event log for a memory (supersession chain)
 *   - submit_feedback    — ADR-010 explicit recall-used signal for a served memory (U5 canonical name)
 *   - mark_memory_used   — DEPRECATED one-release alias for submit_feedback (U5 collapse), same handler
 *   - erase_memory       — erasure v1 (ADR-006): hard-delete + tombstone
 *   - list_consolidation_proposals / resolve_consolidation_proposal — stage-9 propose-only queue
 *     (ADR-004): 'merge' near-duplicates and FEAT-456 judge-flagged 'contradiction' pairs, both
 *     resolved identically (accept = merge-as-supersede, reject = no-op)
 *
 * FEAT-442 (autonomous consolidation auto-accept + reversal primitive) ships
 * REST-only this slice: `POST /memory/:id/unsupersede`
 * (src/server/routes/lifecycle.ts). No MCP tool is added here — this
 * manifest is a parity-CI-gated SoT (see header above), so a new tool name
 * is a bigger-than-trivial change; mirroring `unsupersede` to MCP is a
 * follow-up, not dropped scope.
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
// FEAT-481 SLICE-3: get_entity_related / get_entity_timeline read surface.
import { EntityRepo } from '../storage/entities.js';
import { EntityRelationRepo } from '../storage/entity-relations.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';
import { JobRepo } from '../pipeline/job-repo.js';
import { recordRecallServed, recordRecallUsed } from '../storage/usefulness.js';
import { search, parseAsOf, type SearchFilters } from '../search/search.js';
import { resolveRerankOpts } from '../search/rerank.js';
import { resolveDecomposeOpts } from '../search/decompose.js';
import { buildLLMProvider } from '../providers/index.js';
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
// FEAT-454: named retrieval preset — routing over existing fusion
// weights/filters, never a new scoring path. See src/search/presets.ts.
import {
  RETRIEVAL_PRESETS,
  resolvePresetWeights,
  validatePresetFilters,
  PresetValidationError,
  type RetrievalPreset,
} from '../search/presets.js';
import { contentHash } from '../storage/content-hash.js';
import { buildWhyReceipt, buildSessionDigest } from '../server/queries/provenance.js';
import { buildAgentProfile } from '../server/queries/agent-profile.js';
import { buildUserProfile } from '../server/queries/user-profile.js';
import {
  ProposalRepo,
  ProposalNotFoundError,
  ProposalAlreadyResolvedError,
  parseContradictionMetadata,
} from '../consolidate/proposals.js';

/** #372: cap on how many PENDING proposals a single
 *  `resolve_consolidation_proposals_batch` call will resolve — each is a
 *  cheap synchronous DB transaction (no LLM/embed call in the accept/reject
 *  path), so this exists to bound response size and give an LLM caller a
 *  predictable "call again if `remaining` is nonzero" loop rather than one
 *  call trying to serialize a 768-row backlog's worth of skip reasons. */
const MAX_BATCH_RESOLVE = 200;
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
  // FEAT-454: renamed from `weights` — this is now the per-preset BASE, not
  // the final weights object. `resolvePresetWeights` (src/search/presets.ts)
  // derives the actual per-call weights from this base, once per tool call.
  const baseWeights = cfg.search;
  // issue #26 / ADR-005: cross-encoder rerank stage — undefined (search()
  // takes zero extra branches) unless crossEncoder.enabled is set.
  const rerank = resolveRerankOpts(cfg);
  // WS6: multi-hop query decomposition — undefined unless multiHop.enabled
  // is set. See src/search/decompose.ts.
  const decompose = resolveDecomposeOpts(cfg, buildLLMProvider);

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
        // Default 15: full-suite LoCoMo k-sweep (n=1986, dual-pass) showed
        // recall depth 10->15 lifts overall F1 0.5537->0.5673 (+1.4), the
        // best value point before diminishing returns/token cost (k=20 only
        // +0.4 more, k=25 +0.25 with category erosion). See the 2026-07-14
        // k-sweep handoff under .claude/artifacts/crew/.
        limit: z.number().int().positive().max(100).default(15).describe('Max results'),
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
        preset: z
          .enum(RETRIEVAL_PRESETS)
          .optional()
          .describe(
            "FEAT-454: named retrieval preset routing over existing capability, not a new scoring path. " +
            "'default' (or omitted): today's fusion weights, unchanged. 'recent': boosts freshness so newer " +
            "memories rank higher. 'exact': boosts BM25 so literal term matches dominate over semantic " +
            "similarity. 'entity': requires the entity filter to also be supplied (400 otherwise). " +
            "'temporal': requires the as_of filter to also be supplied (400 otherwise)."
          ),
      }),
    },
    async (args) => {
      const filters: SearchFilters = {};
      if (args.type) filters.type = args.type;
      // FEAT-429: project/agent/entity/repo/since — registry-driven (was 5 hand-rolled lines).
      assignStructuredFilterValues(args, filters as unknown as Record<string, unknown>);
      if (args.agentMode) filters.agentMode = args.agentMode;
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
      // FEAT-454: named retrieval preset. Omitted = 'default', byte-identical
      // to pre-FEAT-454 behavior (AC-1).
      const preset: RetrievalPreset = args.preset ?? 'default';
      try {
        validatePresetFilters(preset, filters);
      } catch (err) {
        if (err instanceof PresetValidationError) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
      const weights = resolvePresetWeights(preset, baseWeights);

      const hits = await search(args.query, filters, args.limit ?? 15, {
        db,
        embed,
        weights,
        rerank,
        decompose,
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
        'Top-K semantic recall over stored memories. Alias of search_memory with k default 15.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Query text for semantic recall'),
        // Default 15: see the search_memory `limit` note — LoCoMo full-suite
        // k-sweep put the value/cost sweet spot at 15 (was 5).
        k: z.number().int().positive().max(100).default(15).describe('Number of results'),
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
        preset: z
          .enum(RETRIEVAL_PRESETS)
          .optional()
          .describe(
            "FEAT-454: named retrieval preset routing over existing capability, not a new scoring path. " +
            "'default' (or omitted): today's fusion weights, unchanged. 'recent': boosts freshness so newer " +
            "memories rank higher. 'exact': boosts BM25 so literal term matches dominate over semantic " +
            "similarity. 'entity': requires the entity filter to also be supplied (400 otherwise). " +
            "'temporal': requires the as_of filter to also be supplied (400 otherwise)."
          ),
      }),
    },
    async (args) => {
      const filters: SearchFilters = {};
      if (args.type) filters.type = args.type;
      // FEAT-429: project/agent/entity/repo/since — registry-driven (was 5 hand-rolled lines).
      assignStructuredFilterValues(args, filters as unknown as Record<string, unknown>);
      if (args.agentMode) filters.agentMode = args.agentMode;
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
      // FEAT-454: named retrieval preset. Omitted = 'default', byte-identical
      // to pre-FEAT-454 behavior (AC-1).
      const preset: RetrievalPreset = args.preset ?? 'default';
      try {
        validatePresetFilters(preset, filters);
      } catch (err) {
        if (err instanceof PresetValidationError) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }],
            isError: true,
          };
        }
        throw err;
      }
      const weights = resolvePresetWeights(preset, baseWeights);

      const hits = await search(args.query, filters, args.k ?? 15, {
        db,
        embed,
        weights,
        rerank,
        decompose,
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

      // Embed + upsert into vec store (non-fatal on failure — the memory is
      // already durably saved above). `vecIndexed` surfaces the degraded
      // state in the response below instead of swallowing it. Issue #209:
      // that response field used to be the only record of the failure —
      // nothing durable, nothing retried. Now a failure also marks
      // needs_vec_index on the row and enqueues a `reembed` job, so the
      // memory self-heals via the worker instead of waiting on an operator
      // to notice and run `rebuild`/`reembed-dim`.
      let vecIndexed = true;
      try {
        const vecs = await embed.embed([text]);
        const vecStore = new SqliteVecStore(db, embed.dim);
        if (!vecs[0]) throw new Error('embed provider returned empty result');
        await vecStore.upsert(id, vecs[0]);
      } catch (err) {
        vecIndexed = false;
        repo.markNeedsVecIndex(id);
        try {
          new JobRepo(db).enqueue('reembed', { kind: 'reembed', memory_id: id });
        } catch (enqueueErr) {
          childLogger({}).warn(
            { error_message: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr), id },
            'mcp remember: retry-job enqueue failed after vec upsert failure — needs_vec_index still set, cleanup sweep will catch it',
          );
        }
        childLogger({}).warn(
          {
            error_message:
              err instanceof Error ? err.message : String(err),
            id,
          },
          'mcp remember: embed/vec upsert failed — memory saved but NOT vector-indexed; needs_vec_index set, reembed job enqueued'
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

      const resultBody: { id: string; ok: true; unsupported_fields?: string[]; vec_indexed?: false } = { id, ok: true };
      if (unsupportedFields.length > 0) resultBody.unsupported_fields = unsupportedFields;
      if (!vecIndexed) resultBody.vec_indexed = false;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(resultBody),
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
        'What I learned this session: per-type counts + texts of memories formed, plus a ' +
        'pending_contradictions count (FEAT-456) for judge-flagged conflicts touching this session\'s ' +
        'memories, awaiting resolution via list/resolve_consolidation_proposal. Defaults to the latest session.',
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

  // ---- agent_profile ---------------------------------------------------------
  server.registerTool(
    'agent_profile',
    {
      description:
        'Read-time synthesized per-agent profile — "what has this agent learned": top lessons ' +
        '(ranked by the ADR-010 usefulness signal, then importance), recent decisions, prior ' +
        'corrections (memories this agent wrote that were later invalidated/superseded), and ' +
        'per-type memory counts. Every entry carries a memory id that composes with why_memory.',
      inputSchema: z.object({
        agent: z.string().min(1).describe('Agent value to look up (memories.agent)'),
      }),
    },
    async (args) => {
      const profile = buildAgentProfile(db, args.agent);
      if (!profile) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', agent: args.agent }) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(profile) }] };
    }
  );

  // ---- user_profile -----------------------------------------------------
  server.registerTool(
    'user_profile',
    {
      description:
        'Read-time synthesized daemon-wide profile — "what does this owner keep coming back to": ' +
        'standing facts, preferences, recurring lessons (each ranked by the ADR-010 usefulness ' +
        'signal, then importance), recent decisions, and known entities. No agent filter — this ' +
        'is the whole daemon\'s profile, not a per-agent one (see agent_profile for that). Every ' +
        'entry carries a memory id that composes with why_memory.',
      inputSchema: z.object({
        scope: z
          .enum(['private', 'team', 'org', 'all'])
          .optional()
          .describe('Scope filter, defaults to "private" (ADR-009 default). "all" removes the scope filter entirely.'),
      }),
    },
    async (args) => {
      // args.scope is already constrained to the enum by inputSchema (the
      // SDK rejects an out-of-enum value before this handler runs) — no
      // runtime re-check needed here, unlike the REST route which parses an
      // untyped query string.
      const profile = buildUserProfile(db, args.scope ?? 'private');
      return { content: [{ type: 'text' as const, text: JSON.stringify(profile) }] };
    }
  );

  // ---- get_entity_related ---------------------------------------------------
  // FEAT-481 SLICE-3 (design doc §4.1). Field names mirror cloud's shipped
  // get_entity_related (src/AstraMemory.Mcp/Tools/EntityTools.cs:67-143)
  // byte-for-byte: predicate/evidence_memory_id, not relation_type/
  // source_memory_id — zero client-side mapping needed to speak to either.
  // Storage layer (EntityRelationRepo.getForEntity, entity-relations.ts)
  // already implements the JOIN-with-memories effective-validity contract
  // (§4.1) that makes a relation sourced from an invalidate()d memory stop
  // reading as valid past that memory's own valid_to.
  server.registerTool(
    'get_entity_related',
    {
      description:
        'Entity relationships (bitemporal as-of aware) — walks the subject-predicate-object triple ' +
        'store. Use to answer "what does X depend on" or "what uses Y". direction: subject (entity is ' +
        'the subject), object (entity is the object), both (default).',
      inputSchema: z.object({
        entityId: z.string().min(1).describe('Entity id to get relationships for'),
        // Param name is `asOf` (camelCase) for cloud parity (EntityTools.cs
        // uses `asOf`), not `as_of` like this repo's own search_memory/
        // recall_memory filter — an accepted naming divergence for this
        // cloud-mirrored tool; a follow-up may align the two conventions.
        asOf: z
          .string()
          .optional()
          .describe('Optional ISO-8601 timestamp for bitemporal as-of query (omit for currently valid)'),
        direction: z
          .enum(['subject', 'object', 'both'])
          .default('both')
          .describe('Direction filter: subject | object | both (default both)'),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .default(50)
          .describe('Maximum relationships to return (default 50, max 500)'),
      }),
    },
    async (args) => {
      const entityRepo = new EntityRepo(db);
      const entity = entityRepo.getById(args.entityId);
      if (!entity) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', entity_id: args.entityId }) }],
          isError: true,
        };
      }

      let asOf: number | undefined;
      try {
        asOf = parseAsOf(args.asOf);
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: err instanceof Error ? err.message : 'invalid asOf' }) },
          ],
          isError: true,
        };
      }

      // Intentional divergence from cloud (EntityTools.cs:108-140): direction
      // 'both' here is ONE combined, globally valid_from-sorted query capped
      // at a single `limit` (EntityRelationRepo.getForEntity), not cloud's two
      // independent per-direction queries concatenated (which can return up
      // to 2x limit rows). SLICE-1's repo was already built this way.
      const relationRepo = new EntityRelationRepo(db);
      const rows = relationRepo.getForEntity(args.entityId, { asOf, limit: args.limit, direction: args.direction });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              entity_id: args.entityId,
              relationships: rows.map((r) => ({
                id: r.id,
                subject_entity_id: r.subject_entity_id,
                predicate: r.predicate,
                object_entity_id: r.object_entity_id,
                evidence_memory_id: r.evidence_memory_id,
                source_excerpt: r.source_excerpt,
                confidence: r.confidence,
                valid_from: r.valid_from,
                valid_to: r.valid_to,
              })),
            }),
          },
        ],
      };
    }
  );

  // ---- get_entity_timeline ---------------------------------------------------
  // FEAT-481 SLICE-3 (design doc §4.1). Not new machinery — reuses
  // EntityRepo.memoryIdsForEntities (entities.ts), same "currently linked"
  // semantics as GET /entities/:id/memories (src/server/routes/entities.ts),
  // joined back to memories for content/type/created_at. `since` is
  // epoch-ms (matches search_memory/recall_memory's own `since` filter
  // convention in this repo), unlike cloud's ISO-8601 `since` on
  // EntityTools.cs:147-196 — see handoff notes for the deviation rationale.
  server.registerTool(
    'get_entity_timeline',
    {
      description:
        'Timeline of memories mentioning a specific entity, newest-first. Optional since (epoch-ms ' +
        'lower bound on created_at). Reuses EntityRepo.memoryIdsForEntities — no new table, no new ' +
        'time-tracking machinery.',
      inputSchema: z.object({
        entityId: z.string().min(1).describe('Entity id'),
        since: z
          .number()
          .optional()
          .describe('Epoch-ms lower bound — only return memories created at or after this time'),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .default(20)
          .describe('Maximum results to return (default 20, max 200)'),
      }),
    },
    async (args) => {
      const entityRepo = new EntityRepo(db);
      const entity = entityRepo.getById(args.entityId);
      if (!entity) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not found', entity_id: args.entityId }) }],
          isError: true,
        };
      }

      const memRepo = new MemoryRepo(db);
      const memoryIds = entityRepo.memoryIdsForEntities([args.entityId]);
      // Currently-valid only (valid_to IS NULL) — same semantics as
      // GET /entities/:id/memories: a superseded/invalidated/archived
      // memory is retired, not "currently linked", even though the
      // memory_entities row itself still points at it.
      const memories = Array.from(memoryIds)
        .map((mid) => memRepo.get(mid))
        .filter((m): m is NonNullable<typeof m> => m !== null && m.valid_to === null)
        .filter((m) => args.since === undefined || m.created_at >= args.since)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, args.limit)
        .map((m) => ({ id: m.id, content: m.text, type: m.type, created_at: m.created_at }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              entity_id: args.entityId,
              entity_name: entity.name,
              count: memories.length,
              memories,
            }),
          },
        ],
      };
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

  // ---- submit_feedback (canonical) + mark_memory_used (DEPRECATED alias) ----
  // U5 collapse (astragenie/memory#671, astragenie/astramem-local#120):
  // local's ADR-010 explicit recall-used signal collapses onto cloud's
  // `submit_feedback` wire name. `mark_memory_used` is retained for one
  // release as a deprecated alias — same handler — so existing consumers
  // don't break on this rename. Cloud's submit_feedback carries a +1/-1
  // score; local always records signal="explicit" (no score dimension
  // stored locally today — see contracts/manifests/mcp-tools.v1.json).
  const feedbackInputSchema = z.object({
    id: z.string().min(1).describe('Memory id that was useful'),
    note: z.string().optional().describe('Optional free-text note (not persisted — reserved for future use)'),
  });

  const handleSubmitFeedback = async (args: { id: string; note?: string }) => {
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
  };

  server.registerTool(
    'submit_feedback',
    {
      description:
        'ADR-010 explicit recall-used signal: tell astramemory a previously-served memory actually ' +
        'mattered in this turn. Canonical cross-repo wire name (U5, astragenie/memory#671) — shared ' +
        'with cloud, which also accepts a +1/-1 score; local always records signal="explicit". ' +
        'This is the explicit feedback channel — heuristic client-side detection (content referenced ' +
        'in a later turn) is separate adapter work, out of scope here. Feeds the recall-usefulness rate ' +
        'on doctor/dashboard/health, AND influences ranking directly: the ADR-010 v1.x epsilon component ' +
        '(src/search/fuse.ts) consumes the usefulness score computed from these events, so calling this ' +
        'measurably reorders future search/recall results.',
      inputSchema: feedbackInputSchema,
    },
    handleSubmitFeedback
  );

  server.registerTool(
    'mark_memory_used',
    {
      description:
        'DEPRECATED — one-release alias for submit_feedback (U5 rename, astragenie/memory#671, ' +
        'astragenie/astramem-local#120). Same handler and behavior; prefer submit_feedback — this name ' +
        'will be removed in a future release.',
      inputSchema: feedbackInputSchema,
    },
    handleSubmitFeedback
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
        'near-duplicate pairs (kind=merge) awaiting an explicit merge/keep decision, and FEAT-456 ' +
        'judge-flagged conflicting pairs (kind=contradiction, e.g. "port is 7777" vs "port is 8888") ' +
        'awaiting confirm/dismiss. Contradiction rows include verdict/confidence/excerpts from the ' +
        'judge. Nothing is changed until a proposal is resolved via resolve_consolidation_proposal ' +
        '(or, for bulk resolution, resolve_consolidation_proposals_batch). #372: limit/offset/' +
        'minConfidence page and filter a queue that can grow into the hundreds — the unpaged response ' +
        'was previously impractical for an LLM caller to consume in one call.',
      inputSchema: z.object({
        status: z.enum(['pending', 'accepted', 'rejected']).default('pending').describe('Filter by status'),
        kind: z.enum(['merge', 'contradiction']).optional().describe('Optional filter by proposal kind'),
        limit: z.number().int().positive().max(1000).optional().describe('Max rows to return (omit for all matching)'),
        offset: z.number().int().min(0).optional().describe('Rows to skip before applying limit'),
        minConfidence: z.number().min(0).max(1).optional().describe(
          'Only proposals at/above this confidence — similarity for kind=merge, judge confidence ' +
          '(metadata_json) for kind=contradiction',
        ),
      }),
    },
    async (args) => {
      const repo = new ProposalRepo(db);
      const listOpts = { limit: args.limit, offset: args.offset, minConfidence: args.minConfidence };
      const proposals = repo.list(args.status, args.kind, listOpts);
      const total = repo.count(args.status, args.kind, args.minConfidence);
      const memRepo = new MemoryRepo(db);
      const enriched = proposals.map(p => ({
        ...p,
        winner_text: memRepo.get(p.winner_id)?.text ?? null,
        loser_text: memRepo.get(p.loser_id)?.text ?? null,
        // FEAT-456 SLICE-2: parsed verdict/confidence/excerpts for
        // kind='contradiction' rows so an agent sees *why* without a
        // second round-trip. null for kind='merge' rows (metadata_json
        // is NULL) — see parseContradictionMetadata.
        contradiction_metadata: parseContradictionMetadata(p),
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ proposals: enriched, total }) }] };
    }
  );

  // ---- resolve_consolidation_proposal ---------------------------------------
  server.registerTool(
    'resolve_consolidation_proposal',
    {
      description:
        'Accept or reject a pending consolidation proposal, merge or contradiction kind alike — ' +
        'resolution is identical for both. Accept executes the non-destructive merge-as-supersede ' +
        '(loser kept as superseded, winner gains derived_from lineage); reject keeps both memories ' +
        'untouched. For a contradiction proposal, accept confirms the newer atom (winner) corrects ' +
        'the older one (loser).',
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

  // ---- resolve_consolidation_proposals_batch --------------------------------
  server.registerTool(
    'resolve_consolidation_proposals_batch',
    {
      description:
        'Bulk accept or reject PENDING consolidation proposals matching an optional kind/min-confidence ' +
        'filter (#372) — the drain tool for a queue too large to resolve one-by-one via ' +
        'resolve_consolidation_proposal. Confidence is the similarity column for kind=merge proposals ' +
        'and the judge confidence (metadata_json) for kind=contradiction proposals. Each match goes ' +
        'through the exact same accept/reject path a single resolve_consolidation_proposal call uses ' +
        '(accept is the non-destructive merge-as-supersede — reversible via unsupersede_memory), so a ' +
        'lifecycle conflict on one proposal (its winner/loser was merged or erased since) is skipped, ' +
        `not fatal to the batch. Capped at ${MAX_BATCH_RESOLVE} proposals per call — call again (the ` +
        'matching set shrinks as proposals resolve) while `remaining` is nonzero.',
      inputSchema: z.object({
        action: z.enum(['accept', 'reject']).describe('Resolution to apply to every matched proposal'),
        kind: z.enum(['merge', 'contradiction']).optional().describe('Optional filter by proposal kind'),
        minConfidence: z.number().min(0).max(1).optional().describe('Only resolve proposals at/above this confidence'),
        limit: z.number().int().positive().max(MAX_BATCH_RESOLVE).default(MAX_BATCH_RESOLVE)
          .describe(`Max proposals to resolve in this call (<= ${MAX_BATCH_RESOLVE})`),
      }),
    },
    async (args) => {
      const repo = new ProposalRepo(db);
      const matched = repo.list('pending', args.kind, { minConfidence: args.minConfidence, limit: args.limit });
      const totalMatching = repo.count('pending', args.kind, args.minConfidence);

      let resolved = 0;
      const skipped: Array<{ id: string; reason: string }> = [];
      for (const p of matched) {
        try {
          // bulkAccepted mirrors the CLI's `accept --all` marker (FEAT-437
          // residual) so memory_events can distinguish a batch resolve from
          // a single manual accept.
          if (args.action === 'accept') repo.accept(p.id, undefined, { bulkAccepted: true });
          else repo.reject(p.id);
          resolved++;
        } catch (err) {
          if (
            err instanceof ProposalNotFoundError ||
            err instanceof ProposalAlreadyResolvedError ||
            err instanceof MemoryNotFoundError ||
            err instanceof MemoryConflictError
          ) {
            skipped.push({ id: p.id, reason: err.message });
            continue;
          }
          throw err;
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            action: args.action,
            matched: matched.length,
            resolved,
            skipped,
            remaining: Math.max(0, totalMatching - matched.length),
          }),
        }],
      };
    }
  );

  return server;
}
