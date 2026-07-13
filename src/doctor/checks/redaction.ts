import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { openProductionDbReadonly, SEVEN_DAYS_MS } from './shared.js';

// ─── Check: Secret redaction (SEC-6/8) ────────────────────────────────────────

export function checkRedaction(dataDir: string, enabled: boolean, encryptionEnabled: boolean): Check {
  return {
    name: 'Secret redaction',
    // GROUP BY over a created_at >= ? window rides idx_redaction_log_created
    // (migration 005) — bounded by the 7d window, not table size.
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      if (!enabled) {
        return {
          ok: false,
          message: 'redaction: OFF — secrets are NOT scrubbed before persistence (security.redaction.enabled=false)',
          fix: 'Set security.redaction.enabled=true (default) unless you have a deliberate reason to disable it.',
        };
      }

      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        if (!existsSync(dbPath)) {
          return { ok: true, message: 'redaction: on (no DB yet — 0 secrets redacted)' };
        }
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const since = Date.now() - SEVEN_DAYS_MS;
        const rows = db
          .prepare('SELECT type, SUM(count) AS n FROM redaction_log WHERE created_at >= ? GROUP BY type ORDER BY n DESC')
          .all(since) as { type: string; n: number }[];

        const total = rows.reduce((sum, r) => sum + r.n, 0);
        if (total === 0) {
          return { ok: true, message: 'redaction: on — 0 secrets redacted in last 7d' };
        }
        const breakdown = rows.map(r => `${r.n} ${r.type}`).join(', ');
        return { ok: true, message: `redaction: on — ${total} secrets redacted (${breakdown}) in last 7d` };
      } catch (err) {
        return { ok: false, message: `Redaction check error: ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
