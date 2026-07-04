/**
 * GET /dashboard/search — STUB (FEAT-410 wave 1, SLICE-410-1).
 *
 * Wave-2 (SLICE-410-6) replaces the render internals of this file ONLY,
 * backed by SLICE-410-3's `debug: true` search path (src/search/search.ts).
 * The route registration in app.ts and this auth wrapper are the stable
 * contract it builds on — `embed` is threaded through now so wave-2 does
 * not need an app.ts change to reach the provider it will call search()
 * with.
 *
 * Auth mirrors src/server/routes/dashboard.ts (Bearer header or the
 * HttpOnly `astramem_dash` cookie bootstrapped there) but the check is
 * duplicated locally by design — see dashboard-consolidation-html.ts for
 * the same rationale.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from '../../storage/db.js';
import type { EmbedProvider } from '../../contracts/index.js';

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

/** `db`/`embed` are accepted (unused by the stub) so wave-2's real
 *  implementation doesn't need to change this factory's signature or
 *  app.ts's call site. */
export function dashboardSearchRoute(_db: DB, _embed: EmbedProvider, token: string) {
  return async (app: FastifyInstance) => {
    app.get('/dashboard/search', async (req, reply) => {
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
<title>AstraMemory Dashboard — Search debug</title>
</head>
<body>
<h1>Search debug</h1>
<p>coming in wave 2</p>
</body>
</html>`;
}
