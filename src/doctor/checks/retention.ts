import type { Check, CheckResult } from '../types.js';
import type { Config } from '../../config/config.js';
import { scanRetentionCandidates } from '../../storage/retention.js';

// ─── Check: Disk-artifact retention (FEAT-493, scaffolding) ─────────────────

/**
 * Informational row reporting the current `retention.mode` plus a LIVE
 * dry-run snapshot of what an `'all'`-tier retention pass would reclaim on
 * disk right now (scans `<dataDir>/artifacts/<kind>/` — see
 * src/storage/retention.ts's doc comment for why this is a plain directory
 * layout and not the day-one `artifacts` SQL table, which was dropped).
 * This is a live scan, not a persisted "last sweep" — this scaffolding slice
 * doesn't wire `runRetentionPass` onto the cleanup job's cadence yet; a
 * future slice that does can swap this live scan for a stored sweep-history
 * read without changing this check's shape or message contract.
 *
 * Never a WARN (`ok: true` always — mirrors `checkDurabilityGateMode`'s
 * precedent): retention reclaiming zero bytes is the expected state on any
 * install before a real artifact producer exists (nothing writes into
 * `<dataDir>/artifacts/` yet), not a misconfiguration to flag.
 */
export function checkRetention(dataDir: string, retentionConfig: Config['retention']): Check {
  return {
    name: 'Disk-artifact retention',
    // 'full' — scans a directory tree that grows with usage (more captured
    // heavy artifacts => more files to stat), same "corpus-scale, not
    // migration-bounded" reasoning as the entity-relations/memory-health
    // checks, even though today's scan legitimately finds nothing.
    tier: 'full',
    async run(): Promise<CheckResult> {
      if (retentionConfig.mode === 'off') {
        return { ok: true, message: 'retention: off (default — no disk-artifact reclaim pass runs)' };
      }

      try {
        const result = scanRetentionCandidates(dataDir, retentionConfig, 'all');

        if (result.candidates.length === 0) {
          return {
            ok: true,
            message:
              `retention: ${retentionConfig.mode} — 0 candidates on disk right now (0 bytes reclaimable; ` +
              'expected until a producer writes into `<dataDir>/artifacts/<kind>/`, e.g. FEAT-489)',
          };
        }

        const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
        const kinds = Object.entries(result.byKind)
          .map(([kind, stat]) => `${kind}: ${stat.count} (${mb(stat.bytes)}MB)`)
          .join(', ');
        return {
          ok: true,
          message:
            `retention: ${retentionConfig.mode} — ${result.candidates.length} candidate(s), ` +
            `${mb(result.totalBytes)}MB reclaimable [${kinds}]`,
        };
      } catch (err) {
        // The scan itself failed — did NOT verify retention is healthy (same
        // failure shape issue #200 was about: a canary that can report green
        // without having actually checked).
        return { ok: true, inconclusive: true, message: `retention check error (non-fatal): ${err}` };
      }
    },
  };
}
