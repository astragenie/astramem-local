/**
 * GET /dashboard
 *
 * Read-only HTML metrics dashboard. Auth accepts (in order):
 *   1. Authorization: Bearer <token> — same as every other route.
 *   2. HttpOnly session cookie (set by the one-time bootstrap below).
 *   3. ?token=<bearer> — bootstrap ONLY: exchanged for the cookie via a 302
 *      redirect to the clean URL, so the bearer never persists in browser
 *      history and is not re-sent by the <meta refresh> poll.
 * Returns 401 plain text on missing/wrong credentials; the 401 log strips the
 * query string so wrong-token attempts don't persist candidate secrets.
 *
 * No JS, no external assets. <meta refresh content="5"> drives auto-poll.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '../../storage/db.js';
import type { Config } from '../../config/config.js';
import { queryDashboard } from '../queries/dashboard.js';
import { renderDashboard } from './dashboard-html.js';
import { childLogger } from '../../log/logger.js';

const COOKIE_NAME = 'astramem_dash';

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function dashboardRoute(db: DB, config: Config, token: string) {
  return async (app: FastifyInstance) => {
    app.get('/dashboard', async (req, reply) => {
      const requestId = (req as unknown as Record<string, unknown>)['requestId'] as string | undefined;
      const log = childLogger({ request_id: requestId ?? 'unknown' });

      const authHeader = req.headers.authorization;
      const bearerOk = authHeader === `Bearer ${token}`;
      const cookieOk = readCookie(req, COOKIE_NAME) === token;

      if (!bearerOk && !cookieOk) {
        const queryToken = (req.query as Record<string, string | undefined>)['token'];
        if (queryToken === token) {
          // Bootstrap: swap the URL token for an HttpOnly cookie and redirect
          // to the clean path so the bearer leaves the address bar immediately.
          // No Secure flag: the daemon is plain-HTTP on 127.0.0.1 by design.
          return reply
            .header(
              'set-cookie',
              `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/dashboard`,
            )
            .redirect('/dashboard', 302);
        }
        // Strip the query string from the log — a wrong ?token= is a candidate
        // credential and must not persist in log files.
        log.warn({ method: req.method, path: req.url.split('?')[0] }, 'dashboard: unauthorized');
        return reply
          .code(401)
          .header('content-type', 'text/plain; charset=utf-8')
          .send('401 Unauthorized - supply Authorization: Bearer <token> or bootstrap once with ?token=<bearer>');
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
