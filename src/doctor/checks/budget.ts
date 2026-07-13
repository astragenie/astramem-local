import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { openProductionDbReadonly } from './shared.js';

// ─── Check: Today's budget vs cap ────────────────────────────────────────────

export function checkBudget(dataDir: string, dailyBudgetUsd: number, encryptionEnabled: boolean): Check {
  return {
    name: 'Daily budget vs cap',
    async run(): Promise<CheckResult> {
      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'budget check skipped (no DB yet)' };
        }
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const day = new Date().toISOString().slice(0, 10);
        const row = db.prepare('SELECT usd_total, calls FROM budget_spend WHERE day = ?').get(day) as
          | { usd_total: number; calls: number }
          | undefined;

        const usd = row?.usd_total ?? 0;
        const calls = row?.calls ?? 0;
        const pct = dailyBudgetUsd > 0 ? ((usd / dailyBudgetUsd) * 100).toFixed(1) : '0.0';

        if (usd >= dailyBudgetUsd && dailyBudgetUsd > 0) {
          return {
            ok: false,
            message: `Budget cap reached: $${usd.toFixed(4)} / $${dailyBudgetUsd.toFixed(2)} (${calls} calls) — distillation paused`,
            fix: 'astramem-local budget --reset  to override for today',
          };
        }

        return {
          ok: true,
          message: `Budget: $${usd.toFixed(4)} / $${dailyBudgetUsd.toFixed(2)} (${pct}%, ${calls} calls today)`,
        };
      } catch (err) {
        return { ok: false, message: `Budget check error: ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
