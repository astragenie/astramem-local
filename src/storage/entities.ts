/**
 * entities + memory_entities repo (FEAT-402 slice 1, migration 012).
 *
 * `entities.name` is UNIQUE and always stores the NORMALIZED form
 * (src/entity/normalize.ts normalizeEntityName — AC-9's single seam), so
 * `upsert('Postgres', 'tech')` and `upsert('postgres', 'tech')` resolve to
 * the same row. `memory_entities` is a plain link table written by both the
 * distill-time embed-index stage (same LLM call as atom extraction) and the
 * `entity-backfill` CLI command for the pre-existing corpus.
 */

import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { normalizeEntityName } from '../entity/normalize.js';

export interface EntityRow {
  id: string;
  name: string;
  kind: string;
}

export interface EntityInput {
  name: string;
  kind: string;
}

export class EntityRepo {
  constructor(private db: DB) {}

  /**
   * Resolve `name` (normalized) to an entities.id, creating the row if it
   * doesn't exist yet. `kind` is only applied on first-create — a later call
   * with a different kind for the same normalized name does NOT overwrite
   * it (first-writer-wins avoids kind flip-flopping across distill runs).
   */
  upsert(name: string, kind: string): string {
    const normalized = normalizeEntityName(name);
    const existing = this.db
      .prepare('SELECT id FROM entities WHERE name = ?')
      .get(normalized) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = randomUUID();
    this.db.prepare('INSERT INTO entities (id, name, kind) VALUES (?, ?, ?)').run(id, normalized, kind);
    return id;
  }

  /** Idempotent link — INSERT OR IGNORE on the (memory_id, entity_id) PK. */
  link(memoryId: string, entityId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)')
      .run(memoryId, entityId);
  }

  /**
   * Upsert + link every entity in one call — the shape both the distill-time
   * embed-index stage and the backfill command consume. No-op for an empty
   * or missing list.
   */
  linkEntitiesForMemory(memoryId: string, entities: EntityInput[] | undefined): void {
    if (!entities || entities.length === 0) return;
    for (const e of entities) {
      const entityId = this.upsert(e.name, e.kind);
      this.link(memoryId, entityId);
    }
  }

  /** Remove every memory_entities row for one memory (AC-3 supersede cascade). */
  unlinkMemory(memoryId: string): void {
    this.db.prepare('DELETE FROM memory_entities WHERE memory_id = ?').run(memoryId);
  }

  /** All entities linked to a memory — used by tests and the (slice 2) query surface. */
  listForMemory(memoryId: string): EntityRow[] {
    return this.db
      .prepare(`
        SELECT e.id, e.name, e.kind
        FROM entities e
        JOIN memory_entities me ON me.entity_id = e.id
        WHERE me.memory_id = ?
        ORDER BY e.name ASC
      `)
      .all(memoryId) as EntityRow[];
  }

  /** True when `name` (normalized) already resolves to an entities row. */
  exists(name: string): boolean {
    const normalized = normalizeEntityName(name);
    const row = this.db.prepare('SELECT 1 AS x FROM entities WHERE name = ?').get(normalized);
    return row !== undefined;
  }
}
