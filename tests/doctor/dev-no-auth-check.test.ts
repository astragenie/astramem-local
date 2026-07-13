/**
 * tests/doctor/dev-no-auth-check.test.ts
 *
 * Genuine, every-run WARN while `auth.devNoAuth` is genuinely ACTIVE — same
 * posture as tests/doctor/proxy-capture-warn-check.test.ts. `devNoAuthActive`
 * mirrors buildApp's own predicate (src/server/app.ts): configured true but
 * refused (non-loopback bind) must NOT warn here, since auth stays enforced
 * in that case.
 */
import { describe, it, expect } from 'vitest';
import { getChecks } from '../../src/doctor/checks.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

const CHECK_NAME = 'Dev no-auth mode';

describe('doctor "Dev no-auth mode" WARN', () => {
  it('defaults to ok:true when devNoAuthActive is omitted', async () => {
    const result = await findCheck(getChecks({}), CHECK_NAME).run();
    expect(result.ok).toBe(true);
  });

  it('devNoAuthActive: false — ok:true', async () => {
    const result = await findCheck(getChecks({ devNoAuthActive: false }), CHECK_NAME).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('off');
  });

  it('devNoAuthActive: true — genuine WARN (ok:false)', async () => {
    const result = await findCheck(getChecks({ devNoAuthActive: true }), CHECK_NAME).run();
    expect(result.ok).toBe(false);
    expect(result.message.toLowerCase()).toContain('every local process');
    expect(result.message.toLowerCase()).toContain('sync pairing to prod');
    expect(result.fix).toBeDefined();
  });
});
