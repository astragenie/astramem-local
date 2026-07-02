/**
 * GET /dashboard?token=<bearer>
 *
 * Read-only HTML metrics dashboard. Token validated via query param (same
 * Bearer value as Authorization header on other routes). Returns 401 plain
 * text on missing/wrong token; 200 text/html otherwise.
 *
 * No JS, no external assets. <meta refresh content="5"> drives auto-poll.
 */

import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import type { Config } from '../../config/config.js';
import { queryDashboard } from '../queries/dashboard.js';
import { renderDashboard } from './dashboard-html.js';
import { childLogger } from '../../log/logger.js';

export function dashboardRoute(db: DB, config: Config, token: string) {
  return async (app: FastifyInstance) => {
    app.get('/dashboard', async (req, reply) => {
      const requestId = (req as unknown as Record<string, unknown>)['requestId'] as string | undefined;
      const log = childLogger({ request_id: requestId ?? 'unknown' });

      // Token validated via query param — same Bearer value as Authorization header.
      // Auth is enforced here rather than in the global preHandler because the
      // dashboard uses ?token= (browser-friendly) instead of an Authorization header.
      const query = req.query as Record<string, string | undefined>;
      const queryToken = query['token'];

      if (!queryToken || queryToken !== token) {
        log.warn({ method: req.method, path: req.url }, 'dashboard: unauthorized');
        return reply
          .code(401)
          .header('content-type', 'text/plain; charset=utf-8')
          .send('401 Unauthorized - supply ?token=<bearer>');
      }

      const data = await queryDashboard(db);
      const html = renderDashboard(data, config);

      return reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(html);
    });
  };
}
