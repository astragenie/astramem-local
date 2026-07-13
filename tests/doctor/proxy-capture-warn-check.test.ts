/**
 * tests/doctor/proxy-capture-warn-check.test.ts
 *
 * FEAT-458 S4 (ADR-013, config.ts:344's deferred-to-S4 comment): a genuine,
 * every-run WARN while proxy capture is actively ON — distinct from S1's
 * `checkProxyCapture` ("LLM proxy" row, tests/doctor/proxy-check.test.ts),
 * which stays `ok: true` in every state by design (being ON is a deliberate
 * opt-in, not itself a misconfiguration — see that check's doc comment).
 *
 * This row exists for a different reason: while proxy capture is on, every
 * upstream LLM prompt routed through the relay is being recorded. That's not
 * a wiring bug to detect once (unlike `checkAutoCapture`'s "wired, never
 * fired" canary) — it's an ongoing fact the operator should be reminded of
 * on EVERY `doctor` run for as long as it stays on, so `ok: false` here is
 * unconditional on "capture is enabled", not gated on any DB content check.
 */
import { describe, it, expect } from 'vitest';
import { getChecks } from '../../src/doctor/checks.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

const CHECK_NAME = 'Proxy capture reminder';

describe('doctor "Proxy capture reminder" WARN (FEAT-458 S4)', () => {
  it('defaults to ok:true when proxyEnabled/proxyCaptureEnabled are omitted', async () => {
    const result = await findCheck(getChecks({}), CHECK_NAME).run();
    expect(result.ok).toBe(true);
  });

  it('proxy off, capture off — ok:true', async () => {
    const result = await findCheck(
      getChecks({ proxyEnabled: false, proxyCaptureEnabled: false }),
      CHECK_NAME,
    ).run();
    expect(result.ok).toBe(true);
  });

  it('proxy off, capture (incoherently) on — ok:true, since proxy gates capture', async () => {
    const result = await findCheck(
      getChecks({ proxyEnabled: false, proxyCaptureEnabled: true }),
      CHECK_NAME,
    ).run();
    expect(result.ok).toBe(true);
  });

  it('proxy on, capture off — ok:true (transparent forward only, nothing recorded)', async () => {
    const result = await findCheck(
      getChecks({ proxyEnabled: true, proxyCaptureEnabled: false }),
      CHECK_NAME,
    ).run();
    expect(result.ok).toBe(true);
  });

  it('proxy on, capture on — genuine WARN (ok:false) every run, no DB access required', async () => {
    const result = await findCheck(
      getChecks({ proxyEnabled: true, proxyCaptureEnabled: true }),
      CHECK_NAME,
    ).run();
    expect(result.ok).toBe(false);
    expect(result.message.toLowerCase()).toContain('recorded');
    expect(result.fix).toBeDefined();
    expect(result.fix).toContain('capture proxy disable');
  });
});
