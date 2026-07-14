import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import type { Check, CheckResult } from '../types.js';
import { defaultConfigDir, legacyConfigDir } from '../../config/datadir.js';

// ─── Check: Config dir divergence (Windows) ───────────────────────────────────

/**
 * Warns when both the legacy (%APPDATA%\AstraMemory) and canonical
 * (%APPDATA%\Astramem) config dirs are present simultaneously. This indicates
 * a partially-migrated install and can cause bearer mismatches with the plugin.
 *
 * Also warns when the canonical dir's bearer differs from the plugin dir's
 * bearer (legacy dir = proxy for plugin if migration hasn't run yet), which is
 * the exact root cause of the v0.2.2 401 bug.
 */
export function checkConfigDirDivergence(): Check {
  return {
    name: 'Config dir divergence (Windows)',
    tier: 'cheap', // a handful of fs.existsSync/readFileSync calls
    async run(): Promise<CheckResult> {
      // Only meaningful on Windows; canonical and legacy are identical elsewhere.
      if (platform() !== 'win32') {
        return { ok: true, message: 'Config dir divergence check: N/A (non-Windows)' };
      }

      const canonical = defaultConfigDir();
      const legacy = legacyConfigDir();

      const canonicalExists = existsSync(canonical);
      const legacyExists = existsSync(legacy);

      // Both dirs present → migration hasn't cleaned up yet.
      if (canonicalExists && legacyExists) {
        // Additionally check whether the bearers differ.
        let bearerMismatch = false;
        let bearerDetail = '';
        try {
          const readBearer = (dir: string): string | null => {
            const p = join(dir, 'secrets.env');
            if (!existsSync(p)) return null;
            const line = readFileSync(p, 'utf8')
              .split('\n')
              .find(l => l.startsWith('MEMORY_BEARER='));
            if (!line) return null;
            return line.slice('MEMORY_BEARER='.length).trim() || null;
          };
          const canonicalBearer = readBearer(canonical);
          const legacyBearer = readBearer(legacy);
          if (
            canonicalBearer !== null &&
            legacyBearer !== null &&
            canonicalBearer !== legacyBearer
          ) {
            bearerMismatch = true;
            bearerDetail =
              ' Bearer mismatch detected — plugin will send the legacy bearer and get 401.';
          }
        } catch { /* non-fatal */ }

        return {
          ok: false,
          message:
            `Two config dirs present: "${legacy}" (legacy <=0.2.2) and "${canonical}" (canonical).` +
            bearerDetail,
          fix:
            bearerMismatch
              ? `Run "astramem-local init" in the canonical dir to unify bearers, ` +
                `then delete "${legacy}" manually.`
              : `Delete "${legacy}" after verifying all data has migrated to "${canonical}".`,
        };
      }

      // Only canonical → healthy.
      if (canonicalExists && !legacyExists) {
        return { ok: true, message: `Config dir canonical (${canonical})` };
      }

      // Only legacy → migration hasn't run yet (daemon not booted since upgrade).
      if (!canonicalExists && legacyExists) {
        return {
          ok: false,
          message:
            `Legacy config dir found at "${legacy}" but canonical "${canonical}" is absent. ` +
            `Migration will run on next "astramem-local serve".`,
          fix: 'Run "astramem-local serve" once to auto-migrate.',
        };
      }

      // Neither exists → fresh install.
      return { ok: true, message: 'Config dir: fresh install (no dirs yet)' };
    },
  };
}
