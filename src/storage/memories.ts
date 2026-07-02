import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { Memory, MemoryScope, MemoryType } from '../contracts/index.js';

export interface InsertInput {
  type: MemoryType;
  text: string;
  normalized_text: string;
  repo: string | null;
  project: string | null;
  branch: string | null;
  agent: string | null;
  session_id: string | null;
  hash: string;
  source_hash: string | null;
  importance?: number;
  confidence?: number;
  embedding_provider?: string | null;
  embedding_model?: string | null;
  embedding_dim?: number | null;
  evidence?: string | null;
  /** ADR-009 scope. Defaults to 'personal'. */
  scope?: MemoryScope;
}

/** Raw DB row shape — derived_from is stored as a JSON string, hydrated to string[] | null in get(). */
type MemoryRow = Omit<Memory, 'derived_from'> & { derived_from: string | null };

export interface FtsHit {
  id: string;
  text: string;
  type: MemoryType;
  bm25: number;
}

export class MemoryRepo {
  constructor(private db: DB) {}

  insert(input: InsertInput): string {
    const existing = this.db.prepare('SELECT id FROM memories WHERE hash = ?').get(input.hash) as {id: string} | undefined;
    if (existing) return existing.id;

    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, repo, project, branch, agent, session_id,
         importance, confidence, hash, embedding_provider, embedding_model, embedding_dim,
         created_at, updated_at, source_hash, evidence, valid_from, scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.type, input.text, input.normalized_text,
      input.repo, input.project, input.branch, input.agent, input.session_id,
      input.importance ?? 0.5, input.confidence ?? 0.5, input.hash,
      input.embedding_provider ?? null, input.embedding_model ?? null, input.embedding_dim ?? null,
      now, now, input.source_hash, input.evidence ?? null, now, input.scope ?? 'personal'
    );
    return id;
  }

  get(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? MemoryRepo.hydrate(row) : null;
  }

  /** Parse the JSON-stored derived_from column into a string[] | null. */
  private static hydrate(row: MemoryRow): Memory {
    return {
      ...row,
      derived_from: row.derived_from ? (JSON.parse(row.derived_from) as string[]) : null,
    };
  }

  searchFts(query: string, limit: number): FtsHit[] {
    const rows = this.db.prepare(`
      SELECT m.id, m.text, m.type, bm25(memories_fts) AS bm25
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
      ORDER BY bm25 LIMIT ?
    `).all(query, limit) as FtsHit[];
    return rows;
  }
}
