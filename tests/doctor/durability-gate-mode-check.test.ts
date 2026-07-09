/**
 * tests/doctor/durability-gate-mode-check.test.ts
 *
 * FEAT-441 AC-8: doctor's "Distill durability gate" check is an
 * informational row reporting the current `distill.durabilityGate` mode —
 * never a WARN in any mode ('off'/'lenient'/'strict' all report ok: true).
 * Added per this repo's per-check test-file convention (see
 * tests/doctor/schema-drift-check.test.ts) — the review round flagged this
 * check as the one doctor check with no dedicated test file.
 */
import { describe, it, expect } from 'vitest';
import { getChecks } from '../../src/doctor/checks.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Distill durability gate" check (FEAT-441 AC-8)', () => {
  it('defaults to "off" when durabilityGateMode is omitted, and is always ok', async () => {
    const check = findCheck(getChecks({}), 'Distill durability gate');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('off');
    expect(result.message).toContain('default');
  });

  it('reports "off" verbatim and never WARNs', async () => {
    const check = findCheck(getChecks({ durabilityGateMode: 'off' }), 'Distill durability gate');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('off');
  });

  it('reports "lenient" and is still ok (opt-in mode, not a misconfiguration)', async () => {
    const check = findCheck(getChecks({ durabilityGateMode: 'lenient' }), 'Distill durability gate');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('lenient');
  });

  it('reports "strict" and is still ok (opt-in mode, not a misconfiguration)', async () => {
    const check = findCheck(getChecks({ durabilityGateMode: 'strict' }), 'Distill durability gate');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('strict');
  });
});
