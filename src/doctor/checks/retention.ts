import type { Check, CheckResult } from '../types.js';
import type { Config } from '../../config/config.js';
import { readSweepStats, scanRetentionCandidates } from '../../storage/retention.js';

// ─── Check: Disk-artifact retention (FEAT-493) ──────────────────────────────

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

/**
 * Informational row reporting the current `retention.mode`/`tier`, a LIVE
 * dry-run snapshot of what an `'all'`-tier pass would reclaim on disk right
 * now (scans `<dataDir>/artifacts/<kind>/` — see src/storage/retention.ts's
 * doc comment for why this is a plain directory layout and not the day-one
 * `artifacts` SQL table, which was dropped), AND the persisted result of the
 * last real sweep the cleanup-job cadence ran (`readSweepStats` —
 * src/pipeline/handlers/cleanup.ts wires `runRetentionPass` onto that
 * cadence). The live scan and the persisted sweep can disagree (e.g. new
 * heavy artifacts written since the last sweep) — that's expected, not a bug.
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
        const lastSweep = readSweepStats(dataDir);
        const lastSweepMsg = lastSweep
          ? ` | last sweep (${lastSweep.mode}/${lastSweep.tier}) at ${new Date(lastSweep.scannedAt).toISOString()}: ` +
            `${lastSweep.deletedCount} deleted (${mb(lastSweep.deletedBytes)}MB freed)` +
            (lastSweep.errorCount > 0 ? `, ${lastSweep.errorCount} error(s)` : '')
          : ' | no sweep has run yet';

        if (result.candidates.length === 0) {
          return {
            ok: true,
            message:
              `retention: ${retentionConfig.mode}/${retentionConfig.tier} — 0 candidates on disk right now ` +
              '(0 bytes reclaimable; expected until a producer writes into `<dataDir>/artifacts/<kind>/`, ' +
              `e.g. FEAT-489)${lastSweepMsg}`,
          };
        }

        const kinds = Object.entries(result.byKind)
          .map(([kind, stat]) => `${kind}: ${stat.count} (${mb(stat.bytes)}MB)`)
          .join(', ');
        return {
          ok: true,
          message:
            `retention: ${retentionConfig.mode}/${retentionConfig.tier} — ${result.candidates.length} ` +
            `candidate(s), ${mb(result.totalBytes)}MB reclaimable [${kinds}]${lastSweepMsg}`,
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
