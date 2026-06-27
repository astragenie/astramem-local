/**
 * Filters applied to vector search. Implementations MUST throw if they cannot
 * honor a non-empty filter — silent ignore is a contract violation.
 */
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

/**
 * Vector store contract. v1 ships sqlite-vec only. LanceDB lands in a later
 * wave behind the same interface; add 'lancedb' to the union when that
 * implementation exists.
 */
export interface VectorStore {
  readonly name: 'sqlite-vec';
  upsert(id: string, vec: Float32Array): Promise<void>;
  search(vec: Float32Array, k: number, filter?: VecFilter): Promise<VecHit[]>;
  /**
   * Erase all stored vectors. Used as the wipe primitive ahead of a
   * re-embed pass orchestrated by a Wave 3 worker. Does NOT repopulate.
   */
  clear(): Promise<void>;
}
