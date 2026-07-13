import { isLoopbackHost } from './network.js';

/**
 * originIsLoopback — shared by app.ts's devNoAuth API preHandler and
 * dashboard-auth.ts's checkDashboardAuth. Both need the same CSRF guard: a
 * `<form method="post">` on a malicious page is a CORS "simple request" (no
 * preflight), and on a form POST the Host header is always the TARGET
 * (this daemon, always loopback under devNoAuth), never the page that
 * fired it — so the Host-header loopback check alone cannot tell a
 * same-origin form submission apart from a cross-site one. `Origin` is the
 * one header a form POST carries that reflects the calling page; treat a
 * present-but-non-loopback Origin as forbidden. No Origin header at all
 * (curl, scripts, same-origin navigations) is unaffected by this check.
 */
export function originIsLoopback(origin: string): boolean {
  try {
    // URL.hostname keeps IPv6 brackets ("[::1]"), while isLoopbackHost compares
    // against the bare '::1' — strip them, the same way isLoopbackHostHeader does.
    // Without this a daemon bound to ::1 would 403 its own dashboard form posts.
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    return isLoopbackHost(hostname);
  } catch {
    return false;
  }
}
