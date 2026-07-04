/**
 * Scoped projection-recompute (ADR-011 multi-device conflict policy,
 * FEAT-407 pull merge slice).
 *
 * Only atom_ids that received a NEW remote event during a pull round need
 * their projection recomputed — atoms with no incoming remote event keep
 * the existing single-device fast path in memory-events.ts, unchanged
 * (ADR-011 "Implications for FEAT-407" point 3). This module is that
 * recompute function: a deterministic, order-independent reduce over the
 * FULL local event set for one atom_id, implementing conflict classes
 * A (concurrent-edit), B (edit-vs-supersede), C (edit-vs-erase).
 *
 * Deterministic tie-break key everywhere below: (created_at, event_id) —
 * created_at first, event_id (immutable, globally-unique) breaks ties. No
 * device is structurally favored (ADR-011).
 */

import { randomUUID } from 'node:crypto';
import type { DB } from '../storage/db.js';
import type { MemoryEventType } from '../storage/memory-events.js';

interface AtomEventRow {
  seq: number;
  event_id: string;
  event_type: MemoryEventType;
  atom_id: string;
  payload_json: string | null;
  content_hash: string | null;
  created_at: number;
}

function loadEvents(db: DB, atomId: string): AtomEventRow[] {
  return db
    .prepare('SELECT * FROM memory_events WHERE atom_id = ? ORDER BY created_at ASC, event_id ASC')
    .all(atomId) as AtomEventRow[];
}

function rowExists(db: DB, atomId: string): boolean {
  return db.prepare('SELECT 1 FROM memories WHERE id = ?').get(atomId) !== undefined;
}

/** Rule C materialization: hard-delete the memories row + its vec row, mirroring MemoryEventRepo.erase()'s row-side effect. */
function hardDeleteAtom(db: DB, atomId: string): boolean {
  const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(atomId) as { rowid: number } | undefined;
  if (!row) return false;
  db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(BigInt(row.rowid));
  db.prepare('DELETE FROM memories WHERE id = ?').run(atomId); // FTS trigger fires
  return true;
}

function supersedeTarget(e: AtomEventRow): string {
  const payload = e.payload_json !== null ? (JSON.parse(e.payload_json) as { superseded_by?: string }) : {};
  const target = payload.superseded_by;
  if (!target) throw new Error(`supersede event ${e.event_id} on atom ${e.atom_id} is missing payload.superseded_by`);
  return target;
}

/** max by (created_at, event_id) — the ADR-011 canonical tie-break. */
function maxByTieBreak(events: AtomEventRow[]): AtomEventRow {
  return events.reduce((best, e) => {
    if (e.created_at > best.created_at) return e;
    if (e.created_at < best.created_at) return best;
    return e.event_id > best.event_id ? e : best;
  });
}

/**
 * Class A fork resolution: append a synthetic supersede event chaining the
 * losing successor atom to the winning one, idempotent on replay (checks
 * for an existing conflict_merge event with the same target before
 * inserting). Reuses the exact event_type/payload shape the ordinary
 * supersede() path uses (ADR-011: "using the exact same event type and
 * materialization path memory-events.ts already has").
 */
function chainLoserToWinner(db: DB, loserAtomId: string, winnerAtomId: string, at: number): void {
  const already = db
    .prepare(
      `SELECT 1 FROM memory_events
       WHERE atom_id = ? AND event_type = 'supersede'
         AND json_extract(payload_json, '$.superseded_by') = ?
         AND json_extract(payload_json, '$.reason') = 'conflict_merge'`,
    )
    .get(loserAtomId, winnerAtomId);
  if (!already) {
    db.prepare(
      `INSERT INTO memory_events (event_id, event_type, atom_id, payload_json, content_hash, created_at)
       VALUES (?, 'supersede', ?, ?, NULL, ?)`,
    ).run(randomUUID(), loserAtomId, JSON.stringify({ superseded_by: winnerAtomId, reason: 'conflict_merge' }), at);
  }
  // Recompute the loser's own projection (not just poke its row) so the
  // loser's full rule set (e.g. its own concurrent erase_request, Rule C)
  // still takes precedence over this synthetic chaining — recomputeProjection
  // is idempotent and safe to call from within an already-open transaction
  // (better-sqlite3 nests via SAVEPOINT).
  recomputeProjection(db, loserAtomId);
}

/**
 * Recompute the materialized `memories` projection for one atom_id from its
 * full local event set (local ∪ pulled-remote, already deduped by
 * event_id). Order-independent: computed as a set-wise reduce, not a
 * fold-in-arrival-order apply, so calling this any number of times, in any
 * order relative to sibling atoms, converges to the same result (ADR-011
 * convergence property).
 */
export function recomputeProjection(db: DB, atomId: string): void {
  const tx = db.transaction(() => {
    const events = loadEvents(db, atomId);

    // Rule C: erasure always wins, unconditionally, regardless of any
    // concurrent invalidate/supersede on the same atom_id.
    if (events.some(e => e.event_type === 'erase_request')) {
      hardDeleteAtom(db, atomId);
      return;
    }

    if (!rowExists(db, atomId)) {
      // Row already gone (erased earlier by this device, or never
      // materialized) — nothing left to project onto.
      return;
    }

    const supersedes = events.filter(e => e.event_type === 'supersede');
    const invalidates = events.filter(e => e.event_type === 'invalidate');

    if (supersedes.length === 0 && invalidates.length === 0) {
      // Only create/promote_scope/usefulness events, or archive/restore —
      // none need reconciliation here. archive/restore are intentionally
      // NOT synced (shipper.ts listUnsynced excludes them: archival is a
      // per-device retention decision, not a semantic memory change), so
      // recomputeProjection — which only ever runs on atoms that received a
      // NEW REMOTE event during a pull round — never sees them.
      return;
    }

    const now = Date.now();

    if (supersedes.length > 0) {
      // Rule B (supersede beats invalidate) composed with Rule A (fork
      // tie-break): resolve the fork first, then supersede wins regardless
      // of any concurrent invalidate — so invalidates are simply not
      // consulted once any supersede event exists.
      const winner = maxByTieBreak(supersedes);
      const winnerTarget = supersedeTarget(winner);
      const validTo = Math.min(...supersedes.map(e => e.created_at));

      db.prepare('UPDATE memories SET valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ?')
        .run(validTo, winnerTarget, now, atomId);

      for (const loser of supersedes) {
        if (loser === winner) continue;
        const loserTarget = supersedeTarget(loser);
        if (loserTarget === winnerTarget) continue; // two devices happened to pick the same successor — nothing to chain
        chainLoserToWinner(db, loserTarget, winnerTarget, Math.max(loser.created_at, now));
      }
    } else {
      // Rule A, invalidate-vs-invalidate: order-independent, first-invalidated-wins.
      const validTo = Math.min(...invalidates.map(e => e.created_at));
      db.prepare('UPDATE memories SET valid_to = ?, updated_at = ? WHERE id = ?').run(validTo, now, atomId);
    }
  });
  tx();
}
