import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { recentSelfHealActions } from '../../storage/migration-self-heal.js';
import { openProductionDbReadonly } from './shared.js';

// ─── Check: Migration self-heal (FEAT-495 item 1) ────────────────────────────

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Reads `migration_self_heal_log` (migration 045) — populated by
 * `selfHealMissingColumns` (src/storage/migration-self-heal.ts), which
 * migrate() runs on every boot. An empty log is the healthy, expected state
 * (`ok: true`): it means every ADD COLUMN this codebase has ever shipped is
 * actually present on this database, i.e. schema_version's bookkeeping has
 * never diverged from the real schema.
 *
 * Any row means self-heal actually fired at least once — a partially-applied
 * migration WAS found and repaired. That is not itself something still
 * broken (the repair already happened), so this still reports `ok: true`,
 * but flags a WARN-worded message when the most recent healing happened
 * within the last 24h: fresh evidence of an anomaly worth an operator's
 * attention (e.g. a crash mid-boot, a doctored schema_version row), as
 * opposed to old history from a since-fixed bug.
 */
export function checkMigrationSelfHeal(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Migration self-heal',
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'migration self-heal: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const recent = recentSelfHealActions(db, 20);

        if (recent.length === 0) {
          return { ok: true, message: 'migration self-heal: clean — no partially-applied migrations ever detected' };
        }

        const mostRecentHealedAt = recent[0]!.healedAt;
        const ageH = ((Date.now() - mostRecentHealedAt) / 3_600_000).toFixed(1);
        const isFresh = Date.now() - mostRecentHealedAt < RECENT_WINDOW_MS;
        const columnList = recent
          .slice(0, 5)
          .map(a => `${a.table}.${a.column} (${a.migrationFile})`)
          .join(', ');

        return {
          ok: true,
          message: isFresh
            ? `migration self-heal: healed ${recent.length} column(s) recently (most recent ${ageH}h ago) — ${columnList}. ` +
              `This database had a partially-applied migration; the missing column(s) were repaired automatically, but the ` +
              `underlying cause (an interrupted boot, or a hand-doctored schema_version row) is worth investigating.`
            : `migration self-heal: ${recent.length} column(s) healed historically (most recent ${ageH}h ago, no longer recent) — ${columnList}`,
        };
      } catch (err) {
        // The query itself failed — did NOT verify self-heal history is clean.
        return { ok: true, inconclusive: true, message: `migration self-heal check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
