import type { Check, CheckResult } from '../types.js';
import type { EmbedProvider } from '../../contracts/embed.js';
import { embedProbe } from '../probes/embed-probe.js';

// ─── Check: Embed probe (real embed call + dim assert) ────────────────────────

export function checkEmbed(provider: EmbedProvider): Check {
  return {
    name: `Embed probe (${provider.dim}-dim)`,
    async run(): Promise<CheckResult> {
      return embedProbe(provider);
    },
  };
}
