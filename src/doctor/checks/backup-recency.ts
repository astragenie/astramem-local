import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import { TWENTY_FOUR_HOURS_MS } from './shared.js';

// ─── Check: Backup recency ─────────────────────────────────────────────────────

export function checkBackupRecency(backupsDir: string): Check {
  return {
    name: 'Backup recency',
    tier: 'cheap', // fs.readdirSync + stat over a rotated/bounded backups dir
    async run(): Promise<CheckResult> {
      if (!existsSync(backupsDir)) {
        return {
          ok: false,
          message: `No backups directory found at ${backupsDir}`,
          fix: 'astramem-local backup  to create the first snapshot',
        };
      }

      let entries: string[];
      try {
        entries = readdirSync(backupsDir).filter(n => /^memory-.*\.sqlite$/.test(n));
      } catch {
        return { ok: false, message: `Cannot read backups directory: ${backupsDir}` };
      }

      if (entries.length === 0) {
        return {
          ok: false,
          message: 'No backup snapshots found',
          fix: 'astramem-local backup  to create the first snapshot',
        };
      }

      // Find the most-recently modified backup
      let newestMtime = 0;
      for (const name of entries) {
        try {
          const mtime = statSync(join(backupsDir, name)).mtimeMs;
          if (mtime > newestMtime) newestMtime = mtime;
        } catch { /* skip files that disappeared */ }
      }

      const ageMs = Date.now() - newestMtime;
      const ageH = (ageMs / 3_600_000).toFixed(1);

      if (ageMs > TWENTY_FOUR_HOURS_MS) {
        return {
          ok: false,
          message: `Newest backup is ${ageH}h old (> 24h)`,
          fix: 'astramem-local backup  or enable nightly timer: astramem-local service install --with-backup-timer',
        };
      }

      return { ok: true, message: `Newest backup is ${ageH}h old (within 24h)` };
    },
  };
}
