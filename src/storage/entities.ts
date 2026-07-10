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

  /**
   * Idempotent link with no stated validity window (valid_at/invalid_at both
   * NULL) — the FEAT-402 default. Since migration 023 (FEAT-453), the table
   * PK is a surrogate `id`, not the composite (memory_id, entity_id), so
   * idempotency on a re-call now comes from `idx_memory_entities_open_window`
   * (the partial unique index on open rows, §1.4 of the design doc) rather
   * than the old composite PK — `INSERT OR IGNORE` still silently no-ops a
   * duplicate open-window insert for the same pair either way, so this
   * method's behavior for existing callers is unchanged.
   */
  link(memoryId: string, entityId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO memory_entities (id, memory_id, entity_id) VALUES (?, ?, ?)')
      .run(randomUUID(), memoryId, entityId);
  }

  /**
   * Fact-level link with an explicit validity window (FEAT-453 §1.3). `{}`
   * (both null) is byte-identical in effect to `link()` — same idempotent
   * no-op via `idx_memory_entities_open_window` when an open row already
   * exists for this pair, so a dedup-replay re-call (e.g. re-ingesting a
   * memory whose hash already exists) is still a safe no-op. To REPLACE an
   * already-open window with a new one (e.g. a stated correction), close the
   * old row first via `closeAndRelink` — this method alone will not do that;
   * it only ever adds a new row or silently skips when one is already open.
   */
  linkWithValidity(
    memoryId: string,
    entityId: string,
    opts: { validAt?: number | null; invalidAt?: number | null } = {},
  ): void {
    this.db
      .prepare(`
        INSERT INTO memory_entities (id, memory_id, entity_id, valid_at, invalid_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (memory_id, entity_id) WHERE invalid_at IS NULL DO NOTHING
      `)
      .run(randomUUID(), memoryId, entityId, opts.validAt ?? null, opts.invalidAt ?? null);
  }

  /**
   * Close the currently-open window for (memoryId, entityId) at `closeAt`
   * and insert a new window in the same transaction (AC-2: proves the
   * surrogate PK allows a second row for the same pair once the first is
   * closed). No-op on the close side if no open row exists for the pair —
   * the insert still happens.
   */
  closeAndRelink(
    memoryId: string,
    entityId: string,
    closeAt: number,
    opts: { validAt?: number | null; invalidAt?: number | null } = {},
  ): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`
          UPDATE memory_entities SET invalid_at = ?
          WHERE memory_id = ? AND entity_id = ? AND invalid_at IS NULL
        `)
        .run(closeAt, memoryId, entityId);
      this.linkWithValidity(memoryId, entityId, opts);
    });
    tx();
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

  /**
   * Time-aware sibling of `memoryIdsForEntities` (FEAT-453 §3.3 composition
   * point B — `filters.entity` + `filters.as_of` together). A memory
   * qualifies only when a matched fact link's EFFECTIVE window covers
   * `asOf`: clipped to the parent memory's own valid_from/valid_to (§3.1),
   * computed at query time, never mutated onto the memory_entities row.
   * `9223372036854775807` is the same "+inf" epoch-ms sentinel the design
   * doc uses for an open (NULL) end bound. Empty entityIds returns an empty
   * set, same as `memoryIdsForEntities` (never "no filter").
   */
  memoryIdsForEntitiesAsOf(entityIds: string[], asOf: number): Set<string> {
    if (entityIds.length === 0) return new Set();
    const placeholders = entityIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`
        SELECT DISTINCT me.memory_id
        FROM memory_entities me
        JOIN memories m ON m.id = me.memory_id
        WHERE me.entity_id IN (${placeholders})
          AND MAX(COALESCE(me.valid_at, m.valid_from), m.valid_from) <= ?
          AND MIN(COALESCE(me.invalid_at, 9223372036854775807),
                  COALESCE(m.valid_to, 9223372036854775807)) > ?
      `)
      .all(...entityIds, asOf, asOf) as { memory_id: string }[];
    return new Set(rows.map(r => r.memory_id));
  }
}

/** Escape SQL LIKE wildcards (`%`, `_`) in a substring pattern the caller
 * did not intend as wildcard syntax — used with `ESCAPE '\\'` above. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}
