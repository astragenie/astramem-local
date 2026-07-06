/**
 * memory_events append-only log + lifecycle operations (ADR-002 decision
 * point 1, migration 007). The log is the source of truth for state
 * *changes*; the materialized `memories` row is updated in the SAME
 * transaction as the event append (log + tables in one file, not full event
 * sourcing — no view rebuilding, no projection framework).
 */

import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { MemoryScope } from '../contracts/index.js';

export type MemoryEventType =
  | 'create'
  | 'invalidate'
  | 'supersede'
  | 'promote_scope'
  | 'erase_request'
  | 'usefulness'
  | 'archive'
  | 'restore';

export interface MemoryEvent {
  seq: number;
  event_id: string;
  event_type: MemoryEventType;
  atom_id: string;
  payload_json: string | null;
  content_hash: string | null;
  created_at: number;
  synced_at: number | null;
}

export interface AppendEventInput {
  event_type: MemoryEventType;
  atom_id: string;
  /** JSON-serialized on write; use listForAtom + JSON.parse to read back. */
  payload?: unknown;
  content_hash?: string | null;
  created_at?: number;
  /**
   * Globally-unique event identity (ADR-011). Local single-device writers
   * never pass this — it is always freshly generated (node:crypto
   * randomUUID()). Only the pull-ingest path (src/sync/puller.ts) writes
   * remote-originated events with their OWN pre-existing event_id, and it
   * does so via a raw dedup-insert, not through this method — append() is
   * exclusively the local-origin path.
   */
  event_id?: string;
}

/** Memory not found for the requested lifecycle op — maps to HTTP 404. */
export class MemoryNotFoundError extends Error {
  constructor(public readonly atomId: string) {
    super(`memory not found: ${atomId}`);
    this.name = 'MemoryNotFoundError';
  }
}

/** State conflict (e.g. already invalidated) — maps to HTTP 409. */
export class MemoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryConflictError';
  }
}

/** Invalid scope transition (e.g. downward promotion) — maps to HTTP 400. */
export class InvalidScopeTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScopeTransitionError';
  }
}

// ADR-009: scope only ever moves upward — private -> team -> org.
const SCOPE_RANK: Record<MemoryScope, number> = { private: 0, team: 1, org: 2 };

interface MemoryValidityRow {
  id: string;
  valid_to: number | null;
}

interface MemoryScopeRow {
  id: string;
  scope: MemoryScope;
}

interface MemoryArchivalRow {
  id: string;
  valid_to: number | null;
  archived: number;
}

export class MemoryEventRepo {
  constructor(private db: DB) {}

  /** Low-level append. Caller owns the transaction boundary. */
  append(event: AppendEventInput): number {
    const createdAt = event.created_at ?? Date.now();
    const payloadJson = event.payload !== undefined ? JSON.stringify(event.payload) : null;
    const eventId = event.event_id ?? randomUUID();
    const result = this.db
      .prepare(`
        INSERT INTO memory_events (event_id, event_type, atom_id, payload_json, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(eventId, event.event_type, event.atom_id, payloadJson, event.content_hash ?? null, createdAt);
    return Number(result.lastInsertRowid);
  }

  /** Full event log for one atom, ordered by seq (append order). */
  listForAtom(atomId: string): MemoryEvent[] {
    return this.db
      .prepare('SELECT * FROM memory_events WHERE atom_id = ? ORDER BY seq ASC')
      .all(atomId) as MemoryEvent[];
  }

  /**
   * Invalidate a memory: sets valid_to = now, appends an 'invalidate' event,
   * both in one transaction. Idempotent-safe: throws MemoryConflictError if
   * the memory is already invalid rather than silently double-invalidating.
   */
  invalidate(atomId: string, reason?: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT id, valid_to FROM memories WHERE id = ?')
        .get(atomId) as MemoryValidityRow | undefined;
      if (!row) throw new MemoryNotFoundError(atomId);
      if (row.valid_to !== null) {
        throw new MemoryConflictError(`memory ${atomId} is already invalid`);
      }
      const now = Date.now();
      this.db.prepare('UPDATE memories SET valid_to = ?, updated_at = ? WHERE id = ?').run(now, now, atomId);
      this.append({ event_type: 'invalidate', atom_id: atomId, payload: { reason: reason ?? null }, created_at: now });
      // ADR-010: negative usefulness signal — same tx as the state change.
      // Payload shape documented in src/storage/usefulness.ts (memory_corrected family).
      this.append({
        event_type: 'usefulness',
        atom_id: atomId,
        payload: { family: 'memory_corrected', action: 'invalidated' },
        created_at: now,
      });
    });
    tx();
  }

  /**
   * Supersede oldId with newId: sets old.valid_to = now AND
   * old.superseded_by = newId, appends a 'supersede' event on oldId — all in
   * one transaction. Validates both ids exist; oldId must currently be valid
   * (not already invalidated/superseded); newId must be valid (valid_to null).
   *
   * FEAT-401 fix: also co-issues newId.valid_from = the SAME `now` used for
   * old.valid_to. Without this, newId keeps the valid_from it was stamped
   * with at insert() time (which normally predates the supersede() call by
   * however long the caller took to decide to supersede), producing an
   * overlap window [newId.valid_from, oldId.valid_to) where an as_of query
   * would match BOTH generations — a bitemporal-window leak. Co-issuing the
   * boundary keeps the two windows contiguous and non-overlapping
   * (old.valid_to === new.valid_from), matching the half-open-interval
   * model as_of resolution assumes (ADR-001, FEAT-401 AC-1/AC-5): the
   * successor becomes "the believed value" exactly as of the supersede
   * instant, not as of whenever it happened to be inserted.
   *
   * FEAT-402 AC-3: also deletes oldId's memory_entities links in the same
   * transaction. The memories row itself is NOT deleted (bitemporal history
   * is kept for as_of queries), so this can't rely on the erase() path's
   * ON DELETE CASCADE — it's explicit here instead. A superseded memory's
   * facts should stop counting as current evidence for an entity even
   * though the row survives for audit.
   */
  supersede(oldId: string, newId: string): void {
    const tx = this.db.transaction(() => {
      const oldRow = this.db
        .prepare('SELECT id, valid_to FROM memories WHERE id = ?')
        .get(oldId) as MemoryValidityRow | undefined;
      if (!oldRow) throw new MemoryNotFoundError(oldId);

      const newRow = this.db
        .prepare('SELECT id, valid_to FROM memories WHERE id = ?')
        .get(newId) as MemoryValidityRow | undefined;
      if (!newRow) throw new MemoryNotFoundError(newId);

      if (oldRow.valid_to !== null) {
        throw new MemoryConflictError(`memory ${oldId} is already invalid`);
      }
      if (newRow.valid_to !== null) {
        throw new MemoryConflictError(`memory ${newId} must be valid to supersede with — it is already invalid`);
      }

      const now = Date.now();
      this.db
        .prepare('UPDATE memories SET valid_to = ?, superseded_by = ?, updated_at = ? WHERE id = ?')
        .run(now, newId, now, oldId);
      this.db
        .prepare('UPDATE memories SET valid_from = ?, updated_at = ? WHERE id = ?')
        .run(now, now, newId);
      // FEAT-402 AC-3: zero orphan links — the superseded memory no longer
      // contributes to "everything about entity X".
      this.db.prepare('DELETE FROM memory_entities WHERE memory_id = ?').run(oldId);
      this.append({ event_type: 'supersede', atom_id: oldId, payload: { superseded_by: newId }, created_at: now });
      // ADR-010: negative usefulness signal — same tx as the state change.
      // Payload shape documented in src/storage/usefulness.ts (memory_corrected family).
      this.append({
        event_type: 'usefulness',
        atom_id: oldId,
        payload: { family: 'memory_corrected', action: 'superseded' },
        created_at: now,
      });
    });
    tx();
  }

  /**
   * Archive a memory (FEAT-404 TTL/archival tiers): sets valid_to = now +
   * archived = 1 + archived_at = now, appends an 'archive' event — all in
   * one transaction. Reuses the exact non-destructive valid_to bookkeeping
   * invalidate()/supersede() already use (row survives, restorable via
   * restore()) — the only difference is *why* the row stopped being
   * current, which is why this is a distinct event type rather than a
   * relabeled invalidate().
   *
   * Deliberately does NOT append a 'memory_corrected' usefulness signal the
   * way invalidate()/supersede() do: staleness-triggered archival is
   * routine housekeeping driven by low usefulness, not a correction of a
   * wrong/superseded fact — appending one would create a feedback loop
   * that further penalizes an atom the policy might restore later.
   *
   * Throws MemoryConflictError if the memory is already invalid (including
   * already archived) rather than silently double-archiving.
   */
  archive(atomId: string, reason?: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT id, valid_to, archived FROM memories WHERE id = ?')
        .get(atomId) as MemoryArchivalRow | undefined;
      if (!row) throw new MemoryNotFoundError(atomId);
      if (row.valid_to !== null) {
        throw new MemoryConflictError(`memory ${atomId} is already invalid — cannot archive`);
      }
      const now = Date.now();
      this.db
        .prepare('UPDATE memories SET valid_to = ?, archived = 1, archived_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, now, atomId);
      this.append({ event_type: 'archive', atom_id: atomId, payload: { reason: reason ?? null }, created_at: now });
    });
    tx();
  }

  /**
   * Restore a previously-archived memory (FEAT-404 AC-4): clears valid_to
   * and archived/archived_at, appends a 'restore' event — all in one
   * transaction. The memory immediately re-qualifies for every
   * `valid_to IS NULL` candidate filter (search.ts, recall/pack.ts), so it
   * reappears in search with no further wiring needed.
   *
   * Throws MemoryNotFoundError if the id doesn't exist, MemoryConflictError
   * if it isn't currently archived (e.g. it was invalidated/superseded
   * through a different path, or was never archived).
   */
  restore(atomId: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT id, valid_to, archived FROM memories WHERE id = ?')
        .get(atomId) as MemoryArchivalRow | undefined;
      if (!row) throw new MemoryNotFoundError(atomId);
      if (row.archived !== 1) {
        throw new MemoryConflictError(`memory ${atomId} is not archived`);
      }
      const now = Date.now();
      this.db
        .prepare('UPDATE memories SET valid_to = NULL, archived = 0, archived_at = NULL, updated_at = ? WHERE id = ?')
        .run(now, atomId);
      this.append({ event_type: 'restore', atom_id: atomId, created_at: now });
    });
    tx();
  }

  /**
   * Promote a memory's scope: private -> team -> org (ADR-009). Only
   * upward promotions are allowed; same-scope or downward requests throw
   * InvalidScopeTransitionError. State update + event append in one
   * transaction.
   */
  promoteScope(atomId: string, toScope: MemoryScope): void {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT id, scope FROM memories WHERE id = ?')
        .get(atomId) as MemoryScopeRow | undefined;
      if (!row) throw new MemoryNotFoundError(atomId);

      if (SCOPE_RANK[toScope] <= SCOPE_RANK[row.scope]) {
        throw new InvalidScopeTransitionError(
          `cannot promote memory ${atomId} from '${row.scope}' to '${toScope}' — only upward promotions allowed (private -> team -> org)`,
        );
      }

      const now = Date.now();
      this.db.prepare('UPDATE memories SET scope = ?, updated_at = ? WHERE id = ?').run(toScope, now, atomId);
      this.append({
        event_type: 'promote_scope',
        atom_id: atomId,
        payload: { from: row.scope, to: toScope },
        created_at: now,
      });
    });
    tx();
  }

  /**
   * Erase a memory (erasure v1, ADR-006 W5): HARD-deletes the memories row
   * (FTS cleans up via the AFTER DELETE trigger) and its vector index row,
   * and appends an 'erase_request' event — the event IS the tombstone:
   *   - payload.scope lets the sync shipper (ADR-009) ship the tombstone to
   *     the cloud even though the memories row is gone,
   *   - content_hash = the memory's hash powers the replay filter (stage 8
   *     refuses to resurrect an erased memory on re-distillation).
   * Erasure always wins over retention/replay — the text is unrecoverable
   * locally after this call.
   */
  erase(atomId: string, reason?: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT id, rowid, scope, hash FROM memories WHERE id = ?')
        .get(atomId) as { id: string; rowid: number; scope: MemoryScope; hash: string } | undefined;
      if (!row) throw new MemoryNotFoundError(atomId);

      const now = Date.now();
      // Tombstone first (same tx): the event survives the row.
      this.append({
        event_type: 'erase_request',
        atom_id: atomId,
        payload: { scope: row.scope, reason: reason ?? null },
        content_hash: row.hash,
        created_at: now,
      });
      this.db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(BigInt(row.rowid));
      this.db.prepare('DELETE FROM memories WHERE id = ?').run(atomId); // FTS trigger fires
    });
    tx();
  }

  /**
   * Replay filter (erasure v1): true when a memory with this content hash
   * has been erased — re-distillation must not resurrect it.
   */
  isErasedHash(contentHash: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS x FROM memory_events WHERE event_type = 'erase_request' AND content_hash = ? LIMIT 1`)
      .get(contentHash);
    return row !== undefined;
  }
}
