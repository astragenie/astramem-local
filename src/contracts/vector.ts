export interface VecFilter {
  type?: string[];
  repo?: string;
  project?: string;
  since?: number;
}

export interface VecHit {
  id: string;
  score: number;
}

export interface VectorStore {
  readonly name: 'sqlite-vec' | 'lancedb';
  upsert(id: string, vec: Float32Array): Promise<void>;
  search(vec: Float32Array, k: number, filter?: VecFilter): Promise<VecHit[]>;
  rebuild(): Promise<void>;
}
