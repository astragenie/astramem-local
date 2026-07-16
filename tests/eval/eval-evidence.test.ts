import { describe, it, expect } from 'vitest';
import {
  hasPassingEvalEvidence,
  RECORDED_EVAL_EVIDENCE,
  RECALL_FLOOR,
  NDCG_FLOOR,
  type FusionEvalEvidence,
} from '../../src/eval/eval-evidence.js';

// FEAT-428: the recorded eval-evidence table gating `search.eta > 0` (see
// applyFusionGovernance in src/config/config.ts). These tests exercise the
// lookup logic in isolation from config wiring.
describe('eval-evidence', () => {
  it('the shipped evidence table has no passing entry for eta yet (FEAT-428 as-shipped state)', () => {
    expect(hasPassingEvalEvidence('eta')).toBe(false);
    expect(RECORDED_EVAL_EVIDENCE.find(e => e.component === 'eta')).toBeUndefined();
  });

  it('a recorded entry that clears both floors counts as passing evidence', () => {
    const evidence: FusionEvalEvidence[] = [
      { component: 'eta', recordedAt: '2026-07-06', meanRecall: 0.92, meanNdcg: 0.75, evidenceRef: 'PR#999' },
    ];
    expect(hasPassingEvalEvidence('eta', evidence)).toBe(true);
  });

  it('a recorded entry that regresses either floor does NOT count as passing evidence', () => {
    const belowRecall: FusionEvalEvidence[] = [
      { component: 'eta', recordedAt: '2026-07-06', meanRecall: RECALL_FLOOR - 0.01, meanNdcg: 0.9, evidenceRef: 'PR#999' },
    ];
    const belowNdcg: FusionEvalEvidence[] = [
      { component: 'eta', recordedAt: '2026-07-06', meanRecall: 0.95, meanNdcg: NDCG_FLOOR - 0.01, evidenceRef: 'PR#999' },
    ];
    expect(hasPassingEvalEvidence('eta', belowRecall)).toBe(false);
    expect(hasPassingEvalEvidence('eta', belowNdcg)).toBe(false);
  });

  it('an entry exactly at both floors counts as passing (inclusive bound)', () => {
    const atFloor: FusionEvalEvidence[] = [
      { component: 'eta', recordedAt: '2026-07-06', meanRecall: RECALL_FLOOR, meanNdcg: NDCG_FLOOR, evidenceRef: 'PR#999' },
    ];
    expect(hasPassingEvalEvidence('eta', atFloor)).toBe(true);
  });

  it('an empty evidence list never passes', () => {
    expect(hasPassingEvalEvidence('eta', [])).toBe(false);
  });

  // issue #352B: theta (supersession/correction freshness bonus) is gated
  // the same way eta is — mirrors the eta-specific assertions above.
  it('the shipped evidence table has no passing entry for theta yet (issue #352B as-shipped state)', () => {
    expect(hasPassingEvalEvidence('theta')).toBe(false);
    expect(RECORDED_EVAL_EVIDENCE.find(e => e.component === 'theta')).toBeUndefined();
  });

  it('a recorded theta entry that clears both floors counts as passing evidence', () => {
    const evidence: FusionEvalEvidence[] = [
      { component: 'theta', recordedAt: '2026-07-16', meanRecall: 0.92, meanNdcg: 0.75, evidenceRef: 'PR#999' },
    ];
    expect(hasPassingEvalEvidence('theta', evidence)).toBe(true);
  });
});
