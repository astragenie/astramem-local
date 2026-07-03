import type { DB } from '../storage/db.js';
import type { VectorStore, VecFilter, VecHit } from '../contracts/index.js';
import { DEFAULT_EMBED_DIM } from '../contracts/embed.js';

export class SqliteVecStore implements VectorStore {
  readonly name = 'sqlite-vec' as const;
  /** FEAT-409: dim defaults to DEFAULT_EMBED_DIM (1024) for backward
   * compat — callers with a config/provider in scope should pass
   * embed.dim (or cfg.embedding.dim) explicitly so this matches the
   * memories_vec schema the DB was actually created with. */
  constructor(private db: DB, private dim: number = DEFAULT_EMBED_DIM) {}

  async upsert(id: string, vec: Float32Array): Promise<void> {
    if (vec.length !== this.dim) throw new Error(`expected dim ${this.dim}, got ${vec.length}`);
    const memoriesRowid = this.allocateRowid(id);
    const buf = Buffer.from(vec.buffer);
    const existing = this.db.prepare('SELECT rowid FROM memories_vec WHERE rowid = ?').get(BigInt(memoriesRowid)) as {rowid: number} | undefined;
    if (existing) {
      this.db.prepare('UPDATE memories_vec SET embedding = ? WHERE rowid = ?').run(buf, BigInt(memoriesRowid));
    } else {
      this.db.prepare('INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)').run(BigInt(memoriesRowid), buf);
    }
  }

  async search(vec: Float32Array, k: number, filter?: VecFilter): Promise<VecHit[]> {
    if (filter && (filter.type?.length || filter.repo || filter.project || filter.since !== undefined)) {
      throw new Error('VecFilter not yet implemented in sqlite-vec adapter — apply filters in the search layer instead');
    }
    const rows = this.db.prepare(`
      SELECT m.id, mv.distance
      FROM memories_vec mv
      JOIN memories m ON m.rowid = mv.rowid
      WHERE mv.embedding MATCH ? AND mv.k = ?
    `).all(Buffer.from(vec.buffer), k) as {id: string, distance: number}[];
    return rows.map(r => ({ id: r.id, score: 1 / (1 + r.distance) }));
  }

  async clear(): Promise<void> {
    this.db.exec('DELETE FROM memories_vec');
  }

  private allocateRowid(id: string): number {
    const r = this.db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as {rowid: number} | undefined;
    if (!r) throw new Error(`memory ${id} not in memories table — insert there first`);
    return r.rowid;
  }
}
