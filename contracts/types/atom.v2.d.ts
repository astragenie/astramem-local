/* eslint-disable */
/**
 * GENERATED — do not edit. Source: contracts/schemas/atom.v2.schema.json
 * Regenerate: node contracts/generate-types.mjs
 */

/**
 * Canonical Memory Atom v2 (ADR-001 amendment, 2026-07-09). Breaking major bump from atom@1 — zero-customers window used to fix three warts in one cut rather than carry additive debt: (1) entities is now a typed object array instead of string[]; (2) provenance.repo is deleted (project is the single canonical field); (3) the 'personal' scope alias is dropped (private|team|org only). Shipped alongside atom.v1.schema.json for a time-boxed dual-read window on the cloud reader (see contracts/README.md 'Versioning rules' and the ADR-001 amendment) — atom@1 is NOT deleted by this change. FEAT-496 (2026-07-14) additively extended this same @2 schema — new optional evidence[].speaker_label/segment_start_ms and provenance.worker/model/attestation — per the additive-minor rule in 'Versioning rules' below; no version bump, atom@2 stays atom@2. See 'Memory atom v2' below for the full field list.
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
          /**
           * FEAT-496: optional speaker display name/label for this evidence span, as surfaced by a diarized or caption-labeled transcript source (e.g. meeting captions, ASR diarization). Distinct from provenance.tool/extractor — this identifies WHO spoke within the transcript, not what produced the atom. Meeting-level envelope fields (platform, meeting_id) do NOT belong here — they are FEAT-491's concern on capture-envelope.v1.schema.json, since they describe the capture session, not a single evidence span.
           */
          speaker_label?: string;
          /**
           * FEAT-496: optional segment-level start offset in milliseconds from the start of the source recording/transcript, complementing 'span' (which is a character offset into the transcript text). Present when the source has timing granularity (audio ASR, timestamped captions); absent for plain-text transcripts with no timing data.
           */
          segment_start_ms?: number;
        },
        ...{
          transcript_id: string;
          /**
           * @minItems 2
           * @maxItems 2
           */
          span?: [number, number];
          /**
           * FEAT-496: optional speaker display name/label for this evidence span, as surfaced by a diarized or caption-labeled transcript source (e.g. meeting captions, ASR diarization). Distinct from provenance.tool/extractor — this identifies WHO spoke within the transcript, not what produced the atom. Meeting-level envelope fields (platform, meeting_id) do NOT belong here — they are FEAT-491's concern on capture-envelope.v1.schema.json, since they describe the capture session, not a single evidence span.
           */
          speaker_label?: string;
          /**
           * FEAT-496: optional segment-level start offset in milliseconds from the start of the source recording/transcript, complementing 'span' (which is a character offset into the transcript text). Present when the source has timing granularity (audio ASR, timestamped captions); absent for plain-text transcripts with no timing data.
           */
          segment_start_ms?: number;
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
    /**
     * FEAT-496: reserved, currently unwritten by any producer. Compute-tier/worker identity that ran the extraction (e.g. local-cpu | local-gpu | cloud-worker), Screenpipe-inspired provenance triple alongside model/attestation. Freeform string, no enum yet — reserved now because it is additive-cheap and the alternative (adding it in a later @2 minor bump) is strictly more expensive than reserving the slot today.
     */
    worker?: string | null;
    /**
     * FEAT-496: reserved, currently unwritten by any producer. name@version of the LLM/ASR model that ran the extraction (distinct from provenance.extractor, which names the pipeline/tool, not the underlying model). Freeform string, no enum.
     */
    model?: string | null;
    /**
     * FEAT-496: reserved, currently unwritten by any producer. Opaque attestation/signature string for the extraction (e.g. a hash or signed claim proving which worker/model ran), for future tamper-evidence use cases. Freeform string, no enum.
     */
    attestation?: string | null;
    /**
     * FEAT-496/ADR-017: whether the operator disclosure/opt-in required for capturing a non-user speaker (audio FEAT-489, meeting captions FEAT-491) was satisfied at capture time. Scoped onto atom@2 by ADR-017 deliberately, so consent provenance has one schema-change surface rather than being duplicated per capture source. null/absent = not applicable or not recorded (e.g. atoms with no non-user speaker involved); true/false = an explicit disclosure determination was made.
     */
    consent_disclosed?: boolean | null;
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
    /**
     * FEAT-453: bitemporal valid-time start for THIS entity link (fact-level, distinct from the atom's own valid_from). null = no stated fact-level start; resolves to the atom's own valid_from at query time.
     */
    valid_at?: string | null;
    /**
     * FEAT-453: bitemporal valid-time end for THIS entity link. null = not known to have stopped being true.
     */
    invalid_at?: string | null;
  }[];
  created_at: string;
  updated_at: string;
}
