import type { Check, CheckResult } from '../types.js';

// ─── Check: Daemon reachable on configured port ──────────────────────────────

export function checkDaemonReachable(port: number): Check {
  return {
    name: `Daemon reachable on :${port}`,
    // Loopback-only HTTP probe (127.0.0.1) — no network call leaves the box,
    // matching schedule.ts's "cheap tier" definition.
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3_000);
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`, {
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (res.ok) {
            const body = await res.json() as { ok?: boolean };
            return { ok: true, message: `daemon healthy on port ${port}` };
          }
          return {
            ok: false,
            message: `daemon returned HTTP ${res.status} on :${port}`,
            fix: `astramem-local serve --port ${port}`,
          };
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        return {
          ok: false,
          message: `daemon not reachable on port ${port}`,
          fix: `astramem-local serve --port ${port}`,
        };
      }
    },
  };
}
