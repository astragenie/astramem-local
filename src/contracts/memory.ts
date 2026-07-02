export type MemoryType = 'decision' | 'fact' | 'lesson' | 'command' | 'todo' | 'note' | 'event';

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
  /** Bitemporal valid-time start (ADR-001). Mirrors created_at at insert time. */
  valid_from: number;
  /** Bitemporal valid-time end. NULL = currently valid. */
  valid_to: number | null;
  /** Id of the memory that superseded this one (lifecycle ops, Wave 2b). */
  superseded_by: string | null;
  /** Consolidation lineage — memory ids this atom was derived from. */
  derived_from: string[] | null;
  /** ADR-009 scope. Defaults to 'personal'. */
  scope: MemoryScope;
}
