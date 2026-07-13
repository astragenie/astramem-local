/**
 * isLoopbackHost — the single predicate that decides both (a) whether the
 * HTTP server binds beyond the local machine and (b) whether /health and
 * /version stay public (FEAT-406).
 *
 * Deriving the auth boundary from the same value that controls the bind
 * (rather than a second independent "require auth" flag) closes the gap the
 * PM pre-mortem flagged: a config typo or partial rollout can no longer
 * leave the daemon bound non-locally while /health/version stay
 * unauthenticated — there is only one knob, not two that can disagree.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/**
 * isLoopbackHostHeader — the DNS-rebinding guard for dev no-auth mode
 * (config.ts `auth.devNoAuth`). Extracts the hostname portion of an HTTP
 * `Host` header (stripping a trailing `:<port>` and IPv6 brackets) and
 * checks it against `isLoopbackHost`.
 *
 * This is the one thing standing between "any process on localhost can read
 * the memory store" (the disclosed, accepted risk of devNoAuth) and "any
 * website the operator's browser visits can read the memory store" (DNS
 * rebinding: a page served from `evil.com` points its own DNS record at
 * 127.0.0.1 and the browser's `fetch('http://evil.com:7777/...')` — same-
 * origin rules don't help because the Host header, not the IP the socket
 * connects to, is what a rebinding attack controls). A stray or forged Host
 * header that isn't loopback must be rejected even though the daemon really
 * is bound to loopback.
 */
export function isLoopbackHostHeader(hostHeader: string): boolean {
  const h = hostHeader.trim();
  const bracketed = h.match(/^\[([^\]]+)\](?::\d+)?$/); // "[::1]" or "[::1]:7777"
  if (bracketed) return isLoopbackHost(bracketed[1] as string);
  const firstColon = h.indexOf(':');
  const lastColon = h.lastIndexOf(':');
  // Exactly one colon => "host:port" (bare, unbracketed IPv6 has 2+ colons
  // and is left untouched — real Host headers always bracket IPv6 anyway).
  const hostname = firstColon !== -1 && firstColon === lastColon ? h.slice(0, lastColon) : h;
  return isLoopbackHost(hostname);
}
