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

  /** Single entity by id — GET /entities/:id/memories 404s when this returns undefined. */
  getById(id: string): EntityRow | undefined {
    return this.db.prepare('SELECT id, name, kind FROM entities WHERE id = ?').get(id) as EntityRow | undefined;
  }

  /**
   * Autocomplete (FEAT-402 slice 2 AC-5, `GET /entities?q=`) — substring
   * match on the normalized name, case/whitespace-insensitive via the same
   * AC-9 seam every other lookup goes through. Empty/whitespace `query`
   * returns the first `limit` entities alphabetically rather than nothing,
   * so an empty-q autocomplete call still has sane behavior.
   */
  search(query: string, limit = 20): EntityRow[] {
    const normalized = normalizeEntityName(query);
    if (!normalized) {
      return this.db
        .prepare('SELECT id, name, kind FROM entities ORDER BY name ASC LIMIT ?')
        .all(limit) as EntityRow[];
    }
    const escaped = escapeLike(normalized);
    return this.db
      .prepare(`SELECT id, name, kind FROM entities WHERE name LIKE ? ESCAPE '\\' ORDER BY name ASC LIMIT ?`)
      .all(`%${escaped}%`, limit) as EntityRow[];
  }

  /**
   * Resolve a free-form entity query (e.g. the search `entity=` filter,
   * FEAT-402 slice 2 AC-4) to entity ids via the AC-9 normalize seam: exact
   * match on the normalized name first, falling back to a LIKE substring
   * match only when no exact row exists. Returns [] when nothing matches —
   * callers MUST treat that as "no entity-linked candidates" rather than
   * falling back to an unfiltered search.
   */
  resolveIds(query: string): string[] {
    const normalized = normalizeEntityName(query);
    if (!normalized) return [];
    const exact = this.db.prepare('SELECT id FROM entities WHERE name = ?').get(normalized) as
      | { id: string }
      | undefined;
    if (exact) return [exact.id];
    const escaped = escapeLike(normalized);
    const rows = this.db
      .prepare(`SELECT id FROM entities WHERE name LIKE ? ESCAPE '\\'`)
      .all(`%${escaped}%`) as { id: string }[];
    return rows.map(r => r.id);
  }

  /**
   * All distinct memory ids linked to any of `entityIds` — the join behind
   * both the search `entity=` pre-fusion intersection (AC-4) and
   * `GET /entities/:id/memories` (AC-5). Empty input returns an empty set
   * rather than every memory (an empty entityIds list is never "no filter").
   */
  memoryIdsForEntities(entityIds: string[]): Set<string> {
    if (entityIds.length === 0) return new Set();
    const placeholders = entityIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT DISTINCT memory_id FROM memory_entities WHERE entity_id IN (${placeholders})`)
      .all(...entityIds) as { memory_id: string }[];
    return new Set(rows.map(r => r.memory_id));
  }
}

/** Escape SQL LIKE wildcards (`%`, `_`) in a substring pattern the caller
 * did not intend as wildcard syntax — used with `ESCAPE '\\'` above. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}
