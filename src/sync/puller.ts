/**
 * Sync puller (FEAT-407, ADR-011) — cloud/remote-device -> local merge.
 * The mirror image of shipper.ts: shipper is local -> cloud (push, ADR-003,
 * one-way); this module is cloud -> local (pull, additive, no push-side
 * changes — ADR-011 point (e): "synthetic conflict events ride the existing
 * shipper", no new push-side code).
 *
 * Merge shape (ADR-011 "Implications for FEAT-407"):
 *   1. dedup-insert pulled events by event_id (AC-2 idempotent replay),
 *   2. scoped projection-recompute (conflict-resolve.ts) for exactly the
 *      atom_ids that received a NEW event this round,
 *   3. persist the watermark/cursor in the SAME transaction as (1)+(2), so
 *      a crash mid-pull cannot advance the watermark past events that were
 *      not actually durably merged (AC-4: resumable, no gap, no re-pull
 *      from zero).
 *
 * WIRE CONTRACT CAVEAT (be conservative — no live SaaS repo to consult):
 * astramem-sync@1 (ADR-003) ships `memory_events` metadata ONLY — no atom
 * body (text/type/hash/scope). That is sufficient for push (the cloud
 * ledger materializes state from events it already trusts) but a `create`
 * event pulled onto a device that has never seen this atom_id has nothing
 * to materialize a `memories` row FROM. Real cross-service pull will need a
 * cloud-side answer to "where does the atom body come from" that this repo
 * does not currently define (ADR-003 explicitly scoped pull out: "NOT in
 * v1: bidirectional sync, cross-device pull"). Rather than block on that,
 * this module defines `atom_snapshot` as an OPTIONAL, additive field on the
 * pulled event carrying just enough of the atom body to materialize a new
 * row locally. This is a LOCAL, FEAT-407-side design choice, not a verified
 * live cloud contract — flagged explicitly in the FEAT-407 completion
 * report. `PullFetcher` is injectable specifically so tests can simulate
 * this without a real cloud.
 */

import type { DB } from '../storage/db.js';
import type { MemoryScope, MemoryType } from '../contracts/memory.js';
import type { WireSyncEvent } from './shipper.js';
import { recomputeProjection } from './conflict-resolve.js';

/** Minimal atom body needed to materialize a brand-new `memories` row on pull. See file header caveat. */
export interface AtomSnapshot {
  type: MemoryType;
  text: string;
  normalized_text: string;
  hash: string;
  scope: MemoryScope;
  repo?: string | null;
  project?: string | null;
  branch?: string | null;
  agent?: string | null;
  session_id?: string | null;
  importance?: number;
  confidence?: number;
  source_hash?: string | null;
  evidence?: string | null;
}

export interface RemotePullEvent extends WireSyncEvent {
  /** Required on pull (unlike push, where it's additive-optional) — it is the dedup key merge correctness depends on. */
  event_id: string;
  /** Present only for 'create' events the sender knows the puller may not have seen yet. See file header caveat. */
  atom_snapshot?: AtomSnapshot | null;
}

export interface PullBatch {
  events: RemotePullEvent[];
  /** Opaque resume token. null means "no further pages" (nothing beyond this batch). */
  next_cursor: string | null;
}

/** Injectable — the real implementation talks to the cloud; tests supply an in-memory fake event source. */
export type PullFetcher = (cursor: string | null, limit: number) => Promise<PullBatch>;

export interface PullOpts {
  db: DB;
  fetcher: PullFetcher;
  batchSize?: number;
}

export interface PullOnceResult {
  /** Events returned by the fetcher this round (before dedup). */
  fetched: number;
  /** Events actually newly inserted (post dedup-by-event_id). */
  inserted: number;
  /** Distinct atom_ids whose projection was recomputed this round. */
  atomsRecomputed: number;
  /** Cursor persisted at the end of this round. */
  cursor: string | null;
  /** true when the fetcher returned nothing to pull. */
  idle: boolean;
}

const DEFAULT_PULL_BATCH = 200;

/** Current persisted pull watermark, or null if pull has never run. */
export function getPullWatermark(db: DB): string | null {
  const row = db.prepare('SELECT cursor FROM sync_pull_state WHERE id = 1').get() as { cursor: string | null } | undefined;
  return row?.cursor ?? null;
}

function setPullWatermark(db: DB, cursor: string | null, at: number): void {
  db.prepare(
    `INSERT INTO sync_pull_state (id, cursor, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
  ).run(cursor, at);
}

/**
 * Dedup-insert one pulled event: `INSERT ... WHERE NOT EXISTS` on event_id
 * (AC-2). Returns true iff a new row was actually inserted — callers use
 * this to build the scoped "touched atom_ids" set for recompute (ADR-011
 * point 3: recompute is scoped, not global).
 */
function dedupInsertEvent(db: DB, event: RemotePullEvent): boolean {
  const payloadJson = event.payload_json !== null ? JSON.stringify(event.payload_json) : null;
  const result = db
    .prepare(
      `INSERT INTO memory_events (event_id, event_type, atom_id, payload_json, content_hash, created_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM memory_events WHERE event_id = ?)`,
    )
    .run(event.event_id, event.event_type, event.atom_id, payloadJson, event.content_hash, event.created_at, event.event_id);
  return result.changes > 0;
}

/**
 * Materialize a brand-new `memories` row for a pulled 'create' event whose
 * atom_id this device has never seen, using the atom_id from the event as
 * the row id (so later events referencing this atom_id line up). No-op
 * (returns false) if the row already exists (idempotent) or no snapshot was
 * provided (event predates atom_snapshot support, or the sender assumed the
 * receiver already had it — nothing this module can materialize from).
 */
function materializeAtomIfMissing(db: DB, atomId: string, snapshot: AtomSnapshot, createdAt: number): boolean {
  const exists = db.prepare('SELECT 1 FROM memories WHERE id = ?').get(atomId);
  if (exists) return false;
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories
       (id, type, text, normalized_text, repo, project, branch, agent, session_id,
        importance, confidence, hash, created_at, updated_at, source_hash, evidence, valid_from, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    atomId, snapshot.type, snapshot.text, snapshot.normalized_text,
    snapshot.repo ?? null, snapshot.project ?? null, snapshot.branch ?? null, snapshot.agent ?? null, snapshot.session_id ?? null,
    snapshot.importance ?? 0.5, snapshot.confidence ?? 0.5, snapshot.hash,
    createdAt, now, snapshot.source_hash ?? null, snapshot.evidence ?? null, createdAt, snapshot.scope,
  );
  return true;
}

/**
 * One pull round: fetch a batch from `cursor`, dedup-insert by event_id,
 * materialize any brand-new atoms, scoped-recompute touched atoms'
 * projections, and persist the new watermark — all durably: the fetch
 * itself is outside any transaction (network I/O can't hold a DB lock
 * across a hung socket), but the merge + watermark advance is one atomic
 * transaction (AC-4: a crash between fetch and merge simply re-fetches the
 * same batch next round, which is safe because merge is idempotent).
 */
export async function pullOnce(opts: PullOpts): Promise<PullOnceResult> {
  const batchSize = opts.batchSize ?? DEFAULT_PULL_BATCH;
  const watermark = getPullWatermark(opts.db);
  const batch = await opts.fetcher(watermark, batchSize);

  if (batch.events.length === 0) {
    return { fetched: 0, inserted: 0, atomsRecomputed: 0, cursor: watermark, idle: true };
  }

  let inserted = 0;
  const touchedAtomIds = new Set<string>();

  const tx = opts.db.transaction(() => {
    for (const event of batch.events) {
      const wasInserted = dedupInsertEvent(opts.db, event);
      if (!wasInserted) continue;
      inserted++;
      touchedAtomIds.add(event.atom_id);

      if (event.event_type === 'create' && event.atom_snapshot) {
        materializeAtomIfMissing(opts.db, event.atom_id, event.atom_snapshot, event.created_at);
      }
    }

    for (const atomId of touchedAtomIds) {
      recomputeProjection(opts.db, atomId);
    }

    setPullWatermark(opts.db, batch.next_cursor, Date.now());
  });
  tx();

  return {
    fetched: batch.events.length,
    inserted,
    atomsRecomputed: touchedAtomIds.size,
    cursor: batch.next_cursor,
    idle: false,
  };
}

export interface DrainPullResult {
  rounds: number;
  totalFetched: number;
  totalInserted: number;
  cursor: string | null;
}

/**
 * Drain every available page: calls pullOnce repeatedly until the fetcher
 * reports idle (or a `next_cursor` of null after a non-empty batch). Bounds
 * the number of rounds so a misbehaving fetcher can't loop forever.
 */
export async function drainPull(opts: PullOpts, maxRounds = 1000): Promise<DrainPullResult> {
  let rounds = 0;
  let totalFetched = 0;
  let totalInserted = 0;
  let cursor = getPullWatermark(opts.db);

  while (rounds < maxRounds) {
    const result = await pullOnce(opts);
    rounds++;
    totalFetched += result.fetched;
    totalInserted += result.inserted;
    cursor = result.cursor;
    if (result.idle || result.cursor === null) break;
  }

  return { rounds, totalFetched, totalInserted, cursor };
}

/**
 * Real HTTP pull fetcher: GET <url>/sync/pull?cursor=&limit=. NOT exercised
 * against a live cloud in this slice's tests (no SaaS repo available
 * locally) — see the completion report's "requires-live-cloud" section.
 * Response shape assumed to mirror SyncEnvelope's event shape plus
 * `next_cursor`; this is this daemon's expectation of the pull contract,
 * not a verified cloud implementation.
 */
export function httpPullFetcher(url: string, token: string, fetchImpl: typeof fetch = fetch): PullFetcher {
  return async (cursor, limit) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (cursor !== null) qs.set('cursor', cursor);
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/sync/pull?${qs.toString()}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`sync pull failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as Partial<PullBatch>;
    if (!Array.isArray(body.events)) {
      throw new Error('sync pull failed: response missing events[]');
    }
    return {
      events: body.events as RemotePullEvent[],
      next_cursor: typeof body.next_cursor === 'string' ? body.next_cursor : null,
    };
  };
}
