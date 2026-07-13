import type { Check, CheckResult } from '../types.js';

// ─── Check: Proxy capture reminder (FEAT-458 S4, ADR-013) ────────────────────

/**
 * Genuine, every-run WARN while proxy capture is actively ON — deliberately
 * a SEPARATE check from `checkProxyCapture` (S1's "LLM proxy" row), not an
 * extension of it. `checkProxyCapture` stays `ok: true` in every state by
 * design: being ON is a disclosed, opt-in choice (ADR-013 §5), so merely
 * being ON is never itself a misconfiguration — that posture is correct and
 * this check doesn't change it (config.ts:344's comment: "so `doctor` has
 * something to read (FEAT-458 S4)" describes THIS row, not a retrofit of
 * that one).
 *
 * The reason a distinct row is warranted: unlike `checkAutoCapture`'s
 * "wired, never fired" canary (a one-shot misconfiguration to detect and
 * clear), proxy capture recording upstream LLM PROMPTS while active is an
 * ongoing fact the operator should be reminded of on every single `doctor`
 * run for as long as it stays on — not just disclosed once at opt-in time.
 * So `ok: false` here is unconditional on "capture is enabled" (no DB
 * content check, no count, no threshold) — it fires immediately and clears
 * immediately the moment `astramem-local capture proxy disable` flips
 * `proxy.capture.enabled` back to false (S3, src/cli/capture.ts).
 */
export function checkProxyCaptureReminder(proxyEnabled: boolean, captureEnabled: boolean): Check {
  return {
    name: 'Proxy capture reminder',
    async run(): Promise<CheckResult> {
      if (!proxyEnabled || !captureEnabled) {
        return { ok: true, message: 'proxy capture: off' };
      }
      return {
        ok: false,
        message:
          'proxy capture is ON — every upstream LLM prompt routed through this proxy is being recorded ' +
          'until you turn it off.',
        fix: 'astramem-local capture proxy disable [--purge|--keep]',
      };
    },
  };
}
