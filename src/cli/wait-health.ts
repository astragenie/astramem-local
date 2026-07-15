/**
 * Poll the daemon's /health endpoint until it returns 200 or timeout.
 */
export async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return true;
    } catch {
      // keep polling
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

export interface VersionResult {
  /** The daemon reported `expected` within the budget. */
  ok: boolean;
  /** Last version the daemon reported, if /version answered at least once. */
  served?: string;
  /** True if /version answered at all (even with a mismatched version). Lets
   *  the caller distinguish "never answered" (busy/crash → timeout) from
   *  "answered the wrong version" (stale shadow install / corrupt release). */
  responded: boolean;
}

/**
 * Poll the daemon's public /version endpoint until it reports `expected` or the
 * budget expires. This REPLACES the old single one-shot `fetch(/version)` whose
 * fixed 3s timeout aborted the whole reinstall (rolling back the repoint) if the
 * daemon's event loop was momentarily busy — which it reliably is right after
 * boot, when job recovery requeues distill/consolidate jobs and they start
 * firing LLM calls. /health can be up (waitForHealth already passed) while a
 * single /version shot still catches a busy window. Polling with a per-attempt
 * timeout and retry rides that out, and also tolerates the brief race where the
 * OLD daemon still answers the port before the new one takes over.
 */
export async function waitForVersion(
  port: number,
  expected: string,
  timeoutMs: number,
): Promise<VersionResult> {
  const url = `http://127.0.0.1:${port}/version`;
  const deadline = Date.now() + timeoutMs;
  let served: string | undefined;
  let responded = false;
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      const body = (await res.json()) as { version?: string };
      if (typeof body.version === 'string') {
        responded = true;
        served = body.version;
        if (body.version === expected) return { ok: true, served, responded: true };
      }
    } catch {
      // transient busy / abort / connection reset during boot — keep polling
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return { ok: false, served, responded };
}
