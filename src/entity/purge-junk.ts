/**
 * One-shot cleanup for junk `entities` rows written BEFORE the write-path guard
 * existed (issue #207 / PR #218-#219).
 *
 * The guard (`filterAtomEntities` -> `classifyJunkEntityName`) blocks NEW junk
 * from ever being persisted. It does not retroactively clean rows that predate
 * it — the doctor "Entity name quality" canary says exactly this, and reports
 * the standing debt (62/5012 = 1.2% on prod as of 2026-07-13).
 *
 * THE RULE IS NOT REDEFINED HERE. This imports `classifyJunkEntityName`, the
 * same function the write guard and the doctor canary call. If the purge used
 * its own copy of the rule, the three could drift and the purge would start
 * deleting rows the guard would happily have kept — which is exactly how "C"
 * and "R" (real programming languages) got eaten by a flat length floor in the
 * first place. One rule, three callers, no duplication.
 *
 * SCOPE — this deletes ENTITY rows, never MEMORY rows. A memory whose only
 * entity was junk keeps its text, its embedding, and its searchability; it
 * simply loses a link to a garbage name. Deleting memories is not something
 * this command can do, by construction.
 *
 * Cascade: `memory_entities` and `entity_relations` both declare
 * `REFERENCES entities(id) ON DELETE CASCADE`, and `src/storage/db.ts` sets
 * `PRAGMA foreign_keys = ON`, so removing an entity removes its links and its
 * relation triples in the same statement. The counts are measured BEFORE the
 * delete so the report says what was actually destroyed.
 */

import type { DB } from '../storage/db.js';
import { classifyJunkEntityName } from '../distill/stages/05-extract.js';

export interface JunkEntity {
  id: string;
  name: string;
  kind: string | null;
  reason: string;
  /** memory_entities rows that will cascade-delete with this entity. */
  links: number;
  /** entity_relations rows (subject or object) that will cascade-delete. */
  relations: number;
}

export interface PurgeJunkResult {
  /** Total entity rows scanned. */
  scanned: number;
  /** Rows classified junk by `classifyJunkEntityName`. */
  junk: JunkEntity[];
  /** Junk rows actually deleted (0 when dryRun). */
  deleted: number;
  /** memory_entities rows cascade-deleted (0 when dryRun). */
  linksDeleted: number;
  /** entity_relations rows cascade-deleted (0 when dryRun). */
  relationsDeleted: number;
  /** Memories that lost their LAST entity link — they are now unlinked. */
  memoriesLeftUnlinked: number;
  dryRun: boolean;
}

/**
 * Identify (and optionally delete) junk entity rows.
 *
 * `dryRun` defaults to TRUE. Deleting rows from a user's production memory
 * store is irreversible, so the caller must opt in explicitly; a mistyped flag
 * should preview, never destroy.
 */
export function purgeJunkEntities(db: DB, opts: { dryRun?: boolean } = {}): PurgeJunkResult {
  const dryRun = opts.dryRun ?? true;

  const rows = db.prepare('SELECT id, name, kind FROM entities').all() as Array<{
    id: string;
    name: string;
    kind: string | null;
  }>;

  const junk: JunkEntity[] = [];
  for (const r of rows) {
    const reason = classifyJunkEntityName(r.name, r.kind ?? undefined);
    if (reason === null) continue;

    const links = (
      db.prepare('SELECT COUNT(*) AS n FROM memory_entities WHERE entity_id = ?').get(r.id) as { n: number }
    ).n;
    const relations = (
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM entity_relations WHERE subject_entity_id = ? OR object_entity_id = ?',
        )
        .get(r.id, r.id) as { n: number }
    ).n;

    junk.push({ id: r.id, name: r.name, kind: r.kind, reason, links, relations });
  }

  const result: PurgeJunkResult = {
    scanned: rows.length,
    junk,
    deleted: 0,
    linksDeleted: 0,
    relationsDeleted: 0,
    memoriesLeftUnlinked: 0,
    dryRun,
  };

  if (junk.length === 0) return result;

  const junkIds = junk.map(j => j.id);
  const placeholders = junkIds.map(() => '?').join(',');

  // Memories whose ONLY remaining entity links are to junk rows — after the
  // cascade they have zero entities. Reported because it is the one
  // user-visible consequence of this command: those memories will start
  // counting toward the doctor "Entity link rate" canary's unlinked tally.
  // They are NOT deleted and remain fully searchable (text + embedding are
  // untouched); entity linkage feeds ranking only through the ζ/zeta fusion
  // term, which ships at 0.
  result.memoriesLeftUnlinked = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT memory_id
             FROM memory_entities
            GROUP BY memory_id
           HAVING SUM(CASE WHEN entity_id IN (${placeholders}) THEN 0 ELSE 1 END) = 0
         )`,
      )
      .get(...junkIds) as { n: number }
  ).n;

  if (dryRun) return result;

  // Measure the cascade BEFORE deleting — afterwards the rows are gone and the
  // report would have nothing to count.
  result.linksDeleted = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM memory_entities WHERE entity_id IN (${placeholders})`)
      .get(...junkIds) as { n: number }
  ).n;
  result.relationsDeleted = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM entity_relations
          WHERE subject_entity_id IN (${placeholders}) OR object_entity_id IN (${placeholders})`,
      )
      .get(...junkIds, ...junkIds) as { n: number }
  ).n;

  const tx = db.transaction(() => {
    const info = db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...junkIds);
    result.deleted = info.changes;
  });
  tx();

  return result;
}
