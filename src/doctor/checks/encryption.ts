import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import { getOrCreateKey } from '../../storage/keystore.js';
import { defaultConfigDir } from '../../config/datadir.js';

// ─── Check: Encryption at rest (SEC-1/2/8) ────────────────────────────────────

export function checkEncryption(dataDir: string, enabled: boolean): Check {
  return {
    name: 'Encryption at rest',
    async run(): Promise<CheckResult> {
      if (!enabled) {
        return {
          ok: false,
          message: 'encryption: OFF — memory.sqlite is stored in PLAINTEXT (security.encryption.enabled=false)',
          fix: 'Set security.encryption.enabled=true (default) unless you have a deliberate reason to disable it.',
        };
      }

      try {
        const { source, identity } = getOrCreateKey(defaultConfigDir());
        const label = source === 'credential-store' ? 'keychain' : 'key-file';
        // AC-5: surface which credential-store identity (scoped vs legacy)
        // this daemon is actually reading its key from.
        const identitySuffix = identity ? `, identity: ${identity}` : '';

        const dbPath = join(dataDir, 'memory.sqlite');
        if (existsSync(dbPath)) {
          const header = readFileSync(dbPath).subarray(0, 16).toString('latin1');
          if (header.startsWith('SQLite format 3')) {
            return {
              ok: false,
              message: `encryption: on (${label}${identitySuffix}) but memory.sqlite header is still PLAINTEXT — auto-migration has not run yet`,
              fix: 'astramem-local serve  (auto-migrates a plaintext DB to encrypted form on next start)',
            };
          }
        }
        return { ok: true, message: `encryption: on (${label}${identitySuffix})` };
      } catch (err) {
        return { ok: false, message: `Encryption check error: ${err}` };
      }
    },
  };
}
