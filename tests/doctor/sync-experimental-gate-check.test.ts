/**
 * tests/doctor/sync-experimental-gate-check.test.ts
 *
 * sync-experimental-gate slice: doctor's "Sync experimental gate" row.
 * Same `ok: true`-in-every-state posture as tests/doctor/proxy-check.test.ts's
 * "LLM proxy" row — an operator who never paired, or who paired but hasn't
 * opted into the experimental gate, is not misconfigured (see
 * checkSyncExperimentalGate's doc comment in
 * src/doctor/checks/sync-experimental-gate.ts for why). This is a
 * state-visibility row, not a pass/fail gate.
 */
import { describe, it, expect } from 'vitest';
import { getChecks } from '../../src/doctor/checks.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Sync experimental gate" check (sync-experimental-gate slice)', () => {
  function checkFor(syncEnabled: boolean, syncExperimental: boolean) {
    return findCheck(getChecks({ syncEnabled, syncExperimental }), 'Sync experimental gate');
  }

  it('defaults to off when syncEnabled/syncExperimental are omitted, and is always ok', async () => {
    const check = findCheck(getChecks({}), 'Sync experimental gate');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('sync: off (not paired');
  });

  it('sync not paired (enabled=false) — reports off, regardless of experimental', async () => {
    const result = await checkFor(false, true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('sync: off (not paired');
  });

  it('paired but experimental=false — reports the gate closed, never started', async () => {
    const result = await checkFor(true, false).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('sync: experimental gate closed (not started)');
    expect(result.message).toContain('sync.experimental: true');
  });

  it('paired and experimental=true — reports the gate open / shipper active', async () => {
    const result = await checkFor(true, true).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('sync: experimental gate open — shipper active');
  });
});
