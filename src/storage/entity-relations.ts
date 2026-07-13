/**
 * entity_relations repo (FEAT-481 SLICE-1, migration 027) — entity-to-entity
 * relation triples. Cloud-parity storage primitive: see
 * docs/specs/FEAT-481-design.md §1/§3/§4.1 for the verified cross-repo shape
 * this mirrors, and migrations/027-entity-relations.sql for the schema.
 *
 * This slice owns storage only — no extraction wiring, no MCP tool surface
 * (those are later slices). supersede()'s cascade lives in
 * memory-events.ts (mirrors the existing memory_entities unlink, next to
 * it); erase()'s cascade needs no code here at all — it's `ON DELETE
 * CASCADE` + `foreign_keys=ON` (src/storage/db.ts), same as memory_entities.
 */

import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';

export interface EntityRelationInput {
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  evidenceMemoryId: string;
  sourceExcerpt: string;
  /** Model-reported confidence; defaults to 0.5 (matches the column default) when omitted. */
  confidence?: number;
  /** Always populated by the caller — never left to default here (§1 of the design doc: "never left NULL"). */
  validFrom: number;
  validTo?: number | null;
}

export interface EntityRelationRow {
  id: string;
  subject_entity_id: string;
  predicate: string;
  object_entity_id: string;
  evidence_memory_id: string;
  source_excerpt: string;
  confidence: number;
  valid_from: number;
  valid_to: number | null;
}

export interface EntityRelationInsertResult {
  /** The id that WOULD identify the row — only actually persisted when `inserted` is true. */
  id: string;
  /** False when the atomic dedup guard found an existing currently-valid row for the tuple and skipped the write. */
  inserted: boolean;
}

export interface EntityRelationQueryOpts {
  /** Defaults to the current wall-clock time (epoch ms) — "currently valid" is the same predicate with asOf bound to now. */
  asOf?: number;
  /** Defaults to 50 (matches the get_entity_related MCP tool default, §4.1). */
  limit?: number;
}

export type EntityRelationDirection = 'subject' | 'object' | 'both';

const RELATION_SELECT_COLUMNS = `
  er.id, er.subject_entity_id, er.predicate, er.object_entity_id,
  er.evidence_memory_id, er.source_excerpt, er.confidence,
  er.valid_from, er.valid_to
`;

/**
 * The JOIN-with-memories effective-validity predicate (design doc §4.1),
 * modeled directly on `memoryIdsForEntitiesAsOf` (entities.ts:223-238):
 * effective valid_from is the later of the relation's own valid_from and its
 * evidence memory's valid_from; effective valid_to is the earlier of the
 * two, treating a NULL end as +inf. This is what lets a relation sourced
 * from an `invalidate()`d memory stop reading as valid once `asOf` passes
 * that memory's own valid_to, even though entity_relations.valid_to itself
 * is untouched by invalidate() (AC-3) — the join is the only place this
 * promise can be honored.
 *
 * `9223372036854775807` (+inf sentinel for an open/NULL end bound, same
 * epoch-ms convention `memoryIdsForEntitiesAsOf` uses) is written directly
 * into the SQL text below, not held in a JS numeric constant and
 * interpolated in — a JS `number` can't represent that value exactly (it
 * silently rounds to the nearest double, e.g. `9223372036854776000`), so
 * the literal has to stay text, exactly how entities.ts:233-234 does it.
 */
const VALIDITY_PREDICATE = `
  AND MAX(COALESCE(er.valid_from, m.valid_from), m.valid_from) <= ?
  AND MIN(COALESCE(er.valid_to, 9223372036854775807),
          COALESCE(m.valid_to, 9223372036854775807)) > ?
`;

export class EntityRelationRepo {
  constructor(private db: DB) {}

  /**
   * Insert-with-dedup-guard (AC-2). The `INSERT...SELECT...WHERE NOT
   * EXISTS` MUST stay one atomic prepared statement — a single
   * `db.prepare(...).run(...)` call, no separate SELECT-then-INSERT round
   * trip. Splitting it into a `.get()` existence check followed by a
   * separate `.run()` insert reintroduces the exact TOCTOU race this guard
   * exists to close under SQLite's single-writer lock across concurrent
   * process (daemon/worker) writers — see design doc §3.4.
   *
   * "Currently-valid" for the dedup check is `valid_to IS NULL` on
   * entity_relations itself (not the memories-joined effective validity
   * §4.1 uses for reads) — two independent memories asserting the same
   * triple is corroborating evidence kept as distinct rows, not a
   * constraint violation; this guard only prevents re-asserting the exact
   * same still-open triple twice.
   */
  insert(input: EntityRelationInput): EntityRelationInsertResult {
    const id = randomUUID();
    const confidence = input.confidence ?? 0.5;
    const createdAt = Date.now();
    const result = this.db
      .prepare(`
        INSERT INTO entity_relations
          (id, subject_entity_id, predicate, object_entity_id, evidence_memory_id,
           source_excerpt, confidence, valid_from, valid_to, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM entity_relations
          WHERE subject_entity_id = ? AND predicate = ? AND object_entity_id = ? AND valid_to IS NULL
        )
      `)
      .run(
        id,
        input.subjectEntityId,
        input.predicate,
        input.objectEntityId,
        input.evidenceMemoryId,
        input.sourceExcerpt,
        confidence,
        input.validFrom,
        input.validTo ?? null,
        createdAt,
        input.subjectEntityId,
        input.predicate,
        input.objectEntityId,
      );
    return { id, inserted: result.changes > 0 };
  }

  /** Relations where `subjectEntityId` is the subject role — AC-3's JOIN-with-memories contract. */
  getForSubject(subjectEntityId: string, opts: EntityRelationQueryOpts = {}): EntityRelationRow[] {
    return this.queryByRole('subject', subjectEntityId, opts);
  }

  /** Relations where `objectEntityId` is the object role — AC-3's JOIN-with-memories contract. */
  getForObject(objectEntityId: string, opts: EntityRelationQueryOpts = {}): EntityRelationRow[] {
    return this.queryByRole('object', objectEntityId, opts);
  }

  /**
   * Relations touching `entityId` in either role by default (`direction:
   * 'both'`), or restricted to one role — the primitive behind the (later
   * slice's) `get_entity_related` MCP tool's `direction` parameter.
   */
  getForEntity(
    entityId: string,
    opts: EntityRelationQueryOpts & { direction?: EntityRelationDirection } = {},
  ): EntityRelationRow[] {
    const direction = opts.direction ?? 'both';
    if (direction === 'subject') return this.getForSubject(entityId, opts);
    if (direction === 'object') return this.getForObject(entityId, opts);

    const asOf = opts.asOf ?? Date.now();
    const limit = opts.limit ?? 50;
    return this.db
      .prepare(`
        SELECT ${RELATION_SELECT_COLUMNS}
        FROM entity_relations er
        JOIN memories m ON m.id = er.evidence_memory_id
        WHERE (er.subject_entity_id = ? OR er.object_entity_id = ?)
        ${VALIDITY_PREDICATE}
        ORDER BY er.valid_from DESC
        LIMIT ?
      `)
      .all(entityId, entityId, asOf, asOf, limit) as EntityRelationRow[];
  }

  private queryByRole(
    role: 'subject' | 'object',
    entityId: string,
    opts: EntityRelationQueryOpts,
  ): EntityRelationRow[] {
    const asOf = opts.asOf ?? Date.now();
    const limit = opts.limit ?? 50;
    const column = role === 'subject' ? 'subject_entity_id' : 'object_entity_id';
    return this.db
      .prepare(`
        SELECT ${RELATION_SELECT_COLUMNS}
        FROM entity_relations er
        JOIN memories m ON m.id = er.evidence_memory_id
        WHERE er.${column} = ?
        ${VALIDITY_PREDICATE}
        ORDER BY er.valid_from DESC
        LIMIT ?
      `)
      .all(entityId, asOf, asOf, limit) as EntityRelationRow[];
  }
}
