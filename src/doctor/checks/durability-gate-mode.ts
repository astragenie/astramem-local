import type { Check, CheckResult } from '../types.js';
import type { DurabilityGateMode } from '../../distill/durability-gate.js';

// ─── Check: Durability gate mode (FEAT-441 AC-8) ─────────────────────────────

/**
 * Informational row reporting the current `distill.durabilityGate` mode —
 * never a WARN in any mode ('off'/'lenient'/'strict' all report ok: true).
 * 'strict' is opt-in (not the shipped default), so surfacing it here is
 * about operational visibility, not flagging a misconfiguration.
 */
export function checkDurabilityGateMode(mode: DurabilityGateMode): Check {
  return {
    name: 'Distill durability gate',
    async run(): Promise<CheckResult> {
      if (mode === 'off') {
        return { ok: true, message: 'durability gate: off (default — no atoms are gated at persist time)' };
      }
      return { ok: true, message: `durability gate: ${mode} (see FEAT-441 / src/distill/durability-gate.ts)` };
    },
  };
}
