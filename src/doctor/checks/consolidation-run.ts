import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { latestConsolidationRun } from '../../storage/consolidation-run-log.js';
import { openProductionDbReadonly } from './shared.js';

// ─── Check: Consolidation group coverage (P2.1 stabilization) ────────────────

/**
 * P2.1 stabilization / reviewer MEDIUM finding (20260715T1640Z
 * review-stabilization-plan-architect-reviewer.md): the binary
 * `maxGroupSize` group-skip in `'full'` `candidateSelection` mode used to be
 * silent — `ConsolidateSummary.groupsSkipped` was populated by
 * `runConsolidation` (src/consolidate/consolidate.ts) but read nowhere (no
 * doctor/health/log surface), so an oversized (repo,type) group got ZERO
 * consolidation coverage forever with no operator-visible signal.
 *
 * This check reads `consolidation_run_log` (migration 050,
 * src/storage/consolidation-run-log.ts) — written on every real
 * `runConsolidation()` call — and flags RED when the most recent run
 * skipped at least one group. Switching `consolidation.candidateSelection`
 * to `'knn'` removes the skip entirely: oversized groups get scanned via
 * k-NN (bounded per-atom cost) instead of dropped.
 */
export function checkConsolidationRunCoverage(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Consolidation group coverage',
    // latestConsolidationRun() rides idx_consolidation_run_log_created
    // (migration 050) — a single most-recent-row lookup, not a scan.
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'consolidation group coverage: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const latest = latestConsolidationRun(db);

        if (!latest) {
          return { ok: true, message: 'consolidation group coverage: consolidation has never run yet' };
        }

        const ageH = ((Date.now() - latest.createdAt) / 3_600_000).toFixed(1);

        if (latest.groupsSkippedCount > 0) {
          return {
            ok: false,
            message:
              `consolidation group coverage: last run ${ageH}h ago (candidateSelection=` +
              `${latest.candidateSelection}) skipped ${latest.groupsSkippedCount} group(s) totalling ` +
              `${latest.groupsSkippedAtoms} atoms — these groups get ZERO consolidation coverage until ` +
              'reprocessed.',
            fix:
              "Set consolidation.candidateSelection: 'knn' (P2.1) to process oversized groups via k-NN " +
              'instead of skipping them, or raise consolidation.maxGroupSize if the group is only ' +
              'moderately over.',
          };
        }

        return {
          ok: true,
          message:
            `consolidation group coverage: last run ${ageH}h ago (candidateSelection=` +
            `${latest.candidateSelection}) — ${latest.groupsScanned} group(s) scanned, 0 skipped`,
        };
      } catch (err) {
        // The query itself failed — did NOT verify coverage is healthy.
        return { ok: true, inconclusive: true, message: `consolidation group coverage check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
