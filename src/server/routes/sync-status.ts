/**
 * GET /sync/status (FEAT-427) — read-only observability over the local
 * shipper (ADR-003) + puller (ADR-011). Reports what the daemon already
 * knows from persisted local state; never talks to the cloud and never
 * changes sync behavior, so this works identically whether or not the SaaS
 * is reachable.
 *
 * Bearer-gated like every route except /health, /version, and /dashboard —
 * it reveals workspace config (apiUrl/workspaceId), so it stays behind the
 * app-level auth preHandler (server/app.ts) rather than joining the public
 * exemption list. The device sync token is NEVER included in the response.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import type { Config } from '../../config/config.js';
import { lastAckedSeq, lastShipAt, countUnsynced } from '../../sync/shipper.js';
import { getPullWatermark } from '../../sync/puller.js';

type LastShipStatus = 'disabled' | 'never_shipped' | 'up_to_date' | 'pending';

export function syncStatusRoute(db: DB, config: Config) {
  return async (app: FastifyInstance) => {
    app.get('/sync/status', async () => {
      const enabled = config.sync.enabled;
      const pendingCount = countUnsynced(db);
      const shipAt = lastShipAt(db);

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
