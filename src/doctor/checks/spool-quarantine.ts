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
 *
 * Fast-follow (2026-07-13, Finding 3): the denominator N comes from
 * `SpoolStats.statsHealthy` now — a missing/corrupt `.stats.json` with real
 * spool activity already on disk reports `inconclusive: true` ("denominator
 * unavailable") instead of fabricating a green "0 of 0". The TTL RED branch
 * is evaluated first and is deliberately independent of `statsHealthy` — it
 * is computed straight from `readdirSync`/`mtimeMs`, so a lost stats file
 * can never silence a real "file outlived its TTL" alarm.
 */
export function checkSpoolQuarantine(dataDir: string): Check {
  return {
    name: 'Ingest spool quarantine',
    // fs.readdirSync over the quarantine dir (kept small by the TTL sweep)
    // + an O(1) stats-file read — never a DB query.
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      const qDir = spoolQuarantineDir(dataDir);
      let quarantined: string[];
      try {
        quarantined = existsSync(qDir) ? readdirSync(qDir).filter(n => n.endsWith('.json')) : [];
      } catch {
        quarantined = [];
      }
      const { totalSpooled, statsHealthy } = readSpoolStats(dataDir);
      const k = quarantined.length;

      // Oldest-age (and the TTL RED path below) is computed from
      // readdirSync/mtimeMs regardless of statsHealthy — Finding 3 fixes the
      // DENOMINATOR problem only. The TTL breach signal must never become
      // dependent on `.stats.json`, or a lost stats file would silence a
      // real "file outlived its TTL" alarm along with it.
      let oldestAgeMs = 0;
      for (const name of quarantined) {
        try {
          const age = Date.now() - statSync(join(qDir, name)).mtimeMs;
          if (age > oldestAgeMs) oldestAgeMs = age;
        } catch { /* vanished mid-check — skip */ }
      }
      const oldestDays = (oldestAgeMs / TWENTY_FOUR_HOURS_MS).toFixed(1);
      const ttlDays = (DEFAULT_QUARANTINE_TTL_MS / TWENTY_FOUR_HOURS_MS).toFixed(0);
      const denominator = statsHealthy ? String(totalSpooled) : 'unknown';

      if (k > 0 && oldestAgeMs > DEFAULT_QUARANTINE_TTL_MS) {
        return {
          ok: false,
          message: `ingest spool quarantine: ${k} of ${denominator} spooled envelopes quarantined, oldest is ${oldestDays}d old — exceeds the ${ttlDays}d TTL (the spool-drain prune sweep should have removed it)`,
          fix: 'Check the daemon logs for spool-drain errors — pruneExpiredQuarantine (src/ingest/spool.ts) runs every drain tick and should never let a file exceed the TTL.',
        };
      }

      if (!statsHealthy) {
        // Finding 3 (2026-07-13 fast-follow): `.stats.json` is missing or
        // corrupt AND there IS other content in the spool dir — so `k of 0`
        // would be a FABRICATED zero, not a real one (ADR-015 rule 6:
        // "0 of 0" must not render identically to "denominator unknown").
        // `inconclusive` (not `ok: false`) because a lost counter file is
        // not itself evidence of a quarantine problem — only the TTL branch
        // above is.
        return {
          ok: true,
          inconclusive: true,
          message: `ingest spool quarantine: denominator unavailable (.stats.json missing/corrupt with existing spool activity on disk) — ${k} currently quarantined, oldest ${k > 0 ? `${oldestDays}d old (within ${ttlDays}d TTL)` : 'n/a'}`,
        };
      }

      if (k === 0) {
        return { ok: true, message: `ingest spool quarantine: 0 of ${totalSpooled} spooled envelopes quarantined` };
      }

      return {
        ok: true,
        message: `ingest spool quarantine: ${k} of ${totalSpooled} spooled envelopes quarantined, oldest is ${oldestDays}d old (within ${ttlDays}d TTL)`,
      };
    },
  };
}
