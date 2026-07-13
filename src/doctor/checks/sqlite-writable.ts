import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { openProductionDbReadonly } from './shared.js';

// ─── Check: SQLite writable + WAL ─────────────────────────────────────────────

export function checkSqliteWritable(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'SQLite writable + WAL',
    async run(): Promise<CheckResult> {
      // Try to write a probe file in the datadir
      const probePath = join(dataDir, `.doctor-probe-${randomUUID()}`);
      try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(probePath, 'probe', 'utf8');
        unlinkSync(probePath);
      } catch (err) {
        return {
          ok: false,
          message: `datadir not writable: ${dataDir}`,
          fix: `chmod u+w "${dataDir}" or set ASTRA_MEMORY_DATADIR to a writable path`,
        };
      }

      // Check WAL by opening a test DB — key-aware so this doesn't false-fail
      // on an encrypted production DB (SEC-8).
      let db: DB | undefined;
      try {
        const dbPath = join(dataDir, 'memory.sqlite');
        // DB may not exist yet — only check WAL if it does
        if (existsSync(dbPath)) {
          db = await openProductionDbReadonly(dbPath, encryptionEnabled);
          const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
          if (row.journal_mode !== 'wal') {
            return {
              ok: false,
              message: `journal_mode is '${row.journal_mode}', expected 'wal'`,
              fix: 'Run: astramem-local serve (will apply WAL pragma on open)',
            };
          }
        }
        return { ok: true, message: `datadir writable, WAL ok (${dataDir})` };
      } catch (err) {
        return { ok: false, message: `SQLite probe error: ${err}` };
      } finally {
        // Silent-error audit (2026-07-13): db.close() previously sat inline
        // after the query — unreachable if the query itself threw, leaking
        // the connection (and, on Windows, the underlying file handle) on
        // every error path. A finally block closes it exactly once
        // regardless of which path was taken.
        db?.close();
      }
    },
  };
}
