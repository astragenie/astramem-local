/* eslint-disable */
/**
 * GENERATED — do not edit. Source: contracts/schemas/retrieval-result.v1.schema.json
 * Regenerate: node contracts/generate-types.mjs
 */

/**
 * Result envelope for the shared retrieval contract (ADR-005). Required core = what EVERY implementation can produce; optional fields = best-effort enrichment (cloud fills more than local today). additionalProperties stays FALSE everywhere: a closed schema with declared optionals gives extensibility AND drift detection. An open schema would legalise the silent divergence that white-paged the cloud dashboard three times. Widened 2026-07-13 (CONTRACT-FREEZE, astragenie/memory#759) to carry cloud's full 15-field hit shape as declared optionals — no field is dropped on either side (see the cloud field-mapping table in the freeze doc).
 */
export interface RetrievalResultV1 {
  schema: 'astramem-retrieval-result@1';
  /**
   * Echo of the originating query, for trace correlation. Cloud's top-level `mode` moves here.
   */
  query?: {
    text?: string;
    mode?: 'keyword' | 'semantic' | 'hybrid';
  };
  hits: {
    id: string;
    /**
     * Same 10-value union as atom.v1/v2 `type` (ADR D4). Widened from the original 7 (2026-07-09): preference/task_result/summary were missing even though cloud already returns them — a conformant hit from a real cloud response used to fail this schema.
     */
    type:
      'decision' | 'fact' | 'lesson' | 'command' | 'todo' | 'note' | 'event' | 'preference' | 'task_result' | 'summary';
    text: string;
    /**
     * Final fused score.
     */
    score: number;
    /**
     * ADR-009 memory scope. private|team|org only. atom@2 cut (2026-07-09): the 'personal' alias tracked as TODO(remove-personal-alias) (astramem-local#115) is dropped from this result enum in the same breaking window.
     */
    scope?: 'private' | 'team' | 'org';
    /**
     * ScoreExplanation (ADR-005): per-signal raw score, weight, and contribution to the final score.
     */
    explanation: {
      /**
       * Sum of all signal contributions; matches the hit's top-level `score`.
       */
      final: number;
      /**
       * Open map keyed by signal name (e.g. bm25, cosine, importance, freshness, usefulness locally; cloud's vector/keyword/importance/recency/usage, including RRF/cross-encoder signals, both validate here).
       */
      signals: {
        [k: string]: {
          raw: number;
          weight: number;
          final: number;
        };
      };
      /**
       * OPTIONAL (added 2026-07-13, CONTRACT-FREEZE §2). Human-readable summary. Cloud already emits this (ScoreExplanationDto.reason) and had nowhere to put it under a closed schema; local does not generate one today and omits the key rather than fake it.
       */
      reason?: string;
    };
    /**
     * OPTIONAL (added 2026-07-13). Local already stores this (atom@2 requires it) and was projecting it away.
     */
    importance?: number;
    /**
     * OPTIONAL (added 2026-07-13). Cloud's `confidence_score`. Local already stores this (atom@2 requires it).
     */
    confidence?: number;
    /**
     * OPTIONAL (added 2026-07-13). Local already stores this (atom@2 requires it).
     */
    created_at?: string;
    /**
     * OPTIONAL (added 2026-07-13). Origin of the memory. Maps to local's `memories.capture_source` column (migration 024).
     */
    source?: string;
    /**
     * OPTIONAL (added 2026-07-13). Cloud only today — local has no tags column, omits the key rather than fake it.
     */
    tags?: string[];
    /**
     * OPTIONAL (added 2026-07-13). Cloud only today — local has no usage_count column, omits the key rather than fake it.
     */
    usage_count?: number;
    /**
     * OPTIONAL (added 2026-07-13). Free-form; the one place an open map is intentional. Nullable: cloud emits `"metadata": null` for a memory with none, rather than omitting the key — caught by validating a LIVE cloud response against this schema, not a fixture. Same nullable treatment as `embedding_error`.
     */
    metadata?: {
      [k: string]: unknown;
    } | null;
    /**
     * OPTIONAL (added 2026-07-13). Cloud's `content_preview_highlights` — character ranges into `text`, plus the matched term. Shape mirrors cloud's long-standing HighlightRangeDto {start, end, term} — the freeze doc originally said {start, length}, which was invented rather than checked against the real DTO. Local has no FTS snippet extraction yet and omits the key rather than fake it.
     */
    highlights?: {
      start: number;
      end: number;
      term?: string;
    }[];
  }[];
  total?: number;
  /**
   * OPTIONAL (added 2026-07-13, CONTRACT-FREEZE §4.3). Non-null when the embedding provider failed and the result is DEGRADED (keyword-only). Cloud emits this today and it must not be lost — a silently degraded search is the worst failure mode for a memory product. Local's search() already has an equivalent internal fallback (vector search try/catch in search.ts) but does not yet surface the failure reason on the wire — tracked as a follow-up, not implemented in this slice.
   */
  embedding_error?: string | null;
  /**
   * OPTIONAL (added 2026-07-13). Trace correlation handle.
   */
  search_log_id?: string;
}
