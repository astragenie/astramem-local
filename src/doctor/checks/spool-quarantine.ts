import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import { spoolQuarantineDir, readSpoolStats, DEFAULT_QUARANTINE_TTL_MS } from '../../ingest/spool.js';
import { TWENTY_FOUR_HOURS_MS } from './shared.js';

// ─── Check: Ingest spool quarantine (Wave A slice A3) ────────────────────────

/**
 * ADR-015 rule 6 ("state the denominator"): reports K (currently
 * quarantined) of N (cumulative envelopes ever spooled, `SpoolStats.
 * totalSpooled` — src/ingest/spool.ts), not a bare count. A canary that can
 * only ever go green is decoration (same doc, same rule) — this one goes RED
 * when a quarantined file has outlived `DEFAULT_QUARANTINE_TTL_MS`, which
 * means the TTL sweep (`pruneExpiredQuarantine`, run once per spool-drain
 * tick) failed to remove it — a real, actionable signal, not a restated
 * config value. Content in `.quarantine/` is already redacted at spool-write
 * time (src/ingest/spool.ts `redactSpoolEnvelope`) regardless of what this
 * check finds; this check is about retention hygiene, not secret exposure.
 */
export function checkSpoolQuarantine(dataDir: string): Check {
  return {
    name: 'Ingest spool quarantine',
    async run(): Promise<CheckResult> {
      const qDir = spoolQuarantineDir(dataDir);
      let quarantined: string[];
      try {
        quarantined = existsSync(qDir) ? readdirSync(qDir).filter(n => n.endsWith('.json')) : [];
      } catch {
        quarantined = [];
      }
      const { totalSpooled } = readSpoolStats(dataDir);
      const k = quarantined.length;

      if (k === 0) {
        return { ok: true, message: `ingest spool quarantine: 0 of ${totalSpooled} spooled envelopes quarantined` };
      }

      let oldestAgeMs = 0;
      for (const name of quarantined) {
        try {
          const age = Date.now() - statSync(join(qDir, name)).mtimeMs;
          if (age > oldestAgeMs) oldestAgeMs = age;
        } catch { /* vanished mid-check — skip */ }
      }
      const oldestDays = (oldestAgeMs / TWENTY_FOUR_HOURS_MS).toFixed(1);
      const ttlDays = (DEFAULT_QUARANTINE_TTL_MS / TWENTY_FOUR_HOURS_MS).toFixed(0);

      if (oldestAgeMs > DEFAULT_QUARANTINE_TTL_MS) {
        return {
          ok: false,
          message: `ingest spool quarantine: ${k} of ${totalSpooled} spooled envelopes quarantined, oldest is ${oldestDays}d old — exceeds the ${ttlDays}d TTL (the spool-drain prune sweep should have removed it)`,
          fix: 'Check the daemon logs for spool-drain errors — pruneExpiredQuarantine (src/ingest/spool.ts) runs every drain tick and should never let a file exceed the TTL.',
        };
      }

      return {
        ok: true,
        message: `ingest spool quarantine: ${k} of ${totalSpooled} spooled envelopes quarantined, oldest is ${oldestDays}d old (within ${ttlDays}d TTL)`,
      };
    },
  };
}
