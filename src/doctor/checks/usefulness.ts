import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { usefulnessRate, usefulnessByType } from '../../storage/usefulness.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS } from './shared.js';

// ─── Check: Recall usefulness (ADR-010) ───────────────────────────────────────

export function checkUsefulness(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Recall usefulness',
    // usefulnessRate()/usefulnessByType() ride migration 019's partial
    // covering indexes (idx_memory_events_usefulness_served/used) — bounded
    // by the 7d window via an index range scan, not a memory_events scan.
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'recall usefulness: no DB yet (0 served, 0 used)' };
        }
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;
        const overall = usefulnessRate(db, { sinceMs: since });
        const byType = usefulnessByType(db, { sinceMs: since });

        const rateStr = overall.rate === null ? 'n/a' : `${(overall.rate * 100).toFixed(1)}%`;
        const breakdown = byType.length > 0
          ? ' — ' + byType.map(t => `${t.type}: ${t.rate === null ? 'n/a' : `${(t.rate * 100).toFixed(1)}%`} (${t.used}/${t.served})`).join(', ')
          : '';
        return {
          ok: true,
          message: `recall usefulness (7d): ${rateStr} (${overall.used}/${overall.served} atoms used/served)${breakdown}`,
        };
      } catch (err) {
        // The query itself failed — this did NOT verify recall usefulness is
        // healthy, so it must not render/count the same as a check that did.
        return { ok: true, inconclusive: true, message: `Recall usefulness check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
