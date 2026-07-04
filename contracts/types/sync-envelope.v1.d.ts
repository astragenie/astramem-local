/* eslint-disable */
/**
 * GENERATED — do not edit. Source: contracts/schemas/sync-envelope.v1.schema.json
 * Regenerate: node contracts/generate-types.mjs
 */

/**
 * One-way, append-only, idempotent log-shipping envelope (ADR-003). local -> cloud POST /sync/events. Event shape mirrors the memory_events table (migration 007-memory-events.sql) verbatim, with payload_json unwrapped to a plain object on the wire (the DB column stores it as a TEXT-serialized string; the wire form parses it once at the boundary).
 */
export interface SyncEnvelopeV1 {
  protocol: 'astramem-sync@1';
  device_id: string;
  workspace_id: string;
  /**
   * Per-device monotonic seq — the last seq the client believes is acked. Resume = send from last ack.
   */
  cursor: number;
  /**
   * Batch of memory_events rows in seq order. May be empty (e.g. a capabilities/cursor heartbeat with nothing new to ship).
   */
  events: {
    /**
     * memory_events.seq — per-device monotonic, AUTOINCREMENT locally.
     */
    seq: number;
    /**
     * ADR-011 globally-unique event identity (migration 010). Additive field, NOT required — older push clients that predate ADR-011 may omit it without breaking envelope validation (ADR-001 additive-field evolution rule, no astramem-sync@1 version bump). Cloud/pull-side dedup and the multi-device conflict tie-break both key on this once present.
     */
    event_id?: string;
    event_type: 'create' | 'invalidate' | 'supersede' | 'promote_scope' | 'erase_request' | 'usefulness';
    atom_id: string;
    /**
     * Event-specific payload, parsed to a plain object (or null when the row has none).
     */
    payload_json?: {} | null;
    /**
     * Idempotency key — cloud dedups on (workspace_id, content_hash). null only for legacy rows predating hash backfill.
     */
    content_hash?: string | null;
    /**
     * Epoch ms — mirrors memory_events.created_at (INTEGER column), not ISO string, to keep the sync wire shape a 1:1 mirror of the source-of-truth log row.
     */
    created_at: number;
  }[];
}
