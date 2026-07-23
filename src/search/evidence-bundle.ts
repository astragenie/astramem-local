/**
 * Selective post-rerank evidence bundling (Wave-6, P2 retrieval-overhaul
 * "evidence-sufficiency" lever — mirrors src/search/rerank.ts's/decompose.ts's
 * ADR-005 seam pattern).
 *
 * The oracle-factorial investigation found ~87% of the LoCoMo gap lives in
 * the answerer/evidence layer, not ranking: the gold-turns ceiling (~0.526)
 * shows the answerer often receives top-k atoms that are each individually
 * well-ranked but COLLECTIVELY insufficient to answer a multi-hop question —
 * the missing fact simply never made it into the window search()/rerank
 * already finalized. This stage runs AFTER that top-k is finalized (post-
 * rerank when rerank is enabled, post-fusion-truncation otherwise) and, only
 * when the evidence looks thin by a cheap heuristic, pulls a small number of
 * ADDITIONAL scoped atoms (same-entity / same-session as the finalized hits)
 * into the bundle. Ranking of the original top-k is never touched — this is
 * pure addition, same "never evict, only add" posture WS6's supplemental
 * merge already established.
 *
 * OFF by default (config.evidenceBundling.enabled: false) —
 * `resolveEvidenceBundlingOpts` returns `undefined` in that case and
 * search() takes its pre-Wave-6 code path with zero extra branches,
 * byte-identical to before this file existed.
 *
 * Deliberately HEURISTIC, not LLM-based: the trigger (`isEvidenceThin`) and
 * the scoped pull below are both plain DB queries against data the ingest
 * pipeline already wrote (`memories.session_id`, `memory_entities`) — no new
 * LLM call on this hot, latency-sensitive path. A future LLM-backed
 * sufficiency check (asking a model "is this evidence enough to answer X?")
 * is plausible follow-on work, but belongs behind its OWN sub-flag with its
 * own cost/timeout budget (FEAT-482's lesson: an ungated LLM call on a
 * per-recall path can wedge a metered endpoint) — not folded into this
 * default heuristic path.
 */

import type { DB } from '../storage/db.js';
import type { Config } from '../config/config.js';
import type { SearchHit } from './search.js';
import type { MemoryType, MemoryScope } from '../contracts/index.js';
import { chunkedIn } from '../storage/sql-utils.js';

/** Bounds the `evidence` excerpt on a bundled hit — same bound search.ts
 *  applies to every ordinary hit (MAX_EVIDENCE_EXCERPT_CHARS), duplicated
 *  here rather than imported to avoid a runtime import cycle with search.ts
 *  (which imports `applyEvidenceBundling` from this file). Keep in sync. */
const MAX_EVIDENCE_EXCERPT_CHARS = 500;

/** Resolved evidence-bundling options as consumed by `applyEvidenceBundling` /
 *  `SearchOpts.evidenceBundling`. */
export interface EvidenceBundlingOpts {
  /** Hard cap on how many extra atoms one enrichment pass may ever add,
   *  regardless of how many scoped candidates were found. */
  maxExtra: number;
  /** "Evidence looks thin" trigger: enrichment only fires when the
   *  finalized top-k's distinct `memories.session_id` count is BELOW this. */
  minDistinctSessions: number;
  /** Pull atoms sharing an entity (via `memory_entities`) with any finalized hit. */
  sameEntity: boolean;
  /** Pull atoms sharing a `session_id` with any finalized hit. */
  sameSession: boolean;
}

/**
 * Resolve `SearchOpts.evidenceBundling` from config: `undefined` when
 * disabled (so search() takes zero extra branches — same contract as
 * `resolveRerankOpts`/`resolveDecomposeOpts`), or a fully-resolved
 * `EvidenceBundlingOpts` when enabled. No provider/model to build (unlike
 * rerank/decompose) — this stage is pure heuristic + DB queries.
 */
export function resolveEvidenceBundlingOpts(config: Config): EvidenceBundlingOpts | undefined {
  if (!config.evidenceBundling.enabled) return undefined;
  return {
    maxExtra: config.evidenceBundling.maxExtra,
    minDistinctSessions: config.evidenceBundling.minDistinctSessions,
    sameEntity: config.evidenceBundling.sameEntity,
    sameSession: config.evidenceBundling.sameSession,
  };
}

/**
 * Pure heuristic trigger: given each finalized hit's `session_id` (`null`
 * when unset), true when the DISTINCT non-null count is below
 * `minDistinctSessions` — the finalized top-k is drawn from too few distinct
 * sessions for comfort on a question that may need cross-session context.
 * Exported standalone so the trigger is unit-testable without a DB.
 */
export function isEvidenceThin(sessionIds: Array<string | null>, minDistinctSessions: number): boolean {
  const distinct = new Set(sessionIds.filter((s): s is string => s !== null));
  return distinct.size < minDistinctSessions;
}

/**
 * The exact SQL fragments search() already built for the base result set
 * (post-fusion column/range filters + bitemporal validity window) — reused
 * VERBATIM here rather than re-derived from `SearchFilters`, so an enrichment
 * pull can never surface an atom that project/scope/type/agent/since
 * filtering or the as_of/validity window would have excluded (no drift
 * between the two, by construction — there is only one filter-building call
 * site, in search.ts). NOT reapplied here: `filters.entity` — that narrowing
 * is a PRE-fusion candidate-set intersection in search() (applyEntityFilter,
 * before gatherCandidates' output ever reaches fusion), not part of this
 * post-fusion `whereFilter`/`validityClause` pair, so an entity-filtered
 * search's enrichment pull can surface an atom outside that entity scope.
 * `filters.entity` is a relevance narrowing, not a tenant/security boundary,
 * so this is an accuracy caveat, not a scoping leak.
 */
export interface EvidenceBundleSqlContext {
  /** ` AND ...`-prefixed fragment, or `''` when no post-fusion filter is active. */
  whereFilter: string;
  filterParams: (string | number)[];
  validityClause: string;
  validityParams: number[];
}

interface CandidateInfo {
  sharedCount: number;
  reason: 'same_entity' | 'same_session';
}

/**
 * Apply the evidence-bundling stage to an already-finalized hit list (post-
 * rerank when rerank ran, post-fusion-truncation otherwise). Pure addition —
 * `hits` themselves are never reordered or dropped; enrichment atoms are
 * appended after them, each marked `bundled: true` with a `bundle_reason`.
 *
 * No-ops (returns `hits` unchanged) when: `hits` is empty, `maxExtra <= 0`,
 * the thinness trigger doesn't fire (evidence already spans enough distinct
 * sessions), or every scoped candidate is filtered out by `sql`'s clauses.
 */
export async function applyEvidenceBundling(
  db: DB,
  hits: SearchHit[],
  sql: EvidenceBundleSqlContext,
  opts: EvidenceBundlingOpts,
): Promise<SearchHit[]> {
  if (hits.length === 0 || opts.maxExtra <= 0) return hits;

  const anchorIds = hits.map(h => h.id);
  const anchorIdSet = new Set(anchorIds);

  // chunkedIn (src/storage/sql-utils.ts): anchorIds is bounded by the
  // caller's rerank.topK/limit in practice, but chunking is cheap
  // insurance against SQLITE_MAX_VARIABLE_NUMBER regardless.
  const sessionRows = chunkedIn(anchorIds, (batch, ph) =>
    db.prepare(`SELECT id, session_id FROM memories WHERE id IN (${ph})`).all(...batch) as Array<{
      id: string;
      session_id: string | null;
    }>,
  );
  if (!isEvidenceThin(sessionRows.map(r => r.session_id), opts.minDistinctSessions)) {
    return hits; // evidence already spans enough sessions — enrichment not triggered
  }

  const anchorSessionIds = Array.from(
    new Set(sessionRows.map(r => r.session_id).filter((s): s is string => s !== null)),
  );

  const candidates = new Map<string, CandidateInfo>();

  if (opts.sameSession && anchorSessionIds.length > 0) {
    const rows = chunkedIn(anchorSessionIds, (batch, ph) =>
      db.prepare(`SELECT id FROM memories WHERE session_id IN (${ph})`).all(...batch) as Array<{ id: string }>,
    );
    for (const r of rows) {
      if (anchorIdSet.has(r.id)) continue;
      const existing = candidates.get(r.id);
      if (existing) existing.sharedCount += 1;
      else candidates.set(r.id, { sharedCount: 1, reason: 'same_session' });
    }
  }

  if (opts.sameEntity) {
    const entityRows = chunkedIn(anchorIds, (batch, ph) =>
      db.prepare(`SELECT DISTINCT entity_id FROM memory_entities WHERE memory_id IN (${ph})`).all(...batch) as Array<{
        entity_id: string;
      }>,
    );
    const entityIds = entityRows.map(r => r.entity_id);
    if (entityIds.length > 0) {
      const rows = chunkedIn(entityIds, (batch, ph) =>
        db
          .prepare(`SELECT DISTINCT memory_id FROM memory_entities WHERE entity_id IN (${ph})`)
          .all(...batch) as Array<{ memory_id: string }>,
      );
      for (const r of rows) {
        if (anchorIdSet.has(r.memory_id)) continue;
        const existing = candidates.get(r.memory_id);
        // 'same_entity' is the stronger/more specific signal — it wins the
        // reason tag even when the same id was already found via
        // same_session above (sharedCount still accumulates either way).
        if (existing) {
          existing.sharedCount += 1;
          existing.reason = 'same_entity';
        } else {
          candidates.set(r.memory_id, { sharedCount: 1, reason: 'same_entity' });
        }
      }
    }
  }

  if (candidates.size === 0) return hits;

  // Rank: most-shared-with-the-top-k first (a candidate linked to several
  // finalized hits is more likely to be the missing connective fact than one
  // linked to only one), deterministic id tiebreak — Map iteration order is
  // insertion order, not a ranking, so a stable tiebreak matters for
  // reproducible test/eval output.
  const rankedIds = Array.from(candidates.entries())
    .sort((a, b) => b[1].sharedCount - a[1].sharedCount || (a[0] < b[0] ? -1 : 1))
    .slice(0, opts.maxExtra)
    .map(([id]) => id);

  if (rankedIds.length === 0) return hits;

  // Re-apply the IDENTICAL post-fusion filters + bitemporal validity window
  // search() used for `hits` (see EvidenceBundleSqlContext's doc comment) —
  // an enrichment pull must never surface an atom project/scope/type/agent/
  // since filtering or the as_of/validity window would have excluded.
  // `filters.entity` narrowing is NOT reapplied here (see that doc comment
  // for why) — a relevance-scoping gap, not a tenant/security one.
  const idPlaceholders = rankedIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, type, text, scope, importance, confidence, created_at, capture_source, evidence, evidence_span
       FROM memories WHERE id IN (${idPlaceholders}) AND ${sql.validityClause}${sql.whereFilter}`,
    )
    .all(...rankedIds, ...sql.validityParams, ...sql.filterParams) as Array<{
    id: string;
    type: MemoryType;
    text: string;
    scope: MemoryScope;
    importance: number;
    confidence: number;
    created_at: number;
    capture_source: string | null;
    evidence: string | null;
    evidence_span: string | null;
  }>;

  if (rows.length === 0) return hits;

  // Synthetic score: below every real (fused/reranked) hit in this result —
  // enrichment atoms were never scored by fusion, so they must never outrank
  // a genuinely-scored hit. `bundled`/`bundle_reason` are the actual signal
  // a consumer should key off; `score` only keeps the [0,1] wire contract
  // and a sane relative position when a consumer sorts by it.
  const floorScore = Math.min(...hits.map(h => h.score)) * 0.5;

  const extras: SearchHit[] = rows.map(r => {
    const reason = candidates.get(r.id)!.reason;
    const evidenceExcerpt = (r.evidence_span || r.evidence)?.slice(0, MAX_EVIDENCE_EXCERPT_CHARS);
    return {
      id: r.id,
      type: r.type,
      text: r.text,
      score: floorScore,
      // Fusion-leg indicator doesn't apply to a bundled atom (it was never
      // gathered via FTS or vec this call) — 'both' is the least-wrong value
      // of the existing union rather than widening it for one caller;
      // `bundled`/`bundle_reason` are the fields a consumer should actually
      // read for this hit's provenance.
      source: 'both',
      scope: r.scope,
      importance: r.importance,
      confidence: r.confidence,
      created_at: new Date(r.created_at).toISOString(),
      ...(r.capture_source !== null ? { capture_source: r.capture_source } : {}),
      ...(evidenceExcerpt ? { evidence: evidenceExcerpt } : {}),
      bundled: true,
      bundle_reason: reason,
      explanation: {
        final: floorScore,
        signals: { evidence_bundle: { raw: 1, weight: 1, final: floorScore } },
        top_signal: 'evidence_bundle',
      },
    };
  });

  return [...hits, ...extras];
}
