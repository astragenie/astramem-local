/**
 * tests/doctor/budget-cap-codex-blind-check.test.ts
 *
 * FEAT-479 AC-15 (SLICE-436): codex-subscription always reports
 * `usage.usd: 0` (ChatGPT subscription quota has no per-token price), so a
 * configured daily budget cap silently never applies while either
 * llm.compaction or llm.extraction is pinned to codex-subscription. This is
 * a genuine, every-run WARN while that combination holds — same posture as
 * tests/doctor/dev-no-auth-check.test.ts / proxy-capture-warn-check.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { getChecks } from '../../src/doctor/checks.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

const CHECK_NAME = 'Budget cap vs codex-subscription';

describe('doctor "Budget cap vs codex-subscription" WARN', () => {
  it('defaults to ok:true when codexSubscriptionInUse is omitted', async () => {
    const result = await findCheck(getChecks({}), CHECK_NAME).run();
    expect(result.ok).toBe(true);
  });

  it('codexSubscriptionInUse: false — ok:true regardless of budget cap', async () => {
    const result = await findCheck(
      getChecks({ codexSubscriptionInUse: false, dailyBudgetUsd: 10 }),
      CHECK_NAME,
    ).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('applies normally');
  });

  it('codexSubscriptionInUse: true + a configured cap — genuine WARN (ok:false)', async () => {
    const result = await findCheck(
      getChecks({ codexSubscriptionInUse: true, dailyBudgetUsd: 10 }),
      CHECK_NAME,
    ).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('$10.00');
    expect(result.message.toLowerCase()).toContain('usage.usd: 0');
    expect(result.message.toLowerCase()).toContain('does not meter');
    expect(result.fix).toBeDefined();
  });

  it('codexSubscriptionInUse: true but dailyBudgetUsd <= 0 (no cap configured) — ok:true, no false alarm', async () => {
    const result = await findCheck(
      getChecks({ codexSubscriptionInUse: true, dailyBudgetUsd: 0 }),
      CHECK_NAME,
    ).run();
    expect(result.ok).toBe(true);
  });
});
