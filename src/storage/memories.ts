import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { Memory, MemoryScope, MemoryType } from '../contracts/index.js';
import type { MemoryEventRepo } from './memory-events.js';

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
  /** ADR-009 scope. Defaults to 'private'. */
  scope?: MemoryScope;
}

/** Raw DB row shape — derived_from is stored as a JSON string (hydrated to
 *  string[] | null in get()); archived is stored as SQLite INTEGER 0/1
 *  (hydrated to boolean). */
type MemoryRow = Omit<Memory, 'derived_from' | 'archived'> & { derived_from: string | null; archived: number };

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
    return this.insertRow(input);
  }

  /**
   * Insert + append a 'create' memory_event (ADR-002) in the SAME
   * transaction. Dedup-aware like insert(): if a memory with this hash
   * already exists, no row is inserted and no event is appended — matches
   * insert()'s existing dedup semantics, so a re-ingest never fabricates a
   * duplicate create event for an atom that already has one.
   */
  insertWithCreateEvent(input: InsertInput, events: MemoryEventRepo): { id: string; created: boolean } {
    const tx = this.db.transaction((): { id: string; created: boolean } => {
      const existing = this.db.prepare('SELECT id FROM memories WHERE hash = ?').get(input.hash) as {id: string} | undefined;
      if (existing) return { id: existing.id, created: false };
      const id = this.insertRow(input);
      // Ship the content + materialization metadata in the create-event
      // payload so cloud-replicated atoms are non-empty and searchable
      // (astramem-local#80 / memory#618). The cloud materializer reads
      // text/type/scope/importance/confidence/repo from this payload; a
      // null payload previously landed atoms with empty content. Private
      // atoms never ship (the shipper scope-filters), so this only leaves
      // the machine for team/org scope. valid_from is omitted — the cloud
      // falls back to the event's created_at.
      events.append({
        event_type: 'create',
        atom_id: id,
        content_hash: input.hash,
        payload: {
          text: input.text,
          type: input.type,
          scope: input.scope ?? 'private',
          importance: input.importance ?? 0.5,
          confidence: input.confidence ?? 0.5,
          repo: input.repo ?? input.project ?? '',
        },
      });
      return { id, created: true };
    });
    return tx();
  }

  /** Raw insert — no dedup check (caller has already decided to insert). */
  private insertRow(input: InsertInput): string {
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
      now, now, input.source_hash, input.evidence ?? null, now, input.scope ?? 'private'
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
      archived: row.archived === 1,
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
