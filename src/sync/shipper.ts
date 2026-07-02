/**
 * Sync shipper (Wave 3d, ADR-003) — one-way, append-only, idempotent log
 * shipping: local memory_events -> cloud POST /sync/events.
 *
 * The log IS the queue: unsynced rows are `synced_at IS NULL`; a batch is
 * acked by the cloud's `{ acked_seq }` and marked in one UPDATE. Crash-safe
 * by construction — replaying a batch is always safe (cloud dedups on
 * content_hash and (device_id, seq)).
 *
 * Scope filter (ADR-009): only events whose atom is team/org-scoped ship.
 * `personal` atoms never leave the machine. erase_request events for atoms
 * whose row is already hard-deleted ship when their payload carries a
 * team/org scope (3f writes the scope into the erase payload for exactly
 * this reason).
 *
 * Offline: unlimited — failures leave rows unsynced; retry with exponential
 * backoff capped at BACKOFF_CAP_MS.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../storage/db.js';
import { logger } from '../log/logger.js';

export const SYNC_PROTOCOL = 'astramem-sync@1' as const;

export interface WireSyncEvent {
  seq: number;
  event_type: string;
  atom_id: string;
  payload_json: Record<string, unknown> | null;
  content_hash: string | null;
  created_at: number;
}

export interface SyncEnvelope {
  protocol: typeof SYNC_PROTOCOL;
  device_id: string;
  workspace_id: string;
  cursor: number;
  events: WireSyncEvent[];
}

export interface ShipperOpts {
  db: DB;
  /** Cloud base URL, e.g. https://memory.example.com — POSTs to <url>/sync/events. */
  url: string;
  workspaceId: string;
  deviceId: string;
  /** Bearer for the cloud (device token). */
  token: string;
  batchSize?: number;
  intervalMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface ShipperHandle {
  /** Stop the loop. Resolves after any in-flight ship completes. */
  stop(): Promise<void>;
}

const DEFAULT_BATCH = 200;
const DEFAULT_INTERVAL_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60_000;

/**
 * Stable per-install device id, persisted as a plain file in the config dir
 * (an identifier, not a secret — the device TOKEN lives in the keystore).
 */
export function getOrCreateDeviceId(configDir: string): string {
  const path = join(configDir, 'device-id');
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  }
  const id = randomUUID();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path, `${id}\n`, 'utf8');
  return id;
}

interface UnsyncedRow {
  seq: number;
  event_type: string;
  atom_id: string;
  payload_json: string | null;
  content_hash: string | null;
  created_at: number;
}

/**
 * Unsynced, ship-eligible events in seq order (ADR-009 scope filter).
 * LEFT JOIN: an erase_request may outlive its memories row — it ships when
 * its payload records a team/org scope.
 */
export function listUnsynced(db: DB, batchSize: number): UnsyncedRow[] {
  return db
    .prepare(`
      SELECT e.seq, e.event_type, e.atom_id, e.payload_json, e.content_hash, e.created_at
      FROM memory_events e
      LEFT JOIN memories m ON m.id = e.atom_id
      WHERE e.synced_at IS NULL
        AND (
          m.scope IN ('team', 'org')
          OR (
            e.event_type = 'erase_request'
            AND json_extract(e.payload_json, '$.scope') IN ('team', 'org')
          )
        )
      ORDER BY e.seq ASC
      LIMIT ?
    `)
    .all(batchSize) as UnsyncedRow[];
}

/** Last acked seq = highest synced event seq (0 when nothing has shipped). */
export function lastAckedSeq(db: DB): number {
  const row = db
    .prepare('SELECT MAX(seq) AS s FROM memory_events WHERE synced_at IS NOT NULL')
    .get() as { s: number | null };
  return row.s ?? 0;
}

export function buildEnvelope(
  deviceId: string,
  workspaceId: string,
  cursor: number,
  rows: UnsyncedRow[],
): SyncEnvelope {
  return {
    protocol: SYNC_PROTOCOL,
    device_id: deviceId,
    workspace_id: workspaceId,
    cursor,
    events: rows.map(r => ({
      seq: r.seq,
      event_type: r.event_type,
      atom_id: r.atom_id,
      payload_json: r.payload_json !== null ? (JSON.parse(r.payload_json) as Record<string, unknown>) : null,
      content_hash: r.content_hash,
      created_at: r.created_at,
    })),
  };
}

export interface ShipOnceResult {
  shipped: number;
  acked: number;
  /** true when there was nothing eligible to ship. */
  idle: boolean;
}

/**
 * One shipping round: read a batch, POST it, mark acked rows synced.
 * Throws on transport/HTTP failure — the caller owns retry/backoff.
 */
export async function shipOnce(opts: ShipperOpts): Promise<ShipOnceResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  const rows = listUnsynced(opts.db, batchSize);
  if (rows.length === 0) return { shipped: 0, acked: 0, idle: true };

  const envelope = buildEnvelope(opts.deviceId, opts.workspaceId, lastAckedSeq(opts.db), rows);
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${opts.url.replace(/\/$/, '')}/sync/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) {
    throw new Error(`sync ship failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { acked_seq?: number };
  const ackedSeq = typeof body.acked_seq === 'number' ? body.acked_seq : -1;
  if (ackedSeq < 0) {
    throw new Error('sync ship failed: response missing acked_seq');
  }

  // Mark ONLY the rows we actually shipped and the server acked. A partial
  // ack (acked_seq mid-batch) leaves the tail unsynced for the next round.
  const shippedAcked = rows.filter(r => r.seq <= ackedSeq).map(r => r.seq);
  if (shippedAcked.length > 0) {
    const now = Date.now();
    const placeholders = shippedAcked.map(() => '?').join(', ');
    opts.db
      .prepare(`UPDATE memory_events SET synced_at = ? WHERE seq IN (${placeholders}) AND synced_at IS NULL`)
      .run(now, ...shippedAcked);
  }
  return { shipped: rows.length, acked: shippedAcked.length, idle: false };
}

/** Pure backoff schedule: base * 2^failures, capped. Exported for tests. */
export function backoffDelay(baseMs: number, consecutiveFailures: number): number {
  return Math.min(baseMs * 2 ** consecutiveFailures, BACKOFF_CAP_MS);
}

/**
 * Start the periodic shipper loop. Ships immediately, then every intervalMs;
 * on failure the next attempt is delayed by exponential backoff.
 */
export function startShipper(opts: ShipperOpts): ShipperHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let failures = 0;

  async function round(): Promise<void> {
    if (stopped) return;
    try {
      const result = await shipOnce(opts);
      failures = 0;
      if (!result.idle) {
        logger.info({ shipped: result.shipped, acked: result.acked }, 'sync: batch shipped');
      }
    } catch (err) {
      failures++;
      logger.warn(
        { err: (err as Error).message, consecutive_failures: failures },
        'sync: ship failed — will retry with backoff',
      );
    }
    if (!stopped) {
      const delay = failures > 0 ? backoffDelay(intervalMs, failures) : intervalMs;
      timer = setTimeout(launch, delay);
    }
  }

  function launch(): void {
    inFlight = round().finally(() => { inFlight = null; });
  }

  launch();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
    },
  };
}
