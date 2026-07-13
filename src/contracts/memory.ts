/** Single runtime source of truth for memory types — CLI validation and any
 *  future enum checks must use this array, not a hand-copied list (the CLI
 *  once drifted to a stale 5-type copy and silently rejected note/event).
 *
 *  U4-local (#111, ADR D4): reconciled to the canonical ~10-value union
 *  shared with `@astragenie/astramem-contracts` (`contracts/schemas/
 *  atom.v1.schema.json` `type` enum) — astramem-local's original 7
 *  (`decision`..`event`) plus 3 cloud-only types (`preference`,
 *  `task_result`, `summary`).
 *
 *  The `memories.type` SQLite CHECK constraint was widened to match
 *  (migrations/017-widen-memory-types.sql) — a real INSERT of `preference`/
 *  `task_result`/`summary` no longer throws at the DB layer. The MCP
 *  `remember` tool (src/mcp/server.ts) and the REST `POST /remember` route
 *  (src/server/routes/search.ts) both write against this widened union as
 *  part of the canonical cross-repo save-contract unification.
 *  The distill pipeline's own extraction registry (`src/distill/prompts/
 *  extract.ts` AtomSchema) and `src/pipeline/handlers/distill-events.ts`
 *  are deliberately left at 7 — those are separate writer-surface
 *  contracts (the LLM extractor itself never emits the 3 cloud types),
 *  out of scope for this change. */
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

/** ADR-009 memory scope — private is the default for all local-agent writes.
 *  Renamed from 'personal' (DEC-048, U7-local astramem-local#110); team/org
 *  are unchanged. */
export type MemoryScope = 'private' | 'team' | 'org';

/**
 * One-release inbound alias (U7-local astramem-local#110, DEC-048): accepts
 * the pre-rename 'personal' literal on top of the canonical MemoryScope so
 * older clients/plugins that still send it don't break. Boundary-only type —
 * nothing in storage or contracts/schemas' *required* enum should ever store
 * or require the literal 'personal'; normalizeScopeAlias() below converts it
 * before it reaches persistence.
 *
 * TODO(remove-personal-alias): drop this type, normalizeScopeAlias(), and
 * the wire schemas' additive 'personal' enum value in the release AFTER this
 * one — tracked in astramem-local#115.
 */
export type MemoryScopeAlias = MemoryScope | 'personal';

/**
 * Normalize an inbound scope value that may still carry the pre-rename
 * 'personal' literal (DEC-048 one-release alias) to the canonical
 * MemoryScope. Apply at every boundary that parses a client-supplied scope
 * (currently: POST /memory/:id/promote) so no new row ever persists the
 * literal 'personal'.
 */
export function normalizeScopeAlias(scope: MemoryScopeAlias): MemoryScope {
  return scope === 'personal' ? 'private' : scope;
}

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
  /** ADR-009 scope. Defaults to 'private'. */
  scope: MemoryScope;
  /** TTL/archival tiers (FEAT-404). true once the archival policy (or a
   *  direct MemoryEventRepo.archive() call) has archived this atom — set in
   *  the same transaction as valid_to, non-destructively (row survives,
   *  restorable via MemoryEventRepo.restore()). */
  archived: boolean;
  /** Epoch ms the archive transition happened; null while archived=false. */
  archived_at: number | null;
  /** FEAT-455 / ADR-012 decision 4, widened 2026-07-12: `'auto_capture'`
   *  from the hook-tap auto-capture trigger, `'hook_close'` from the
   *  ordinary astramem-plugin close-capture hook, `null` for every other
   *  write path (`/remember`, manual hook capture predating FEAT-449, Codex
   *  capture — the vast majority of rows). Widened again FEAT-458 S3:
   *  `'proxy'` from the LLM proxy relay's capture fork (ADR-013). See
   *  InsertInput.capture_source. */
  capture_source: 'auto_capture' | 'hook_close' | 'proxy' | null;
}
