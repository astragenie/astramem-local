/* eslint-disable */
/**
 * GENERATED — do not edit. Source: contracts/schemas/retrieval-result.v1.schema.json
 * Regenerate: node contracts/generate-types.mjs
 */

/**
 * Result envelope for the shared retrieval contract (ADR-005). Every hit carries a ScoreExplanation — per ADR-005 this is the debugging/trust surface and is never optional, regardless of the query's `explain` flag. The signal map is open (additionalProperties) so cloud's 6-signal fusion and local's 4-signal fusion (bm25, cosine, importance, freshness — see src/search/fuse.ts) both validate without the schema hardcoding either engine's signal set.
 */
export interface RetrievalResultV1 {
  schema: 'astramem-retrieval-result@1';
  /**
   * Echo of the originating query, for trace correlation.
   */
  query?: {
    text?: string;
    mode?: 'keyword' | 'semantic' | 'hybrid';
  };
  hits: {
    id: string;
    type: 'decision' | 'fact' | 'lesson' | 'command' | 'todo' | 'note' | 'event';
    text: string;
    /**
     * Final fused score.
     */
    score: number;
    scope?: 'personal' | 'team' | 'org';
    /**
     * ScoreExplanation (ADR-005): per-signal raw score, weight, and contribution to the final score.
     */
    explanation: {
      /**
       * Sum of all signal contributions; matches the hit's top-level `score`.
       */
      final: number;
      /**
       * Open map keyed by signal name (e.g. bm25, cosine, importance, freshness locally; local's 4 signals or cloud's 6, including RRF/cross-encoder signals, both validate here).
       */
      signals: {
        [k: string]: {
          raw: number;
          weight: number;
          final: number;
        };
      };
    };
  }[];
  total?: number;
}
