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
