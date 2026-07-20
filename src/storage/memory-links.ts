/**
 * memory_links repo (retrieval-overhaul Phase 6 / P6b, migration 056) —
 * deterministic atom-to-atom (memory-to-memory) links. See
 * src/distill/link-atoms.ts for how candidates are computed and
 * migrations/056-memory-links.sql for the schema rationale, including why
 * this is a SEPARATE table from `entity_relations` (src/storage/
 * entity-relations.ts) rather than a new predicate on it.
 */

import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { AtomLinkType } from '../distill/link-atoms.js';

export interface MemoryLinkInput {
  memoryIdA: string;
  memoryIdB: string;
  linkType: AtomLinkType;
  evidence: string;
  confidence?: number;
}

export interface MemoryLinkRow {
  id: string;
  memory_id_a: string;
  memory_id_b: string;
  link_type: AtomLinkType;
  evidence: string;
  confidence: number;
  created_at: number;
}

export interface MemoryLinkInsertResult {
  id: string;
  /** False when the (memory_id_a, memory_id_b, link_type) triple already
   *  existed (canonical order, see below) and the atomic dedup guard
   *  skipped the write. */
  inserted: boolean;
}

export class MemoryLinkRepo {
  constructor(private db: DB) {}

  /**
   * Insert-with-dedup-guard, same atomic `INSERT...SELECT...WHERE NOT
   * EXISTS` shape `EntityRelationRepo.insert()` uses (src/storage/
   * entity-relations.ts) — a single prepared statement, no separate
   * SELECT-then-INSERT round trip, closing the same TOCTOU race under
   * SQLite's single-writer lock.
   *
   * `memoryIdA`/`memoryIdB` are canonicalized to (min, max) by plain string
   * comparison BEFORE the write — the caller (08-embed-index.ts) does not
   * need to know or preserve any particular order when resolving link-atoms
   * candidates to real memory ids; a link is inherently symmetric.
   */
  insert(input: MemoryLinkInput): MemoryLinkInsertResult {
    if (input.memoryIdA === input.memoryIdB) {
      // Defensive — link-atoms.ts never generates a self-pair, but a
      // caller-level guard costs nothing and avoids a meaningless row if
      // one ever slipped through (e.g. two distinct contentHashes that
      // happened to resolve to the SAME deduped memory id via stage 8's own
      // hash-based dedup).
      return { id: '', inserted: false };
    }
    const [memoryIdA, memoryIdB] =
      input.memoryIdA < input.memoryIdB ? [input.memoryIdA, input.memoryIdB] : [input.memoryIdB, input.memoryIdA];

    const id = randomUUID();
    const confidence = input.confidence ?? 0.5;
    const createdAt = Date.now();
    const result = this.db
      .prepare(`
        INSERT INTO memory_links (id, memory_id_a, memory_id_b, link_type, evidence, confidence, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_links WHERE memory_id_a = ? AND memory_id_b = ? AND link_type = ?
        )
      `)
      .run(
        id, memoryIdA, memoryIdB, input.linkType, input.evidence, confidence, createdAt,
        memoryIdA, memoryIdB, input.linkType,
      );
    return { id, inserted: result.changes > 0 };
  }

  /** Every link row touching `memoryId`, in either position. */
  getForMemory(memoryId: string, limit = 50): MemoryLinkRow[] {
    return this.db
      .prepare(`
        SELECT id, memory_id_a, memory_id_b, link_type, evidence, confidence, created_at
        FROM memory_links
        WHERE memory_id_a = ? OR memory_id_b = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(memoryId, memoryId, limit) as MemoryLinkRow[];
  }
}
