export type MemoryType = 'decision' | 'fact' | 'lesson' | 'command' | 'todo';

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
}
