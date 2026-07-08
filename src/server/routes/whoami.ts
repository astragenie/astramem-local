import type { FastifyInstance } from 'fastify';
import { PKG_VERSION } from '../lib/wire-meta.js';

/**
 * GET /whoami — authenticated bearer-verification probe (issue #129).
 *
 * `/health` and `/version` are public whenever the daemon is bound to
 * loopback (see `isLoopbackHost` in `src/server/app.ts`), so neither can be
 * used by `connect` flows to confirm a bearer token actually works on a
 * default (loopback) install. This route is never added to that public-path
 * exemption, so it always requires `Authorization: Bearer <token>` — on
 * every bind, loopback included. Reaching this handler at all means the
 * global `preHandler` hook (`app.ts`) already ran `safeBearerEqual` (FEAT-430
 * constant-time compare) and accepted the token, so there is nothing to
 * re-check here.
 */
export async function whoamiRoute(app: FastifyInstance) {
  app.get('/whoami', async () => ({
    authenticated: true,
    service: 'astramemory-local',
    version: PKG_VERSION,
  }));
}
