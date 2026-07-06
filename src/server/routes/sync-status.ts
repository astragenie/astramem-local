/**
 * GET /sync/status (FEAT-427, extended FEAT-434) — read-only observability
 * over the local shipper (ADR-003) + puller (ADR-011). Reports what the
 * daemon already knows from persisted local state; never talks to the cloud
 * and never changes sync behavior, so this works identically whether or not
 * the SaaS is reachable.
 *
 * Bearer-gated like every route except /health, /version, and /dashboard —
 * it reveals workspace config (apiUrl/workspaceId), so it stays behind the
 * app-level auth preHandler (server/app.ts) rather than joining the public
 * exemption list. The device sync token is NEVER included in the response
 * (`last_attempt.last_error` is sanitized by shipper.ts before it is ever
 * persisted, so there is nothing to redact here).
 *
 * `last_ship` (FEAT-427) only ever reflects a SUCCESSFUL ship — its own
 * review flagged that this made "failing/backing off" unobservable. FEAT-434
 * adds the sibling `last_attempt` block, sourced from the persisted
 * `sync_ship_state` row (shipper.ts `getShipAttemptState`), which covers
 * every attempt (success or failure) and is left as an additive field
 * rather than folded into `last_ship` to avoid changing that block's shape.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import type { Config } from '../../config/config.js';
import { lastAckedSeq, lastShipAt, countUnsynced, getShipAttemptState } from '../../sync/shipper.js';
import { getPullWatermark } from '../../sync/puller.js';

type LastShipStatus = 'disabled' | 'never_shipped' | 'up_to_date' | 'pending';

export function syncStatusRoute(db: DB, config: Config) {
  return async (app: FastifyInstance) => {
    app.get('/sync/status', async () => {
      const enabled = config.sync.enabled;
      const pendingCount = countUnsynced(db);
      const shipAt = lastShipAt(db);
      const attempt = getShipAttemptState(db);

      let status: LastShipStatus;
      if (!enabled) status = 'disabled';
      else if (shipAt === null) status = 'never_shipped';
      else status = pendingCount === 0 ? 'up_to_date' : 'pending';

      return {
        enabled,
        // Never the device token/api key — only the non-secret endpoint + workspace identity.
        apiUrl: config.sync.url || null,
        workspaceId: config.sync.workspaceId,
        last_ship: {
          at: shipAt,
          status,
        },
        // FEAT-434: every attempt (success or failure), not just successes.
        last_attempt: {
          at: attempt.last_attempt_at,
          result: attempt.last_result,
          error: attempt.last_error,
          consecutive_failures: attempt.consecutive_failures,
          next_retry_at: attempt.next_retry_at,
        },
        pending_count: pendingCount,
        cursor: {
          // ADR-003 push cursor — last acked seq sent in the sync envelope.
          push_seq: lastAckedSeq(db),
          // ADR-011 pull watermark — opaque resume token, null = never pulled.
          pull_watermark: getPullWatermark(db),
        },
      };
    });
  };
}
