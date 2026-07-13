import type { Check, CheckResult } from '../types.js';
import { readSyncToken, getSyncTokenIdentity } from '../../storage/keystore.js';
import { readSyncSettings } from '../../config/sync-settings.js';
import { defaultConfigDir } from '../../config/datadir.js';

// ─── Check: Sync device token location (FEAT-472) ─────────────────────────────

export function checkSyncTokenLocation(): Check {
  return {
    name: 'Sync device token location',
    async run(): Promise<CheckResult> {
      try {
        const configDir = defaultConfigDir();
        // sync.json (config/sync-settings.ts) is authoritative for whether
        // sync is paired at all — a never-paired install has no device
        // token to report on, and that is not a doctor warning.
        const settings = readSyncSettings(configDir);
        if (!settings?.enabled) {
          return { ok: true, message: 'sync device token: sync not paired (run "astramem-local pair <code>" to enable cloud sync)' };
        }
        if (process.env.ASTRA_SYNC_TOKEN) {
          return { ok: true, message: 'sync device token: ASTRA_SYNC_TOKEN env override active' };
        }
        if (readSyncToken(configDir)) {
          // Surfaces which credential-store identity (scoped vs legacy) this
          // daemon is actually reading its sync device token from — same
          // AC-5-shaped row FEAT-466 added for the bearer.
          const identity = getSyncTokenIdentity(configDir);
          return { ok: true, message: `sync device token: OS credential store (identity: ${identity})` };
        }
        return {
          ok: false,
          message: 'sync device token: missing — sync.json is paired but no device token is stored',
          fix: 'Run "astramem-local pair <code>" again to re-store the device token, or set ASTRA_SYNC_TOKEN.',
        };
      } catch (err) {
        return { ok: false, message: `Sync device token check error: ${err}` };
      }
    },
  };
}
