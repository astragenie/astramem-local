import type { Check, CheckResult } from '../types.js';
import { pluginCoexistenceProbe } from '../probes/plugin-coexistence.js';

// ─── Check: Plugin coexistence ────────────────────────────────────────────────

export function checkPluginCoexistence(port: number): Check {
  return {
    name: 'Plugin config coexistence',
    async run(): Promise<CheckResult> {
      return pluginCoexistenceProbe(port);
    },
  };
}
