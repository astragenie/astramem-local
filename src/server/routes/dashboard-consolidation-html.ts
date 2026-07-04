/**
 * GET /dashboard/consolidation — STUB (FEAT-410 wave 1, SLICE-410-1).
 *
 * Wave-2 (SLICE-410-2) replaces the render internals of this file ONLY —
 * the route registration in app.ts and this auth wrapper are the stable
 * contract it builds on.
 *
 * Auth mirrors src/server/routes/dashboard.ts (Bearer header or the
 * HttpOnly `astramem_dash` cookie bootstrapped there) but the check is
 * duplicated locally by design rather than imported — each dashboard page
 * module stays independently reviewable and wave-2 slices are forbidden
 * from touching app.ts, so the auth wrapper here must be self-contained.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '../../storage/db.js';

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

/** `db` is accepted (unused by the stub) so wave-2's real implementation
 *  doesn't need to change this factory's signature or app.ts's call site. */
export function dashboardConsolidationRoute(_db: DB, token: string) {
  return async (app: FastifyInstance) => {
    app.get('/dashboard/consolidation', async (req, reply) => {
      const authHeader = req.headers.authorization;
      const bearerOk = authHeader === `Bearer ${token}`;
      const cookieOk = readCookie(req, COOKIE_NAME) === token;

      if (!bearerOk && !cookieOk) {
        return reply
          .code(401)
          .header('content-type', 'text/plain; charset=utf-8')
          .send('401 Unauthorized');
      }

      return reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(placeholderHtml());
    });
  };
}

function placeholderHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AstraMemory Dashboard — Consolidation</title>
</head>
<body>
<h1>Consolidation</h1>
<p>coming in wave 2</p>
</body>
</html>`;
}
