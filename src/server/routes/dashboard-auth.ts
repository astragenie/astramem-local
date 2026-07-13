/**
 * Shared auth check for every /dashboard* page (dashboard.ts + the
 * dashboard-*-html.ts siblings). Previously each file duplicated its own
 * bearerOk/cookieOk check "by design" (independent reviewability); adding a
 * second auth mode (dev no-auth, see below) to N hand-copied checks would
 * have let them drift, so this is now the one place that decides.
 *
 * Behavior:
 *   1. `auth.devNoAuth` active (config true AND loopback bind — computed
 *      once in app.ts and threaded down to every dashboard route factory)
 *      AND the request's Host header resolves to loopback
 *      (`isLoopbackHostHeader`) => access granted, no token/cookie required
 *      (subject to the Origin check below).
 *   2. `devNoAuth` active but Host does NOT resolve to loopback => 403. This
 *      is the same DNS-rebinding defense app.ts's preHandler applies to API
 *      routes (see network.ts's isLoopbackHostHeader doc comment) — without
 *      it, a page a rebinding attack served under an attacker-controlled
 *      hostname could read memory titles/metrics off the dashboard.
 *   3. `devNoAuth` active, Host is loopback, but an `Origin` header is
 *      present and does NOT resolve to loopback => 403. A `<form
 *      method="post">` on a malicious page is a CORS "simple request" — no
 *      preflight — and on a form POST the Host header is always the
 *      TARGET (this daemon, always loopback), never the page that fired
 *      it, so check #1/#2 above cannot see that the request actually
 *      originated from an attacker's page rather than the dashboard's own
 *      forms. `Origin` is the one header a form POST carries that reflects
 *      the calling page. With `devNoAuth` off this hole is already closed
 *      by `SameSite=Strict` on the session cookie (a cross-site form POST
 *      simply doesn't attach it), so this check only needs to run in the
 *      devNoAuth branch. No `Origin` header at all (curl, scripts,
 *      same-origin navigations) passes through unchanged.
 *   4. `devNoAuth` inactive => unchanged pre-existing behavior: Bearer header
 *      or the HttpOnly `astramem_dash` cookie (bootstrapped once via
 *      dashboard.ts's `?token=` redirect) must match.
 */

import type { FastifyRequest } from 'fastify';
import { isLoopbackHostHeader } from '../lib/network.js';
import { originIsLoopback } from '../lib/origin-guard.js';

export const DASHBOARD_COOKIE_NAME = 'astramem_dash';

export function readDashboardCookie(req: FastifyRequest, name: string = DASHBOARD_COOKIE_NAME): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export type DashboardAuthResult =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; body: string };

/**
 * Full auth decision for a /dashboard* request. `devNoAuthActive` must be
 * the same boot-computed condition app.ts derives (config.auth.devNoAuth
 * === true AND the daemon is bound to loopback) — callers must not
 * recompute it independently.
 */
export function checkDashboardAuth(
  req: FastifyRequest,
  token: string,
  devNoAuthActive: boolean,
): DashboardAuthResult {
  if (devNoAuthActive) {
    const hostHeader = req.headers.host ?? '';
    if (!isLoopbackHostHeader(hostHeader)) {
      return { allowed: false, status: 403, body: '403 Forbidden - non-loopback Host header' };
    }
    const origin = req.headers.origin;
    if (origin && !originIsLoopback(origin)) {
      return { allowed: false, status: 403, body: '403 Forbidden - non-loopback Origin header' };
    }
    return { allowed: true };
  }

  const authHeader = req.headers.authorization;
  const bearerOk = authHeader === `Bearer ${token}`;
  const cookieOk = readDashboardCookie(req) === token;
  if (bearerOk || cookieOk) return { allowed: true };

  return {
    allowed: false,
    status: 401,
    body: '401 Unauthorized - supply Authorization: Bearer <token> or bootstrap once with ?token=<bearer>',
  };
}
