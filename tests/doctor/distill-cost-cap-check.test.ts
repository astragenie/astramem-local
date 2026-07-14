/**
 * tests/doctor/distill-cost-cap-check.test.ts
 *
 * doctor's "Distill cost cap" check is an informational row reporting the
 * current `distill.costCap` state — never a WARN either way (mirrors
 * `checkExtractProfile`/`checkDurabilityGateMode`'s precedent: a
 * deliberate, disclosed config choice is never itself a failure). Its job
 * is making the beta-default OFF state visible on every `doctor` run, and
 * surfacing the configured limits when an operator opts in. Added per this
 * repo's per-check test-file convention (see
 * tests/doctor/extract-profile-check.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { getChecks } from '../../src/doctor/checks.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find((c) => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Distill cost cap" check', () => {
  it('reports disabled (beta default) when distillCostCap is omitted, and is always ok', async () => {
    const check = findCheck(getChecks({}), 'Distill cost cap');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('disabled');
    expect(result.message).toContain('beta default');
  });

  it('reports disabled explicitly when enabled: false', async () => {
    const check = findCheck(getChecks({ distillCostCap: { enabled: false } }), 'Distill cost cap');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('disabled');
  });

  it('reports enabled with configured limits', async () => {
    const check = findCheck(
      getChecks({ distillCostCap: { enabled: true, maxCallsPerJob: 30, maxWallClockMs: 120_000 } }),
      'Distill cost cap',
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('enabled');
    expect(result.message).toContain('maxCallsPerJob=30');
    expect(result.message).toContain('maxWallClockMs=120000');
  });

  it('reports enabled with no limits configured (enabled but has no effect)', async () => {
    const check = findCheck(getChecks({ distillCostCap: { enabled: true } }), 'Distill cost cap');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('enabled');
    expect(result.message.toLowerCase()).toContain('no limits');
  });
});
