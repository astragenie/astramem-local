/* eslint-disable */
/**
 * GENERATED — do not edit. Source: contracts/schemas/atom.v2.schema.json
 * Regenerate: node contracts/generate-types.mjs
 */

/**
 * Canonical Memory Atom v2 (ADR-001 amendment, 2026-07-09). Breaking major bump from atom@1 — zero-customers window used to fix three warts in one cut rather than carry additive debt: (1) entities is now a typed object array instead of string[]; (2) provenance.repo is deleted (project is the single canonical field); (3) the 'personal' scope alias is dropped (private|team|org only). Shipped alongside atom.v1.schema.json for a time-boxed dual-read window on the cloud reader (see contracts/README.md 'Versioning rules' and the ADR-001 amendment) — atom@1 is NOT deleted by this change.
 */
export interface AtomV2 {
  schema: 'astramem/atom@2';
  id: string;
  /**
   * Registry-extensible, closed by default. Same 10-value union as atom@1 (ADR D4) — unaffected by the atom@2 cut: decision, fact, lesson, command, todo, note, event, preference, task_result, summary.
   */
  type:
    'decision' | 'fact' | 'lesson' | 'command' | 'todo' | 'note' | 'event' | 'preference' | 'task_result' | 'summary';
  /**
   * Canonical normalized text.
   */
  text: string;
  /**
   * Receipts — never optional. Unchanged from atom@1; see contracts/README.md 'Evidence reconciliation'.
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
   * Where this atom came from. atom@2 BREAKING CHANGE: 'repo' is deleted — 'project' is the single canonical field (cloud already collapses project_id ?? repo onto one WorkspaceProjectId column; a still-populated repo filter could return false negatives under atom@1). Writers that only had a repo value should send it as 'project'.
   */
  provenance: {
    /**
     * e.g. claude-code | codex | cursor | runner-plugin
     */
    tool?: string | null;
    session_id?: string | null;
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
   * ADR-009 memory scope. atom@2 BREAKING CHANGE: the 'personal' alias (kept in atom@1 as a one-release dual-read accommodation, U7-local astramem-local#110, DEC-048, tracked as TODO(remove-personal-alias) astramem-local#115) is dropped. 'private' is the only low-rank value; new AND existing writers on atom@2 must emit private|team|org.
   */
  scope: 'private' | 'team' | 'org';
  /**
   * sha256 hex digest — dedup + sync idempotency (ADR-003).
   */
  content_hash: string;
  /**
   * atom@2 BREAKING CHANGE: typed entity objects instead of atom@1's flat string[]. The flat shape was lossy — astramem-local's own harness.ts:137 already re-synthesized a fake kind for every string, proving downstream consumers need kind. See ENTITY_KINDS (12-value registry) / ACTOR_KINDS in contracts/wire.ts.
   */
  entities?: {
    name: string;
    /**
     * 12-value canonical entity-kind registry. Mirrors ENTITY_KINDS in contracts/wire.ts (kept in sync by tests/contracts/entity-kind-parity.test.ts).
     */
    kind:
      | 'actor'
      | 'team'
      | 'org'
      | 'project'
      | 'product'
      | 'workitem'
      | 'decision'
      | 'tech'
      | 'tool'
      | 'concept'
      | 'event'
      | 'other';
    /**
     * Optional refinement, meaningful for actor-family kinds (see ACTOR_KINDS in contracts/wire.ts): human or AI agent.
     */
    subtype?: 'human' | 'ai';
  }[];
  created_at: string;
  updated_at: string;
}
