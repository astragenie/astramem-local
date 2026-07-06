/** Single runtime source of truth for memory types — CLI validation and any
 *  future enum checks must use this array, not a hand-copied list (the CLI
 *  once drifted to a stale 5-type copy and silently rejected note/event).
 *
 *  U4-local (#111, ADR D4): reconciled to the canonical ~10-value union
 *  shared with `@astragenie/astramem-contracts` (`contracts/schemas/
 *  atom.v1.schema.json` `type` enum) — astramem-local's original 7
 *  (`decision`..`event`) plus 3 cloud-only types (`preference`,
 *  `task_result`, `summary`). This widening is additive/type-level only:
 *  astramem-local does not yet WRITE the 3 cloud types anywhere (its own
 *  extraction registry in `src/distill/prompts/extract.ts` AtomSchema and
 *  the mirrored request-body enums in `src/server/routes/ingest.ts` /
 *  `src/pipeline/handlers/distill-events.ts` are deliberately left at 7 —
 *  those are local's writer-surface contracts, out of scope for #111/#112,
 *  not this shared type registry). The `memories.type` SQLite CHECK
 *  constraint (migrations/003-expand-memory-types.sql) ALSO still only
 *  allows the 7 local values — a real INSERT of a `preference`/
 *  `task_result`/`summary` row (e.g. a future sync-pull materializing a
 *  cloud-authored atom, see src/sync/puller.ts) will throw at the DB layer
 *  until a follow-up migration widens that CHECK. Storing the 3 new types
 *  locally is intentionally NOT implemented by this change — only the
 *  shared vocabulary is. */
export const MEMORY_TYPES = [
  'decision',
  'fact',
  'lesson',
  'command',
  'todo',
  'note',
  'event',
  'preference',
  'task_result',
  'summary',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** ADR-009 memory scope — personal is the default for all local-agent writes. */
export type MemoryScope = 'personal' | 'team' | 'org';

export interface Memory {
  id: string;
  type: MemoryType;
  text: string;
  normalized_text: string;
  repo: string | null;
  project: string | null;
  branch: string | null;
  agent: string | null;
  session_id: string | null;
  importance: number;
  confidence: number;
  hash: string;
  embedding_provider: string | null;
  embedding_model: string | null;
  embedding_dim: number | null;
  created_at: number;
  updated_at: number;
  source_hash: string | null;
  evidence: string | null;
  /** Bitemporal valid-time start (ADR-001). Set to created_at at insert time;
   *  advanced to the supersession instant when this atom becomes a successor
   *  (supersede() co-issues new.valid_from = old.valid_to — FEAT-401). */
  valid_from: number;
  /** Bitemporal valid-time end. NULL = currently valid. */
  valid_to: number | null;
  /** Id of the memory that superseded this one (lifecycle ops, Wave 2b). */
  superseded_by: string | null;
  /** Consolidation lineage — memory ids this atom was derived from. */
  derived_from: string[] | null;
  /** ADR-009 scope. Defaults to 'personal'. */
  scope: MemoryScope;
  /** TTL/archival tiers (FEAT-404). true once the archival policy (or a
   *  direct MemoryEventRepo.archive() call) has archived this atom — set in
   *  the same transaction as valid_to, non-destructively (row survives,
   *  restorable via MemoryEventRepo.restore()). */
  archived: boolean;
  /** Epoch ms the archive transition happened; null while archived=false. */
  archived_at: number | null;
}
