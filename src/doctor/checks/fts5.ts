import type { Check, CheckResult } from '../types.js';

// ─── Check: FTS5 available ─────────────────────────────────────────────────────

export function checkFts5(): Check {
  return {
    name: 'FTS5 available',
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      try {
        const { default: Database } = await import('better-sqlite3-multiple-ciphers');
        const db = new Database(':memory:');
        db.exec(`CREATE VIRTUAL TABLE _fts5_probe USING fts5(content)`);
        db.exec(`DROP TABLE _fts5_probe`);
        db.close();
        return { ok: true, message: 'FTS5 available' };
      } catch (err) {
        return {
          ok: false,
          message: `FTS5 not available: ${err}`,
          fix: 'Ensure better-sqlite3-multiple-ciphers was compiled with FTS5 (default in prebuilt binaries)',
        };
      }
    },
  };
}
