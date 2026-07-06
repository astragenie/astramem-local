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
    type?: (
      'decision' | 'fact' | 'lesson' | 'command' | 'todo' | 'note' | 'event' | 'preference' | 'task_result' | 'summary'
    )[];
    /**
     * ADR-009 memory scope. private is the default (renamed from 'personal', U7-local astramem-local#110, DEC-048); 'personal' is additively accepted for one release. TODO(remove-personal-alias): drop 'personal' from this enum in the release AFTER this one (tracked in astramem-local#115).
     */
    scope?: ('private' | 'team' | 'org' | 'personal')[];
    repo?: string;
    /**
     * FEAT-424 canonical project filter: exact match. A single string is `= ?`; a string[] is `IN (...)` (OR-semantics). An empty array is 'no constraint', never match-nothing.
     */
    project?: string | string[];
    /**
     * FEAT-424 canonical agent filter: exact match on provenance agent/agent_type. A single string is `= ?`; a string[] is `IN (...)` (OR-semantics). AND-composes with `project` when both are present.
     */
    agent?: string | string[];
    /**
     * FEAT-424/FEAT-402: entity name filter, resolved via the engine's normalize seam (case/whitespace-insensitive, exact match then substring fallback). An unresolvable name yields zero results.
     */
    entity?: string;
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
