import type { Check, CheckResult } from '../types.js';
import { pluginCoexistenceProbe } from '../probes/plugin-coexistence.js';

// ─── Check: Plugin coexistence ────────────────────────────────────────────────

export function checkPluginCoexistence(port: number): Check {
  return {
    name: 'Plugin config coexistence',
    tier: 'cheap', // env var read + a bounded set of fs.existsSync/readFileSync checks
    async run(): Promise<CheckResult> {
      return pluginCoexistenceProbe(port);
    },
  };
}
