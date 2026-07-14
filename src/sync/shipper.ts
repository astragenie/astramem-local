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
 * `private` atoms (renamed from `personal`, U7-local astramem-local#110,
 * DEC-048) never leave the machine. erase_request events for atoms
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
import type { MemoryScope } from '../contracts/index.js';
import { logger } from '../log/logger.js';

export const SYNC_PROTOCOL = 'astramem-sync@1' as const;

export interface WireSyncEvent {
  seq: number;
  event_type: string;
  atom_id: string;
  payload_json: Record<string, unknown> | null;
  content_hash: string | null;
  created_at: number;
  /**
   * Globally-unique event identity (ADR-011, migration 010). Additive field
   * — no astramem-sync@1 version bump (ADR-001's additive-field evolution
   * rule): older push clients that omit it are still valid envelopes; this
   * daemon always populates it (migration 010 backfills every pre-existing
   * row, and MemoryEventRepo.append() always assigns one going forward).
   * It is the pull-side dedup key (FEAT-407 AC-2) and the ADR-011 conflict
   * tie-break key (created_at, event_id).
   */
  event_id: string;
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

export interface ShipperGateInput {
  /** `cfg.sync.enabled` — merged from sync.json pairing state at boot
   * (resolve-runtime.ts). Pairing-owned; `astramem-local pair` flips this to
   * true on a successful redeem. */
  enabled: boolean;
  /** `cfg.sync.experimental` — config.yaml, hand-edit only. `pair` never
   * touches this field. */
  experimental: boolean;
  dataDir: string;
  /** True under ASTRA_MEMORY_ISOLATED=1 (see resolve-runtime.ts). */
  isolated: boolean;
}

/**
 * Hard gate on top of `enabled` (astramem-local sync-experimental-gate
 * slice): sync-to-astramem-cloud is currently broken (8868 events failing
 * HTTP 400, not yet root-caused). Before this gate, `astramem-local pair
 * <code>` alone set `sync.json`'s `enabled: true` and that was sufficient to
 * start shipping — anyone who paired hit the broken path. Both `enabled`
 * (sync.json, pairing-owned) AND `experimental` (config.yaml, hand-edit
 * only) must now be true, on top of the pre-existing dataDir/isolated
 * guards `cli/serve.ts` already enforced. Pure/exported so the gate is
 * unit-testable without spawning a daemon.
 */
export function shouldStartShipper(input: ShipperGateInput): boolean {
  return input.enabled && input.experimental && input.dataDir !== ':memory:' && !input.isolated;
}

const DEFAULT_BATCH = 200;
const DEFAULT_INTERVAL_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60_000;
const MAX_ERROR_BODY_LEN = 500;

/**
 * Read a failed response's body (bounded to ~500 chars) for inclusion in the
 * thrown error message. A bare "HTTP 403" told us nothing about *why* — the
 * cloud's error JSON (e.g. `{"error":"sync_disabled"}`) is what actually
 * explains the failure, and swallowing it cost hours of debugging on a real
 * incident (astramem-local#81). Never throws itself — a body read failure
 * must not mask the original HTTP error.
 */
export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return '';
    return text.length > MAX_ERROR_BODY_LEN ? `${text.slice(0, MAX_ERROR_BODY_LEN)}…` : text;
  } catch {
    return '';
  }
}

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
  event_id: string;
  event_type: string;
  atom_id: string;
  payload_json: string | null;
  content_hash: string | null;
  created_at: number;
  /**
   * The atom's CURRENT scope (memories.scope), not the scope frozen into
   * this row's payload_json at write time. null only when the LEFT JOIN
   * found no memories row (the erase_request-for-a-ghost-atom case) — never
   * null for a `create`/`promote_scope` row, since those always require a
   * live memories row to satisfy this query's own WHERE clause below.
   * {@link buildEnvelope} uses this to correct a stale `create` payload
   * scope on the wire — see that function's doc comment for why.
   */
  current_scope: MemoryScope | null;
}

/**
 * Unsynced, ship-eligible events in seq order (ADR-009 scope filter).
 * LEFT JOIN: an erase_request may outlive its memories row — it ships when
 * its payload records a team/org scope.
 *
 * `archive`/`restore` (FEAT-404) are excluded unconditionally, regardless of
 * scope: archival is a per-device retention/storage-hygiene decision (one
 * device's local SQLite-growth mitigation), not a semantic memory change,
 * so it must never leave the machine. The sync wire schema
 * (contracts/schemas/sync-envelope.v1.schema.json) also never lists these
 * two types in its event_type enum — shipping one would fail schema
 * validation on the wire, on top of being the wrong policy.
 *
 * `unsupersede` (FEAT-442 reversal primitive) is excluded the same way, but
 * for a different reason: it's local-only by SCOPE DECISION, not by nature
 * (the supersede event it reverses DOES ship). Multi-device propagation of a
 * reversal is a real follow-up — a second device would keep believing the
 * merge until it independently re-derives or is told — but designing that
 * cross-device semantics is out of scope for the reversal primitive itself
 * (FEAT-442 design review: "scoped narrowly ... so it doesn't have to solve
 * reversal for every supersede path in the system"). Excluding it here keeps
 * today's behavior safe (no wire-schema change, no risk of shipping a type
 * the cloud doesn't recognize) at the cost of that follow-up gap.
 *
 * `purge`/`unpurge` (FEAT-467, ADR-013 Decision 4 gate) are excluded for the
 * same scope-decision reason as `unsupersede`: cross-device propagation of a
 * disable-flow purge/restore is a real follow-up, not solved by this
 * primitive, and the wire schema doesn't list either type yet.
 *
 * `e.rejected_at IS NULL` (sync-promote-wedge fix, migration 036): a row the
 * cloud has permanently rejected (DEC-048 invariant 1 — see
 * SyncIngestService.IsPrivateScopedViolation) must never be reselected. Only
 * `shipOnce` ever sets `rejected_at`, from the cloud's `rejected_seqs`
 * response field — see that function's doc comment.
 */
export function listUnsynced(db: DB, batchSize: number): UnsyncedRow[] {
  return db
    .prepare(`
      SELECT e.seq, e.event_id, e.event_type, e.atom_id, e.payload_json, e.content_hash, e.created_at,
        m.scope AS current_scope
      FROM memory_events e
      LEFT JOIN memories m ON m.id = e.atom_id
      WHERE e.synced_at IS NULL
        AND e.rejected_at IS NULL
        AND e.event_type NOT IN ('archive', 'restore', 'unsupersede', 'purge', 'unpurge')
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

/**
 * Timestamp (ms epoch) of the most recently-shipped event, or null if
 * nothing has ever shipped from this device. Read-only observability helper
 * (FEAT-427 GET /sync/status) — does not affect shipping behavior.
 */
export function lastShipAt(db: DB): number | null {
  const row = db
    .prepare('SELECT MAX(synced_at) AS a FROM memory_events WHERE synced_at IS NOT NULL')
    .get() as { a: number | null };
  return row.a ?? null;
}

/**
 * Count of currently ship-eligible, not-yet-synced events (same ADR-009
 * scope-filter WHERE clause as {@link listUnsynced}, without the batch
 * LIMIT). Read-only observability helper (FEAT-427 GET /sync/status) — does
 * not affect shipping behavior.
 */
export function countUnsynced(db: DB): number {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS n
      FROM memory_events e
      LEFT JOIN memories m ON m.id = e.atom_id
      WHERE e.synced_at IS NULL
        AND e.rejected_at IS NULL
        AND e.event_type NOT IN ('archive', 'restore', 'unsupersede', 'purge', 'unpurge')
        AND (
          m.scope IN ('team', 'org')
          OR (
            e.event_type = 'erase_request'
            AND json_extract(e.payload_json, '$.scope') IN ('team', 'org')
          )
        )
    `)
    .get() as { n: number };
  return row.n;
}

/** Count of events currently marked terminally rejected by the cloud. */
export function countRejected(db: DB): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM memory_events WHERE rejected_at IS NOT NULL`)
    .get() as { n: number };
  return row.n;
}

/**
 * How many of THESE seqs are actually marked rejected — i.e. what a targeted
 * `sync unreject --seq N` would really clear. Distinct from {@link countRejected}
 * so the dry-run preview reports the blast radius of the command the operator
 * typed, not the total across the whole log.
 */
export function countRejectedIn(db: DB, seqs: number[]): number {
  if (seqs.length === 0) return 0;
  const placeholders = seqs.map(() => '?').join(',');
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM memory_events WHERE rejected_at IS NOT NULL AND seq IN (${placeholders})`)
    .get(...seqs) as { n: number };
  return row.n;
}

/**
 * Clear the terminal-reject marker so these events are shipped again — the
 * escape hatch for the one-way door `rejected_at` otherwise creates.
 *
 * WHY THIS MUST EXIST: `rejected_at` is set from the cloud's verdict, and the
 * cloud can be WRONG. If a cloud bug (or a bad deploy, or a guard regression)
 * rejects events it should have accepted, the shipper marks them terminal and
 * `listUnsynced` excludes them forever — the memories are then stranded on the
 * device with no code path that can ever reach them again. Retrying a *correct*
 * reject is merely wasteful; being unable to retry an *incorrect* one is
 * permanent data loss. So the door opens both ways, by hand, on purpose.
 *
 * Deliberately manual (an operator runs `astramem-local sync unreject`): an
 * automatic retry would recreate the very wedge this migration was written to
 * kill. Returns the number of rows cleared.
 */
export function clearRejected(db: DB, seqs?: number[]): number {
  if (seqs !== undefined) {
    if (seqs.length === 0) return 0;
    const placeholders = seqs.map(() => '?').join(',');
    return db
      .prepare(`UPDATE memory_events SET rejected_at = NULL WHERE seq IN (${placeholders}) AND rejected_at IS NOT NULL`)
      .run(...seqs).changes;
  }
  return db
    .prepare(`UPDATE memory_events SET rejected_at = NULL WHERE rejected_at IS NOT NULL`)
    .run().changes;
}

/**
 * A `create` event's payload_json is frozen at write time (append-only log —
 * MemoryEventRepo never rewrites a past event). `promoteScope` (memory-
 * events.ts) promotes `memories.scope` and appends a NEW `promote_scope`
 * event, but by design never rewrites the original `create` event's stale
 * scope field. If that original `create` event hasn't shipped yet (e.g. the
 * atom was private for a while before being promoted), `listUnsynced` still
 * selects it — the row is now team/org — but its payload still says
 * whatever scope it had at creation. The cloud's DEC-048 invariant 1 guard
 * (SyncIngestService.IsPrivateScopedViolation) reads exactly that frozen
 * field and rejects the event forever, wedging the device's sync cursor
 * (sync-promote-wedge fix).
 *
 * The fix is applied HERE, at ship time, rather than by rewriting the
 * stored event row: the device is the only side that knows the atom's
 * live scope (the cloud never received the private `create` in the first
 * place, so it has no history to replay), and layering the correction into
 * the outgoing envelope means every already-queued, already-wedged event
 * self-heals the next time this device ships — no separate backfill step
 * needed for a device that upgrades and restarts its shipper. Only ever
 * narrows/corrects `create` payloads for rows `listUnsynced` already
 * scoped to team/org, so this can never cause a private payload to ship —
 * it only ever replaces one non-private scope string with another.
 */
function withCurrentScope(r: UnsyncedRow, payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (r.event_type !== 'create' || payload === null || r.current_scope === null) return payload;
  return { ...payload, scope: r.current_scope };
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
      event_id: r.event_id,
      event_type: r.event_type,
      atom_id: r.atom_id,
      payload_json: withCurrentScope(r, r.payload_json !== null ? (JSON.parse(r.payload_json) as Record<string, unknown>) : null),
      content_hash: r.content_hash,
      created_at: r.created_at,
    })),
  };
}

export interface ShipOnceResult {
  shipped: number;
  acked: number;
  /**
   * Count of events this round the cloud named in `rejected_seqs` — marked
   * `rejected_at` (terminal, never resent) rather than `synced_at`
   * (sync-promote-wedge fix). 0 on a cloud that doesn't send the field yet
   * (additive, astramem-sync@1 is not version-bumped for it).
   */
  rejected: number;
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
  if (rows.length === 0) return { shipped: 0, acked: 0, rejected: 0, idle: true };

  const envelope = buildEnvelope(opts.deviceId, opts.workspaceId, lastAckedSeq(opts.db), rows);
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${opts.url.replace(/\/$/, '')}/sync/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `ApiKey ${opts.token}`,
    },
    body: JSON.stringify(envelope),
    // A hung cloud socket must not stall shipping rounds indefinitely — abort
    // and let the caller's backoff handle it. Sized for content-carrying create
    // batches: the cloud materializes + embeds each memory synchronously, so a
    // full batch can take tens of seconds (a 10s cap starved large backlog
    // drains — every round timed out). Backoff still bounds a truly hung socket.
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const bodyText = await readErrorBody(res);
    throw new Error(`sync ship failed: HTTP ${res.status}${bodyText ? ` ${bodyText}` : ''}`);
  }
  const body = (await res.json()) as { acked_seq?: number; rejected_seqs?: unknown };
  const ackedSeq = typeof body.acked_seq === 'number' ? body.acked_seq : -1;
  if (ackedSeq < 0) {
    throw new Error('sync ship failed: response missing acked_seq');
  }

  // sync-promote-wedge fix: `rejected_seqs` (additive response field) names
  // events the cloud PERMANENTLY rejected (DEC-048 invariant 1) this round.
  // These must never be retried — restrict to seqs actually in this batch
  // (defense against a malformed/foreign value) and mark them `rejected_at`,
  // not `synced_at`: they were never durably persisted on the cloud side, so
  // claiming them synced would be a lie, but resending them is pointless —
  // the same reject fires every time on the same frozen payload.
  const rowSeqs = new Set(rows.map(r => r.seq));
  const rejectedSeqs = Array.isArray(body.rejected_seqs)
    ? body.rejected_seqs.filter((s): s is number => typeof s === 'number' && rowSeqs.has(s))
    : [];
  const rejectedSet = new Set(rejectedSeqs);

  // Mark ONLY the rows we actually shipped and the server acked — excluding
  // anything it separately named as rejected. Without this exclusion, a
  // rejected row whose seq happens to fall at or below `acked_seq` (because
  // a LATER seq in the same batch succeeded) would get falsely marked
  // synced_at, masking the reject instead of recording it. A partial ack
  // (acked_seq mid-batch) leaves the tail unsynced for the next round.
  const shippedAcked = rows.filter(r => r.seq <= ackedSeq && !rejectedSet.has(r.seq)).map(r => r.seq);
  if (shippedAcked.length > 0) {
    const now = Date.now();
    const placeholders = shippedAcked.map(() => '?').join(', ');
    opts.db
      .prepare(`UPDATE memory_events SET synced_at = ? WHERE seq IN (${placeholders}) AND synced_at IS NULL`)
      .run(now, ...shippedAcked);
  }
  if (rejectedSeqs.length > 0) {
    const now = Date.now();
    const placeholders = rejectedSeqs.map(() => '?').join(', ');
    opts.db
      .prepare(`UPDATE memory_events SET rejected_at = ? WHERE seq IN (${placeholders}) AND rejected_at IS NULL`)
      .run(now, ...rejectedSeqs);
  }
  return { shipped: rows.length, acked: shippedAcked.length, rejected: rejectedSeqs.length, idle: false };
}

/** Pure backoff schedule: base * 2^failures, capped. Exported for tests. */
export function backoffDelay(baseMs: number, consecutiveFailures: number): number {
  return Math.min(baseMs * 2 ** consecutiveFailures, BACKOFF_CAP_MS);
}

/**
 * Describe a ship failure in terms a human can ACT on.
 *
 * The catch block used to log `(err as Error).message` and nothing else. For a
 * failed `fetch`, Node/undici sets that message to the literal string
 * **"fetch failed"** and puts the ACTUAL reason on `err.cause` — an
 * `ECONNRESET`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`, a TLS error, etc.
 * Logging only `.message` therefore threw the diagnosis away and left:
 *
 *     { "err": { "error_message": "fetch failed", "error_kind": "Unknown" } }
 *
 * ...which is what the operator's daemon emitted 37 times. It says the request
 * failed. It does not say why, and there was no other way to find out.
 *
 * Concretely: DNS resolved (api.astramemory.com -> ca-yarp-prod, 57.167.72.99),
 * TCP/443 connected, TLS handshook, the cert was valid — every layer we could
 * check by hand was healthy, and the log still only said "fetch failed". The
 * one fact that would have identified the layer was on `.cause`, discarded.
 *
 * Walks the whole `cause` chain (undici nests them) and surfaces `code`/`errno`,
 * which is the field that actually names the failing layer.
 */
export function describeShipError(err: unknown): {
  err: string;
  err_cause?: string;
  err_code?: string;
} {
  const top = err instanceof Error ? err : new Error(String(err));

  // Walk to the innermost cause — undici nests (TypeError -> AggregateError -> SystemError).
  let cause: unknown = (top as Error & { cause?: unknown }).cause;
  let innermost: Error | undefined;
  const seen = new Set<unknown>(); // cycle guard; a self-referential cause would hang the loop
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    innermost = cause;
    cause = (cause as Error & { cause?: unknown }).cause;
  }

  const code = innermost
    ? ((innermost as Error & { code?: string; errno?: string }).code ??
       (innermost as Error & { code?: string; errno?: string }).errno)
    : undefined;

  return {
    err: top.message,
    ...(innermost && innermost.message !== top.message ? { err_cause: innermost.message } : {}),
    ...(code ? { err_code: code } : {}),
  };
}

/**
 * Last-ship-ATTEMPT state (FEAT-434) — distinct from `lastShipAt`/
 * `countUnsynced` above, which only ever reflect SUCCESS (or ADR-009
 * eligibility). This is what lets `GET /sync/status` (FEAT-427) show
 * "failing/backing off" instead of only ever success/idle.
 *
 * Persisted (not in-memory) for the same reason `sync_pull_state` (migration
 * 010) is persisted rather than kept in the puller's closure: a daemon
 * restart should not silently erase the fact that the last attempt failed —
 * `startShipper`'s own in-memory `failures` counter resets to 0 on restart,
 * but this row does not.
 */
export interface ShipAttemptState {
  last_attempt_at: number | null;
  last_result: 'ok' | 'error' | null;
  /** Sanitized (no token) + length-capped. See {@link recordShipFailure}. */
  last_error: string | null;
  consecutive_failures: number;
  /** Epoch ms of the next scheduled retry, or null when not currently backing off. */
  next_retry_at: number | null;
}

const MAX_SHIP_ERROR_LEN = 500;

/**
 * Strip the device sync token (if present) and cap length before an error
 * message is persisted/exposed. Defense-in-depth: `shipOnce` failures today
 * come from HTTP status text or fetch/transport errors, neither of which
 * includes the bearer token (it's sent as a header, never interpolated into
 * a thrown message) — but a future error path doing so must not leak it via
 * this state row or the FEAT-427 `/sync/status` route that reads it.
 */
export function sanitizeShipError(message: string, token?: string): string {
  let msg = token && token.length > 0 ? message.split(token).join('[redacted]') : message;
  if (msg.length > MAX_SHIP_ERROR_LEN) msg = `${msg.slice(0, MAX_SHIP_ERROR_LEN)}…`;
  return msg;
}

function upsertShipState(
  db: DB,
  row: { last_attempt_at: number; last_result: 'ok' | 'error'; last_error: string | null; consecutive_failures: number; next_retry_at: number | null },
): void {
  db.prepare(
    `INSERT INTO sync_ship_state (id, last_attempt_at, last_result, last_error, consecutive_failures, next_retry_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_attempt_at = excluded.last_attempt_at,
       last_result = excluded.last_result,
       last_error = excluded.last_error,
       consecutive_failures = excluded.consecutive_failures,
       next_retry_at = excluded.next_retry_at`,
  ).run(row.last_attempt_at, row.last_result, row.last_error, row.consecutive_failures, row.next_retry_at);
}

/** Record a successful ship attempt — clears error/backoff state. */
export function recordShipSuccess(db: DB, at: number): void {
  upsertShipState(db, { last_attempt_at: at, last_result: 'ok', last_error: null, consecutive_failures: 0, next_retry_at: null });
}

/** Record a failed ship attempt — captures the (sanitized) error + backoff schedule. */
export function recordShipFailure(
  db: DB,
  at: number,
  error: unknown,
  consecutiveFailures: number,
  nextRetryAt: number,
  token?: string,
): void {
  const raw = error instanceof Error ? error.message : String(error);
  upsertShipState(db, {
    last_attempt_at: at,
    last_result: 'error',
    last_error: sanitizeShipError(raw, token),
    consecutive_failures: consecutiveFailures,
    next_retry_at: nextRetryAt,
  });
}

/**
 * Current persisted ship-attempt state, or all-null/zero defaults if the
 * shipper has never run a round on this DB. Read-only observability helper
 * (FEAT-434 GET /sync/status) — does not affect shipping behavior.
 */
export function getShipAttemptState(db: DB): ShipAttemptState {
  const row = db
    .prepare(
      'SELECT last_attempt_at, last_result, last_error, consecutive_failures, next_retry_at FROM sync_ship_state WHERE id = 1',
    )
    .get() as
    | {
        last_attempt_at: number | null;
        last_result: 'ok' | 'error' | null;
        last_error: string | null;
        consecutive_failures: number;
        next_retry_at: number | null;
      }
    | undefined;
  if (!row) {
    return { last_attempt_at: null, last_result: null, last_error: null, consecutive_failures: 0, next_retry_at: null };
  }
  return row;
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
    const attemptAt = Date.now();
    let delay = intervalMs;
    try {
      const result = await shipOnce(opts);
      failures = 0;
      recordShipSuccess(opts.db, attemptAt);
      if (!result.idle) {
        logger.info({ shipped: result.shipped, acked: result.acked, rejected: result.rejected }, 'sync: batch shipped');
      }
    } catch (err) {
      failures++;
      delay = backoffDelay(intervalMs, failures);
      recordShipFailure(opts.db, attemptAt, err, failures, attemptAt + delay, opts.token);
      logger.warn(
        { ...describeShipError(err), consecutive_failures: failures },
        'sync: ship failed — will retry with backoff',
      );
    }
    if (!stopped) {
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
