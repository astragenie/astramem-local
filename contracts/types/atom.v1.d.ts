/* eslint-disable */
/**
 * GENERATED — do not edit. Source: contracts/schemas/atom.v1.schema.json
 * Regenerate: node contracts/generate-types.mjs
 */

/**
 * Canonical Memory Atom v1 (ADR-001). Single schema both astramem-local and AstraMem cloud implement. Additive fields = minor version; breaking changes = new major with a dual-read window.
 */
export interface AtomV1 {
  schema: 'astramem/atom@1';
  id: string;
  /**
   * Registry-extensible, closed by default. v1 registry = the canonical 10-value union ratified by ADR D4 (U4 contract-unification): decision, fact, lesson, command, todo, note, event (astramem-local's 7 today) plus preference, task_result, summary (cloud-only today, until local adds writers). New types are additive (minor version bump); consumers seeing an unknown type should degrade gracefully rather than reject the atom.
   */
  type:
    'decision' | 'fact' | 'lesson' | 'command' | 'todo' | 'note' | 'event' | 'preference' | 'task_result' | 'summary';
  /**
   * Canonical normalized text.
   */
  text: string;
  /**
   * Receipts — never optional. ADR-001 specifies an array of {transcript_id, span} references. Reality: astramem-local v1 stores evidence as a single free-text excerpt string (see src/contracts/memory.ts Memory.evidence, migration 004-provenance.sql). This schema models both forms as the pragmatic contract truth; see contracts/README.md 'Evidence reconciliation' for the migration path from string -> array-of-refs.
   */
  evidence:
    | string
    | [
        {
          transcript_id: string;
          /**
           * @minItems 2
           * @maxItems 2
           */
          span?: [number, number];
        },
        ...{
          transcript_id: string;
          /**
           * @minItems 2
           * @maxItems 2
           */
          span?: [number, number];
        }[]
      ];
  /**
   * Extractor confidence.
   */
  confidence: number;
  importance: number;
  /**
   * Where this atom came from. Local maps its flat memories columns (agent, session_id, repo, project) plus a static extractor tag onto this object at the wire boundary (see src/contracts/atom-wire.ts).
   */
  provenance: {
    /**
     * e.g. claude-code | codex | cursor | runner-plugin
     */
    tool?: string | null;
    session_id?: string | null;
    repo?: string | null;
    project?: string | null;
    /**
     * name@version of the extractor that produced this atom.
     */
    extractor?: string | null;
  };
  /**
   * Bitemporal valid-time start.
   */
  valid_from: string;
  /**
   * Bitemporal valid-time end. null = currently valid.
   */
  valid_to: string | null;
  superseded_by?: string | null;
  /**
   * Consolidation lineage (ADR-004 stage 9).
   */
  derived_from?: string[] | null;
  /**
   * ADR-009 memory scope. personal is the default.
   */
  scope: 'personal' | 'team' | 'org';
  /**
   * sha256 hex digest — dedup + sync idempotency (ADR-003).
   */
  content_hash: string;
  entities?: string[];
  created_at: string;
  updated_at: string;
}
