import type { Check, CheckResult } from '../types.js';
import type { DistillCostCapConfig } from '../../distill/cost-cap.js';

// ─── Check: Distill cost cap (opt-in compact()+extract() call/wall-clock cap) ─

/**
 * Informational-only row (`ok: true` always — mirrors `checkExtractProfile`/
 * `checkDurabilityGateMode`'s precedent: a deliberate, disclosed config
 * choice is never itself a WARN). Its job is making the cap's current
 * on/off state and configured limits visible on every `doctor` run, not
 * buried in a config.yaml comment — the same posture `checkConsolidationJudgeTelemetry`
 * takes for the sibling contradiction-judge cap.
 *
 * `disabled` is the shipped beta default (`config.distill.costCap.enabled:
 * false`) — reported explicitly rather than silently, so an operator who
 * later hits a slow/metered provider knows this guard exists and is off.
 */
export function checkDistillCostCap(costCap: DistillCostCapConfig | undefined): Check {
  return {
    name: 'Distill cost cap',
    tier: 'cheap', // config-only, no I/O
    async run(): Promise<CheckResult> {
      if (!costCap || !costCap.enabled) {
        return { ok: true, message: 'distill cost cap: disabled (beta default) — see config.distill.costCap' };
      }

      const parts: string[] = [];
      if (typeof costCap.maxCallsPerJob === 'number') parts.push(`maxCallsPerJob=${costCap.maxCallsPerJob}`);
      if (typeof costCap.maxWallClockMs === 'number') parts.push(`maxWallClockMs=${costCap.maxWallClockMs}`);
      const limits = parts.length > 0 ? parts.join(', ') : 'no limits configured — enabled with no effect';

      return { ok: true, message: `distill cost cap: enabled (${limits})` };
    },
  };
}
