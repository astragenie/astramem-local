import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { hasPassingEvalEvidence, RECORDED_EVAL_EVIDENCE } from '../../src/eval/eval-evidence.js';

/**
 * ADR-014 / FEAT-428 hard gate.
 *
 * Rule (ADR-014 Decision 2): no shipped config may carry a nonzero optional
 * additive fusion weight (zeta, eta — epsilon is the one exempt component,
 * see below) unless a passing ADR-005-harness eval-evidence entry licenses
 * it in the checked-in manifest (`src/eval/eval-evidence.ts`,
 * `RECORDED_EVAL_EVIDENCE`).
 *
 * This is deliberately independent of `applyFusionGovernance`'s runtime
 * enforcement (src/config/config.ts), which today only actively re-checks
 * `eta` against the evidence manifest (`GatedFusionComponent = 'eta'`) — a
 * future change that ships `zeta > 0` in `defaultConfig()` would clamp
 * against the component ceiling but would NOT be forced back to 0 by that
 * runtime gate, since zeta isn't (yet) a member of `GatedFusionComponent`.
 * This test closes that gap at the "shipped config" boundary directly,
 * without touching production code: it inspects `defaultConfig().search`
 * and the evidence manifest literally, so it fails immediately if a future
 * PR ships a nonzero zeta (or a nonzero eta unbacked by evidence) — forcing
 * that PR to either add a passing evidence entry (and update this test to
 * assert on it) or revert the weight. See ADR-014 "Known gap" for the
 * follow-up recommendation to extend `GatedFusionComponent` itself.
 */
describe('FEAT-428 hard gate: shipped default config carries no unevidenced fusion weight', () => {
  const shipped = defaultConfig().search;

  it('zeta ships at 0 — no evidence entry exists for it in the manifest', () => {
    // `GatedFusionComponent` (src/eval/eval-evidence.ts) is 'eta'-only today,
    // so there is no typed way to record zeta evidence yet — the only
    // defense against an accidental nonzero zeta default is this literal
    // assertion. If this ever needs to fail on purpose (zeta earns a
    // deliberate nonzero default), that PR must first extend
    // `GatedFusionComponent` to include 'zeta', add a passing entry to
    // `RECORDED_EVAL_EVIDENCE`, and update this test to check it the same
    // way the eta case below does.
    expect(shipped.zeta).toBe(0);
  });

  it('eta ships at 0 unless a passing recorded eval-evidence entry licenses it', () => {
    if (shipped.eta > 0) {
      expect(hasPassingEvalEvidence('eta')).toBe(true);
    } else {
      expect(shipped.eta).toBe(0);
    }
  });

  it('epsilon is the one exempt component — its nonzero default is the evidence baseline every retrieval-eval.test.ts run already exercises, not an ungated bypass', () => {
    expect(shipped.epsilon).toBeGreaterThan(0);
  });

  it('the base signals (alpha/beta/gamma/delta) are not subject to this gate at all — only optional additive bonus terms are governed', () => {
    expect(shipped.alpha).toBeGreaterThan(0);
    expect(shipped.beta).toBeGreaterThan(0);
  });
});
