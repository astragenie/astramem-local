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
  | 'restore'
  /**
   * FEAT-442 reversal primitive: compensating event for `unsupersede()`,
   * un-hiding an atom that was previously superseded (via supersede() or
   * mergeAsSupersede()) — most commonly to reverse an autonomous
   * consolidation auto-accept, but works for any supersede. Local-only,
   * like 'archive'/'restore' — see MemoryEventRepo.unsupersede() and
   * src/sync/shipper.ts's exclusion list for why this never ships.
   */
  | 'unsupersede'
  /**
   * FEAT-467 reversible soft-delete generation: the compensating action for
   * one atom in a purge batch (ADR-013 Decision 4 gate for FEAT-458's proxy
   * capture tier). Payload: `{ batch_id, capture_source }`. Deliberately
   * NOT the existing 'invalidate' type — a purge-caused hide must stay
   * distinguishable from a human-initiated invalidate() both for
   * unpurge()'s own precondition and so a manual invalidate is never
   * accidentally reactivated by a purge-batch restore. See
   * MemoryEventRepo.purgeBatch().
   */
  | 'purge'
  /**
   * FEAT-467 reversal: un-hides one atom previously purged as part of an
   * open batch (within its restore window). Payload: `{ batch_id }`. See
   * MemoryEventRepo.restorePurgeBatch().
   */
  | 'unpurge';

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

/**
 * FEAT-467: an unknown purge batch id was passed to restorePurgeBatch() /
 * finalizePurgeBatch(). Subclasses MemoryNotFoundError (not a sibling type)
 * so the existing `mapLifecycleError` (src/server/routes/lifecycle.ts) maps
 * it to 404 with no new error-status convention — `err.atomId` holds the
 * batch id for this call site, read the same way the base class's own
 * `id`-in-body wiring already does.
 */
export class PurgeBatchNotFoundError extends MemoryNotFoundError {
  constructor(batchId: string) {
    super(batchId);
    this.name = 'PurgeBatchNotFoundError';
    this.message = `purge batch not found: ${batchId}`;
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

interface MemoryUnsupersedeRow {
  id: string;
  valid_to: number | null;
  superseded_by: string | null;
  archived: number;
}

interface PurgeBatchRow {
  batch_id: string;
  capture_source: string;
  requested_at: number;
  restore_deadline_at: number;
  atom_count: number;
  status: 'open' | 'restored' | 'finalized';
  finalized_at: number | null;
}

export interface PurgeBatchResult {
  batchId: string;
  count: number;
}

export interface PurgeRestoreResult {
  restored: number;
}

export interface PurgeFinalizeResult {
  erased: number;
}

/**
 * FEAT-442 provenance marker for a `supersede()` caused by autonomous
 * consolidation auto-accept (similarity >= `consolidation.autoAcceptThreshold`),
 * as opposed to a human-initiated accept (ProposalRepo.accept with no
 * provenance) or the containment auto-merge path. Recorded on the
 * `supersede` event's payload (reuses the existing event type — see the
 * design-review amendment this satisfies: least-invasive shape that keeps
 * every existing `event_type` consumer, e.g. history/why/corrections
 * queries, working unchanged) rather than a distinct event type, so
 * `unsupersede()`/`memory_history`/`why_memory` can show why a merge
 * happened without a human in the loop, and an operator can distinguish an
 * auto-accepted row from a manual one in the consolidation_proposals
 * listing's history.
 */
export interface SupersedeProvenance {
  autoAccepted: true;
  /** The `consolidation.autoAcceptThreshold` in effect for the run that made this call. */
  threshold: number;
  /** Cosine similarity of the winner/loser pair that triggered auto-accept. */
  similarity: number;
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
   *
   * `provenance` is optional and additive (FEAT-442): omitted, the payload is
   * byte-identical to pre-FEAT-442 behavior (`{ superseded_by: newId }`).
   * Passed, it merges in `auto_accepted: true` + `threshold` + `similarity`
   * — see {@link SupersedeProvenance}. Reversible via `unsupersede()`.
   */
  supersede(oldId: string, newId: string, provenance?: SupersedeProvenance): void {
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
      const payload: Record<string, unknown> = { superseded_by: newId };
      if (provenance) {
        payload.auto_accepted = true;
        payload.threshold = provenance.threshold;
        payload.similarity = provenance.similarity;
      }
      this.append({ event_type: 'supersede', atom_id: oldId, payload, created_at: now });
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
   * Reverse a supersede (FEAT-442 reversal primitive): un-hides a memory
   * that was superseded — clears `valid_to`/`superseded_by` via a
   * compensating `unsupersede` event (never a destructive row edit outside
   * a transaction that also appends the event, matching every other
   * lifecycle op in this file), restoring it to "current" status.
   *
   * Semantics — this is UN-HIDING, not UN-MERGING: it reverses the LOSER's
   * currency only. The WINNER (and the `derived_from` lineage it gained via
   * `mergeAsSupersede`) is untouched — the merge relationship stays on
   * record, and after this call BOTH atoms are simply valid/current again.
   * Nothing here removes the loser id from the winner's lineage, and
   * `memory_entities` links deleted by `supersede()`'s AC-3 cleanup are NOT
   * recomputed (that requires re-running entity extraction, not a
   * mechanical reversal) — a restored atom's entity links are a known
   * follow-up gap, not silently pretended-fixed here. If consolidation runs
   * again, the pair may be re-proposed or re-merged like any other similar
   * pair; this method does not suppress that.
   *
   * Exists primarily to undo an autonomous-consolidation auto-accept
   * (FEAT-442 `consolidation.autoAcceptThreshold`) that turns out to be a
   * bad merge, but it works for ANY supersede (manual accept, containment
   * auto-merge, or auto-accept) — scoped by state, not by cause.
   *
   * Throws MemoryNotFoundError if the id doesn't exist. Throws
   * MemoryConflictError if the memory is archived (archived === 1 — use
   * `restore()` instead, the two primitives never overlap) or was never
   * superseded (`superseded_by` is null — e.g. it is currently valid, or it
   * was invalidated/erased/archived through a different path).
   */
  unsupersede(atomId: string, reason?: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT id, valid_to, superseded_by, archived FROM memories WHERE id = ?')
        .get(atomId) as MemoryUnsupersedeRow | undefined;
      if (!row) throw new MemoryNotFoundError(atomId);
      if (row.archived === 1) {
        throw new MemoryConflictError(`memory ${atomId} is archived, not superseded — use restore() instead`);
      }
      if (row.superseded_by === null) {
        throw new MemoryConflictError(`memory ${atomId} was not superseded`);
      }
      const previousWinner = row.superseded_by;
      const now = Date.now();
      this.db
        .prepare('UPDATE memories SET valid_to = NULL, superseded_by = NULL, updated_at = ? WHERE id = ?')
        .run(now, atomId);
      this.append({
        event_type: 'unsupersede',
        atom_id: atomId,
        payload: { reversed_superseded_by: previousWinner, reason: reason ?? null },
        created_at: now,
      });
    });
    tx();
  }

  /**
   * Open a purge batch (FEAT-467 reversible soft-delete generation, ADR-013
   * Decision 4 gate): soft-invalidates every atom in `atomIds` via a new
   * `purge` event (never `invalidate` — see the `MemoryEventType` doc
   * comment) and persists one `purge_batches` audit row (batch id,
   * `captureSource`, atom count, restore-deadline time range), all in one
   * transaction. Each `purge` event's own payload also carries `batch_id`
   * and `restore_deadline_at` (FEAT-467 AC-6): `GET /memory/:id/history`
   * and the MCP `memory_history`/`why_memory` tools surface `memory_events`
   * rows as-is with no batch lookup of their own, so the deadline must live
   * on the event payload itself to be visible there — `purge_batches`
   * remains the source of truth this is read from at write time.
   * `capture_source` is a plain parameter with no branching — this
   * primitive is identical for `'auto_capture'` and `'proxy'` (FEAT-467
   * AC-5).
   *
   * Ids that don't exist, or are already invalid (`valid_to` set — including
   * previously purged/archived/superseded/erased), are silently skipped
   * rather than failing the whole batch — the same per-id tolerance
   * `runAutoCaptureDisable`'s existing erase loop already relies on. `count`
   * (and the persisted `atom_count`) reflect only atoms actually purged by
   * THIS call, which is why callers should pre-scope `atomIds` themselves
   * (e.g. `WHERE capture_source = ? AND valid_to IS NULL`) rather than rely
   * on this method to filter a large candidate set efficiently.
   *
   * `memories.purge_batch_id` is set to the new batch id on every purged
   * row — the single marker `restorePurgeBatch()`/`finalizePurgeBatch()`
   * scope their work by (see those methods' doc comments for why this
   * doubles as the "untouched by an unrelated lifecycle call" guard).
   */
  purgeBatch(atomIds: string[], captureSource: string, restoreWindowDays: number): PurgeBatchResult {
    const tx = this.db.transaction(() => {
      const batchId = randomUUID();
      const now = Date.now();
      const restoreDeadlineAt = now + restoreWindowDays * 86_400_000;
      let count = 0;
      for (const atomId of atomIds) {
        const row = this.db
          .prepare('SELECT id, valid_to FROM memories WHERE id = ?')
          .get(atomId) as MemoryValidityRow | undefined;
        if (!row || row.valid_to !== null) continue;
        this.db
          .prepare('UPDATE memories SET valid_to = ?, purge_batch_id = ?, updated_at = ? WHERE id = ?')
          .run(now, batchId, now, atomId);
        this.append({
          event_type: 'purge',
          atom_id: atomId,
          // FEAT-467 AC-6 fix (reviewer finding): restore_deadline_at is
          // duplicated onto the event payload itself, not just left on the
          // purge_batches row. GET /memory/:id/history and why_memory pass
          // memory_events rows through unchanged with no batch-id lookup of
          // their own, so without this the deadline was only ever reachable
          // via raw SQL against purge_batches — indistinguishable from a
          // bare state change per the AC's own wording. `purge_batches`
          // remains the source of truth (this is a read-convenience
          // duplication of a value fixed at purge time, not a second
          // mutable copy that can drift).
          payload: { batch_id: batchId, capture_source: captureSource, restore_deadline_at: restoreDeadlineAt },
          created_at: now,
        });
        count++;
      }
      this.db
        .prepare(`
          INSERT INTO purge_batches (batch_id, capture_source, requested_at, restore_deadline_at, atom_count, status)
          VALUES (?, ?, ?, ?, ?, 'open')
        `)
        .run(batchId, captureSource, now, restoreDeadlineAt, count);
      return { batchId, count };
    });
    return tx();
  }

  /**
   * Reverse an open purge batch within its restore window (FEAT-467 AC-2):
   * every atom still marked `purge_batch_id = batchId` and currently invalid
   * has `valid_to`/`purge_batch_id` cleared and an `unpurge` event appended;
   * the batch's audit record is marked `restored`. All in one transaction.
   *
   * Scoping the un-hide to `purge_batch_id = ? AND valid_to IS NOT NULL`
   * (rather than replaying `atomIds` from the batch's `purge` events
   * directly) is what leaves an atom independently changed since the purge
   * untouched: nothing else in this file's lifecycle API can move an
   * already-invalid atom's `valid_to` back to non-null except this method
   * and `unsupersede()`/`restore()` (which require `superseded_by`/`archived`
   * state a purge never sets), so an atom that no longer carries this
   * batch's marker was moved by something else and is correctly skipped.
   *
   * Throws `PurgeBatchNotFoundError` for an unknown batch id.
   * Throws `MemoryConflictError` if the batch is already `restored` or
   * `finalized`, or if `restore_deadline_at` has already elapsed — a stale
   * restore attempt is a conflict, not a silent no-op; call
   * `finalizePurgeBatch()` instead once the window has passed.
   */
  restorePurgeBatch(batchId: string): PurgeRestoreResult {
    const tx = this.db.transaction(() => {
      const batch = this.db
        .prepare('SELECT * FROM purge_batches WHERE batch_id = ?')
        .get(batchId) as PurgeBatchRow | undefined;
      if (!batch) throw new PurgeBatchNotFoundError(batchId);
      if (batch.status === 'finalized') {
        throw new MemoryConflictError(`purge batch ${batchId} is already finalized — nothing to restore`);
      }
      if (batch.status === 'restored') {
        throw new MemoryConflictError(`purge batch ${batchId} is already restored`);
      }
      const now = Date.now();
      if (now > batch.restore_deadline_at) {
        throw new MemoryConflictError(
          `purge batch ${batchId}'s restore window has elapsed — call finalizePurgeBatch() instead`,
        );
      }
      const rows = this.db
        .prepare('SELECT id FROM memories WHERE purge_batch_id = ? AND valid_to IS NOT NULL')
        .all(batchId) as { id: string }[];
      for (const { id } of rows) {
        this.db
          .prepare('UPDATE memories SET valid_to = NULL, purge_batch_id = NULL, updated_at = ? WHERE id = ?')
          .run(now, id);
        this.append({ event_type: 'unpurge', atom_id: id, payload: { batch_id: batchId }, created_at: now });
      }
      this.db.prepare(`UPDATE purge_batches SET status = 'restored' WHERE batch_id = ?`).run(batchId);
      return { restored: rows.length };
    });
    return tx();
  }

  /**
   * Finalize a purge batch (FEAT-467 AC-3): every atom still marked
   * `purge_batch_id = batchId` and currently invalid is HARD-erased via the
   * existing, unmodified `erase()` (row + vector index + FTS gone,
   * `erase_request` tombstone appended) — preserving ADR-006's "erasure
   * always wins, eventually" guarantee. The batch's audit record is marked
   * `finalized`. All in one transaction (better-sqlite3 nests `erase()`'s
   * own transaction as a savepoint).
   *
   * Callable once the restore window has elapsed (the scheduled-sweep path)
   * OR explicitly early, by design (an operator who wants to finalize before
   * the window ends) — unlike `restorePurgeBatch()`, this method does not
   * check `restore_deadline_at`.
   *
   * Throws `PurgeBatchNotFoundError` for an unknown batch id. Throws
   * `MemoryConflictError` if the batch was already `finalized` or already
   * `restored` (nothing left to erase via this path).
   */
  finalizePurgeBatch(batchId: string): PurgeFinalizeResult {
    const tx = this.db.transaction(() => {
      const batch = this.db
        .prepare('SELECT * FROM purge_batches WHERE batch_id = ?')
        .get(batchId) as PurgeBatchRow | undefined;
      if (!batch) throw new PurgeBatchNotFoundError(batchId);
      if (batch.status === 'finalized') {
        throw new MemoryConflictError(`purge batch ${batchId} is already finalized`);
      }
      if (batch.status === 'restored') {
        throw new MemoryConflictError(`purge batch ${batchId} was already restored — nothing to finalize`);
      }
      const rows = this.db
        .prepare('SELECT id FROM memories WHERE purge_batch_id = ? AND valid_to IS NOT NULL')
        .all(batchId) as { id: string }[];
      for (const { id } of rows) {
        this.erase(id, `purge batch ${batchId} finalized`);
      }
      this.db
        .prepare(`UPDATE purge_batches SET status = 'finalized', finalized_at = ? WHERE batch_id = ?`)
        .run(Date.now(), batchId);
      return { erased: rows.length };
    });
    return tx();
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
