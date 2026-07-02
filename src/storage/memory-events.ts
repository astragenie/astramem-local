/**
 * memory_events append-only log + lifecycle operations (ADR-002 decision
 * point 1, migration 007). The log is the source of truth for state
 * *changes*; the materialized `memories` row is updated in the SAME
 * transaction as the event append (log + tables in one file, not full event
 * sourcing — no view rebuilding, no projection framework).
 */

import type { DB } from './db.js';
import type { MemoryScope } from '../contracts/index.js';

export type MemoryEventType =
  | 'create'
  | 'invalidate'
  | 'supersede'
  | 'promote_scope'
  | 'erase_request'
  | 'usefulness';

export interface MemoryEvent {
  seq: number;
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

// ADR-009: scope only ever moves upward — personal -> team -> org.
const SCOPE_RANK: Record<MemoryScope, number> = { personal: 0, team: 1, org: 2 };

interface MemoryValidityRow {
  id: string;
  valid_to: number | null;
}

interface MemoryScopeRow {
  id: string;
  scope: MemoryScope;
}

export class MemoryEventRepo {
  constructor(private db: DB) {}

  /** Low-level append. Caller owns the transaction boundary. */
  append(event: AppendEventInput): number {
    const createdAt = event.created_at ?? Date.now();
    const payloadJson = event.payload !== undefined ? JSON.stringify(event.payload) : null;
    const result = this.db
      .prepare(`
        INSERT INTO memory_events (event_type, atom_id, payload_json, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(event.event_type, event.atom_id, payloadJson, event.content_hash ?? null, createdAt);
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
   * Promote a memory's scope: personal -> team -> org (ADR-009). Only
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
          `cannot promote memory ${atomId} from '${row.scope}' to '${toScope}' — only upward promotions allowed (personal -> team -> org)`,
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
