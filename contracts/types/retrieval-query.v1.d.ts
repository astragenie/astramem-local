/* eslint-disable */
/**
 * GENERATED — do not edit. Source: contracts/schemas/retrieval-query.v1.schema.json
 * Regenerate: node contracts/generate-types.mjs
 */

/**
 * Query envelope for the shared retrieval contract (ADR-005). Both engines accept this envelope; they may differ internally in how they satisfy it.
 */
export interface RetrievalQueryV1 {
  /**
   * Free-form query text. May be empty for filter-only browsing.
   */
  text: string;
  mode: 'keyword' | 'semantic' | 'hybrid';
  filters?: {
    type?: ('decision' | 'fact' | 'lesson' | 'command' | 'todo' | 'note' | 'event')[];
    scope?: ('personal' | 'team' | 'org')[];
    repo?: string;
    project?: string;
    /**
     * Lower bound on created_at.
     */
    since?: string;
    /**
     * Bitemporal time-travel: return the atom state as it was valid at this instant (ADR-001/ADR-005).
     */
    as_of?: string;
  };
  limit?: number;
  /**
   * Explanations are not optional per ADR-005 result contract, but the caller can still choose whether to request the extra payload weight.
   */
  explain?: boolean;
}
