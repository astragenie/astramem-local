import type { Check, CheckResult } from '../types.js';

// ─── Check: Dev no-auth mode reminder (Config['auth'] devNoAuth) ─────────────

/**
 * Genuine, every-run WARN while `auth.devNoAuth` is active — same posture as
 * `checkProxyCaptureReminder` (an ongoing, disclosed risk the operator
 * should be reminded of on every single `doctor` run for as long as it stays
 * on, not a one-shot wiring canary). `devNoAuthActive` mirrors the exact
 * predicate `buildApp` uses to decide whether the auth hook actually skips
 * enforcement (`config.auth.devNoAuth === true && isLoopbackHost(host)`) —
 * this check WARNs only when auth is genuinely bypassed, not merely
 * configured-but-refused (the non-loopback-bind case already logs its own
 * loud boot-time warning in app.ts and leaves Bearer enforcement in place).
 */
export function checkDevNoAuth(devNoAuthActive: boolean): Check {
  return {
    name: 'Dev no-auth mode',
    tier: 'cheap', // config-only, no I/O
    async run(): Promise<CheckResult> {
      if (!devNoAuthActive) {
        return { ok: true, message: 'dev no-auth mode: off' };
      }
      return {
        ok: false,
        message:
          'auth disabled for local dev — every local process can read/write memories; ' +
          'do not run with sync pairing to prod.',
        fix: 'set auth.devNoAuth: false in config.yaml',
      };
    },
  };
}
