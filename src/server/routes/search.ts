/**
 * Search routes:
 *   GET  /search?q=&type=&repo=&project=&agent=&agentMode=&since=&as_of=&entity=&limit=&preset=
 *   POST /recall  { query|text, k|limit, mode?, filters? }  filters.as_of: ISO-8601 date-time,
 *                                          filters.entity: FEAT-402 AC-4,
 *                                          filters.agentMode: FEAT-426 ('filter'|'boost')
 *                                          filters.scope: FEAT-532 L2 (private|team|org, array)
 *                 { preset? }              FEAT-454: named retrieval preset, see src/search/presets.ts
 *                 { mode? }                FEAT-532 L2: 'keyword'|'semantic'|'hybrid', see
 *                                           src/search/search.ts's gatherCandidates() doc comment.
 *                                           Omitted = 'hybrid'.
 *   POST /remember { text, type, project?, agent?, metadata? }
 *                 project/agent (#341): flat top-level canonical fields —
 *                 preferred over the deprecated nested metadata.project/
 *                 metadata.agent, which remain accepted for compat.
 *
 * #112 (U3-local): `query`/`k` are the pre-ADR-005 legacy field names for
 * POST /recall; `text`/`limit` are the canonical ADR-005 names
 * (contracts/schemas/retrieval-query.v1.schema.json). Both spellings are
 * accepted for exactly one release — drop `query`/`k` next release.
 *
 * FEAT-454: `preset` selects a named routing over the existing fusion
 * weights/filters (default|recent|exact|entity|temporal) — see
 * src/search/presets.ts for the full semantics and AC-3 400 cases. Omitted
 * `preset` is `'default'`, byte-identical to pre-FEAT-454 behavior (AC-1).
 *
 * FEAT-532 L1: POST /recall's response is now the canonical
 * astramem-retrieval-result@1 envelope (contracts/schemas/
 * retrieval-result.v1.schema.json) — `{ schema, query, hits, total }`, hits
 * wire-mapped via src/contracts/wire-hit.ts's toWireHit(). BREAKING versus
 * the pre-FEAT-532 flat `{ hits }` shape: each hit's fusion-leg `source`
 * (fts|vec|both) is dropped and `capture_source` is renamed to the
 * canonical `source` (provenance) — a client reading the old `source`
 * meaning will silently misinterpret the new one. GET /search is
 * UNCHANGED (still the flat `{ hits }` shape) — only POST /recall adopts
 * the envelope in this slice.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import type { EmbedProvider } from '../../contracts/index.js';
import { MemoryRepo } from '../../storage/memories.js';
import { MemoryEventRepo } from '../../storage/memory-events.js';
import { recordRecallServed } from '../../storage/usefulness.js';
import { SqliteVecStore } from '../../vector/sqlite-vec.js';
import { JobRepo } from '../../pipeline/job-repo.js';
import { search, parseAsOf, type SearchFilters } from '../../search/search.js';
import { resolveRerankOpts } from '../../search/rerank.js';
import { resolveDecomposeOpts } from '../../search/decompose.js';
import { buildLLMProvider } from '../../providers/index.js';
import { defaultConfig, type Config } from '../../config/config.js';
import { childLogger } from '../../log/logger.js';
import { redactIfEnabled } from '../../redact/index.js';
import { recordRedactionEvents } from '../../storage/redaction-log.js';
import { contentHash } from '../../storage/content-hash.js';
import { clampScores } from '../lib/score-contract.js';
import { withDeadline } from '../lib/deadline.js';
import { ProjectFilterSchema, AgentFilterSchema, EntityFilterSchema, RepoFilterSchema, SinceFilterSchema } from '../../contracts/recall-filters.js';
// FEAT-429: project/agent/entity/repo/since parsing for both the GET
// query-string and the POST JSON body now derives from the shared
// filter-descriptor registry instead of hand-rolled
// `if (params.x) filters.x = ...` blocks per surface — see
// src/contracts/filter-registry.ts.
import { assignQueryFilterValues, assignStructuredFilterValues } from '../../contracts/filter-registry.js';
// #112 (U3-local, AC-1): consume the single source of truth for the memory
// type union instead of re-declaring a hand-copied list here. Once #111 lands
// the canonical 10-value union in src/contracts/memory.ts, this schema picks
// it up automatically — tests/contracts/recall-filter-parity.test.ts is the
// regression gate that fails the build if a local copy is ever re-introduced.
import { MEMORY_TYPES, MEMORY_SCOPES } from '../../contracts/memory.js';
// FEAT-454: named retrieval preset — routing over existing fusion
// weights/filters, never a new scoring path. See src/search/presets.ts.
import {
  RETRIEVAL_PRESETS,
  resolvePresetWeights,
  validatePresetFilters,
  PresetValidationError,
  type RetrievalPreset,
} from '../../search/presets.js';
// FEAT-532 L1: promoted wire-mapping (SearchHit -> the canonical
// astramem-retrieval-result@1 hit shape), shared with
// tests/contracts/conformance.test.ts's live conformance checks.
import { toWireHit } from '../../contracts/wire-hit.js';

const MemoryTypeEnum = z.enum(MEMORY_TYPES);
const MemoryScopeEnum = z.enum(MEMORY_SCOPES);
const RetrievalPresetEnum = z.enum(RETRIEVAL_PRESETS);
// FEAT-532 L2: astramem-retrieval-query@1 `mode` (contracts/schemas/
// retrieval-query.v1.schema.json). Threaded into search()'s SearchOpts.mode.
const RetrievalModeEnum = z.enum(['keyword', 'semantic', 'hybrid']);

const RecallBodySchema = z.object({
  // #112 AC-2: `text` (ADR-005 canonical) and `query` (legacy) are both
  // accepted for exactly one release — at least one is required, enforced
  // by the `.refine` below. Drop `query` next release.
  query: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  // #112 AC-2: `limit` (ADR-005 canonical) and `k` (legacy) are both accepted
  // for exactly one release. Drop `k` next release.
  k: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  filters: z.object({
    // #112 AC-1/AC-3: enum-validated against the shared MEMORY_TYPES union —
    // an out-of-union value now fails validation with a 400 naming the
    // field, instead of silently passing through as a free-form string.
    type: z.array(MemoryTypeEnum).optional(),
    /** FEAT-429: scalar exact match on memories.repo — registry-driven (canonical contract). */
    repo: RepoFilterSchema,
    /** FEAT-423/FEAT-424: single project or a list (OR-semantics) — canonical contract. */
    project: ProjectFilterSchema,
    /** FEAT-423/FEAT-424: single agent or a list; exact match on provenance agent/agent_type — canonical contract. */
    agent: AgentFilterSchema,
    /** FEAT-426: 'filter' (default, omitted) = current hard-filter behavior;
     *  'boost' = agent stays a ranking preference, non-matches are not excluded. */
    agentMode: z.enum(['filter', 'boost']).optional(),
    /** FEAT-429: epoch-ms lower bound on memories.created_at — registry-driven (canonical contract). */
    since: SinceFilterSchema,
    /** FEAT-401: ISO-8601 date-time — bitemporal time-travel (ADR-001/ADR-005). */
    as_of: z.string().optional(),
    /** FEAT-402 slice 2 AC-4/FEAT-424: entity name — resolved via the AC-9 normalize seam — canonical contract. */
    entity: EntityFilterSchema,
    /** FEAT-532 L2: ADR-009 scope hard filter (private|team|org) — canonical
     *  contract (retrieval-query.v1.schema.json `filters.scope`, array-only,
     *  unlike project/agent's string-or-list shape). Absent = no constraint. */
    scope: z.array(MemoryScopeEnum).optional()
  }).optional(),
  /** FEAT-454: named retrieval preset — see src/search/presets.ts. Omitted = 'default'. */
  preset: RetrievalPresetEnum.optional(),
  /** FEAT-532 L2: astramem-retrieval-query@1 `mode` — which candidate leg(s)
   *  search() runs. Omitted = 'hybrid', byte-identical to pre-FEAT-532
   *  behavior (both legs always ran). See src/search/search.ts's
   *  gatherCandidates() doc comment for the exact per-mode behavior. */
  mode: RetrievalModeEnum.optional()
}).refine((body) => (body.text ?? body.query) !== undefined, {
  // #112 AC-2: at least one of the canonical/legacy query-text spellings
  // is required — mirrors the pre-#112 `query: z.string().min(1)` required
  // check, now satisfiable by either field name.
  message: 'text (or legacy `query`) is required',
  path: ['text'],
});

const RememberBodySchema = z.object({
  text: z.string().min(1),
  type: MemoryTypeEnum,
  // #341: flat top-level canonical fields — the wire shape the daemon-client
  // HTTP transport's own `RememberRequest` type declares (`{project, agent}`
  // top-level), mirroring the flat convention already used elsewhere on this
  // daemon (canonical /ingest/transcript's `project_id`/`agent_type`, the
  // MCP `remember` tool's `projectId`/`agentId` aliases). Take priority over
  // the deprecated nested `metadata.project`/`metadata.agent` below when
  // both are supplied — additive, backward-compatible: a caller sending only
  // nested metadata behaves byte-identically to before.
  project: z.string().optional(),
  agent: z.string().optional(),
  metadata: z.object({
    repo: z.string().optional(),
    project: z.string().optional(),
    branch: z.string().optional(),
    agent: z.string().optional(),
    importance: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional()
  }).optional()
});

export function searchRoute(db: DB, embed: EmbedProvider, config: Config = defaultConfig()) {
  const cfg = defaultConfig();
  // FEAT-454: renamed from `weights` — this is now the per-preset BASE, not
  // the final weights object. `resolvePresetWeights` (src/search/presets.ts)
  // derives the actual per-request weights from this base, once per request
  // (was: built once per route-factory call, which made a per-request preset
  // impossible to honor).
  const baseWeights = cfg.search;
  // issue #26 / ADR-005: cross-encoder rerank stage, read from the REAL
  // passed-in `config` (not `cfg` above — that pre-existing `defaultConfig()`
  // fallback for `weights` is out of scope here) so config.yaml's
  // `crossEncoder.enabled` actually takes effect on this route. `undefined`
  // when disabled (the default) — search() takes zero extra branches.
  const rerank = resolveRerankOpts(config);
  // WS6: multi-hop query decomposition — undefined (search() takes zero
  // extra branches) unless multiHop.enabled is set. See src/search/decompose.ts.
  const decompose = resolveDecomposeOpts(config, buildLLMProvider);

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

      if (params.type) {
        // #112 AC-3: enum-validate against the shared MEMORY_TYPES union —
        // an out-of-union value is a 400 naming the field, not a silent
        // passthrough that quietly matches zero rows downstream.
        const rawTypes = params.type.split(',').map(t => t.trim()).filter(Boolean);
        const parsedTypes = z.array(MemoryTypeEnum).safeParse(rawTypes);
        if (!parsedTypes.success) {
          return reply.code(400).send({ error: 'invalid', details: parsedTypes.error.flatten() });
        }
        filters.type = parsedTypes.data;
      }
      // FEAT-429: project/agent/entity/repo/since — registry-driven (was 5
      // hand-rolled blocks; see src/contracts/filter-registry.ts).
      assignQueryFilterValues(params, filters as unknown as Record<string, unknown>);
      if (params.agentMode === 'filter' || params.agentMode === 'boost') filters.agentMode = params.agentMode;
      if (params.as_of) {
        try {
          filters.as_of = parseAsOf(params.as_of);
        } catch (err) {
          return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid as_of' });
        }
      }

      // FEAT-454: named retrieval preset. Omitted = 'default', byte-identical
      // to pre-FEAT-454 behavior (AC-1). An out-of-enum value is a 400, same
      // shape as the `type` validation above.
      let preset: RetrievalPreset = 'default';
      if (params.preset !== undefined) {
        const parsedPreset = RetrievalPresetEnum.safeParse(params.preset);
        if (!parsedPreset.success) {
          return reply.code(400).send({ error: 'invalid', details: parsedPreset.error.flatten() });
        }
        preset = parsedPreset.data;
      }
      try {
        validatePresetFilters(preset, filters);
      } catch (err) {
        if (err instanceof PresetValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      const weights = resolvePresetWeights(preset, baseWeights);

      const hits = await search(q, filters, limit, { db, embed, weights, rerank, decompose });
      // ADR-010: recall-usefulness capture — measure only, does not feed ranking (v1).
      recordRecallServed(db, {
        query: q,
        atomIds: hits.map(h => h.id),
        scores: hits.map(h => h.score),
        surface: 'rest',
        mode: 'search',
      });
      // SLICE-411: enforce the [0,1] wire score contract at serialization,
      // independent of fuseScores() internal math.
      return { hits: clampScores(hits, 'GET /search') };
    });

    // POST /recall
    app.post('/recall', async (req, reply) => {
      const parsed = RecallBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      // #112 AC-2: normalize the canonical/legacy aliases to one shape before
      // processing — `text`/`limit` (ADR-005 canonical) take priority over
      // `query`/`k` (legacy) when a caller sends both; `limit` defaults to 5,
      // preserving the pre-#112 `k.default(5)` behavior.
      const query = parsed.data.text ?? parsed.data.query!;
      const k = parsed.data.limit ?? parsed.data.k ?? 5;
      const { filters: rawFilters } = parsed.data;
      const filters: SearchFilters = {};
      if (rawFilters?.type) filters.type = rawFilters.type;
      // FEAT-429: project/agent/entity/repo/since — registry-driven (was 5
      // hand-rolled lines; see src/contracts/filter-registry.ts).
      assignStructuredFilterValues(rawFilters, filters as unknown as Record<string, unknown>);
      if (rawFilters?.agentMode) filters.agentMode = rawFilters.agentMode;
      // FEAT-532 L2: scope isn't in the filter-registry (array-only shape,
      // unlike registry filters' string-or-list) — assigned directly, same
      // truthy-length gate as `type` above.
      if (rawFilters?.scope && rawFilters.scope.length > 0) filters.scope = rawFilters.scope;
      if (rawFilters?.as_of !== undefined) {
        try {
          filters.as_of = parseAsOf(rawFilters.as_of);
        } catch (err) {
          return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid as_of' });
        }
      }

      // FEAT-454: named retrieval preset. Omitted = 'default', byte-identical
      // to pre-FEAT-454 behavior (AC-1).
      const preset: RetrievalPreset = parsed.data.preset ?? 'default';
      try {
        validatePresetFilters(preset, filters);
      } catch (err) {
        if (err instanceof PresetValidationError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
      const weights = resolvePresetWeights(preset, baseWeights);

      // FEAT-532 L2: astramem-retrieval-query@1 `mode` — omitted defaults to
      // 'hybrid', byte-identical to pre-FEAT-532 behavior (search() always
      // ran both legs). Threaded into SearchOpts.mode below, NOT to be
      // confused with recordRecallServed's unrelated `mode: 'recall'`
      // surface tag a few lines down.
      const retrievalMode = parsed.data.mode ?? 'hybrid';

      // ADR-019 Tier 1 (issue #347) Decision 1b: bound the actual search/DB
      // work in a deadline race so a hang inside THIS handler's own async
      // chain returns a clean 504 instead of hanging to the client's cap.
      // See src/server/lib/deadline.ts's doc comment for what this does and
      // does NOT protect against (it does not close #347 — 1a does).
      return withDeadline('POST /recall', reply, async () => {
        const hits = await search(query, filters, k, { db, embed, weights, rerank, decompose, mode: retrievalMode });
        // ADR-010: recall-usefulness capture — measure only, does not feed ranking (v1).
        recordRecallServed(db, {
          query,
          atomIds: hits.map(h => h.id),
          scores: hits.map(h => h.score),
          surface: 'rest',
          mode: 'recall',
        });
        // SLICE-411: enforce the [0,1] wire score contract at serialization,
        // independent of fuseScores() internal math.
        const clamped = clampScores(hits, 'POST /recall');
        // FEAT-532 L1: canonical astramem-retrieval-result@1 envelope
        // (contracts/schemas/retrieval-result.v1.schema.json) — see this
        // file's top doc comment for the BREAKING-change note versus the
        // pre-FEAT-532 flat `{ hits }` shape.
        return {
          schema: 'astramem-retrieval-result@1' as const,
          query: { text: query, mode: retrievalMode },
          hits: clamped.map(toWireHit),
          total: clamped.length,
        };
      });
    });

    // POST /remember — direct insert bypassing distillation pipeline
    app.post('/remember', async (req, reply) => {
      const parsed = RememberBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      const { type, metadata, project, agent } = parsed.data;

      // Stage-0 secret redaction (SEC-3/5, OQ-2) — same choke point as ingest,
      // applied before persistence AND before the embed call (SEC-4: no
      // un-redacted content reaches a cloud embed provider).
      const { text, events: redactionEvents } = redactIfEnabled(parsed.data.text, config);
      recordRedactionEvents(db, redactionEvents, null);

      // Compute hash for dedup
      const hash = contentHash(text);

      const repo = new MemoryRepo(db);
      const events = new MemoryEventRepo(db);
      const { id } = repo.insertWithCreateEvent({
        type,
        text,
        normalized_text: text.toLowerCase(),
        repo: metadata?.repo ?? null,
        // #341: flat top-level alias wins over the deprecated nested form
        // when both are present — see RememberBodySchema's doc comment.
        project: project ?? metadata?.project ?? null,
        branch: metadata?.branch ?? null,
        agent: agent ?? metadata?.agent ?? null,
        session_id: null,
        hash,
        source_hash: null,
        importance: metadata?.importance ?? 0.5,
        confidence: metadata?.confidence ?? 0.5,
        embedding_provider: embed.name,
        embedding_model: embed.model,
        embedding_dim: embed.dim
      }, events);

      // Embed + upsert into vec store. Non-fatal: the memory itself is
      // already durably saved above (FTS still works), but a caller that
      // gets back `ok: true` unconditionally would have no way to know the
      // memory is vector-search-blind — `vec_indexed` below surfaces the
      // degraded state to THIS caller. Issue #209: that response field used
      // to be the only record of the failure — nothing durable, nothing
      // retried. Now a failure also marks needs_vec_index on the row and
      // enqueues a `reembed` job, so the memory self-heals via the worker
      // instead of waiting on an operator to notice and run `rebuild`.
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
            'remember: retry-job enqueue failed after vec upsert failure — needs_vec_index still set, cleanup sweep will catch it',
          );
        }
        childLogger({}).warn({ error_message: err instanceof Error ? err.message : String(err), id }, 'remember: embed/vec upsert failed — memory saved but NOT vector-indexed; needs_vec_index set, reembed job enqueued');
      }

      return vecIndexed ? { id, ok: true } : { id, ok: true, vec_indexed: false };
    });
  };
}
