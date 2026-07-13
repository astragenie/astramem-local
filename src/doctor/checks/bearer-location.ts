import type { Check, CheckResult } from '../types.js';
import { readBearer, getBearerIdentity } from '../../storage/keystore.js';
import { readBearerFromSecretsFile } from '../../storage/bearer-keystore.js';
import { defaultConfigDir } from '../../config/datadir.js';

// ─── Check: Bearer token location (SEC-10) ────────────────────────────────────

export function checkBearerLocation(): Check {
  return {
    name: 'Bearer token location',
    tier: 'cheap', // OS credential store / secrets.env lookup, O(1)
    async run(): Promise<CheckResult> {
      try {
        const configDir = defaultConfigDir();
        if (readBearer(configDir)) {
          // AC-5: surface which credential-store identity (scoped vs
          // legacy) this daemon is actually reading its bearer from.
          const identity = getBearerIdentity(configDir);
          return { ok: true, message: `bearer: OS credential store (identity: ${identity})` };
        }
        if (readBearerFromSecretsFile()) {
          return {
            ok: false,
            message: 'bearer: secrets.env (plaintext fallback) — OS credential store unavailable or not yet migrated',
            fix: 'Run "astramem-local token rotate" to migrate the bearer into the OS credential store.',
          };
        }
        return {
          ok: false,
          message: 'bearer: missing — no MEMORY_BEARER in credential store or secrets.env',
          fix: 'Run "astramem-local init" or "astramem-local token rotate" to generate one.',
        };
      } catch (err) {
        return { ok: false, message: `Bearer location check error: ${err}` };
      }
    },
  };
}
