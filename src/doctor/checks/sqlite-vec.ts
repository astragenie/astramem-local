import type { Check, CheckResult } from '../types.js';

// ─── Check: sqlite-vec extension loadable ─────────────────────────────────────

export function checkSqliteVec(): Check {
  return {
    name: 'sqlite-vec extension loadable',
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      try {
        const { default: Database } = await import('better-sqlite3-multiple-ciphers');
        const { load } = await import('sqlite-vec');
        const db = new Database(':memory:');
        load(db);
        const row = db.prepare("SELECT vec_version() AS v").get() as { v: string } | undefined;
        db.close();
        if (!row) return { ok: false, message: 'sqlite-vec loaded but vec_version() returned nothing' };
        return { ok: true, message: `sqlite-vec ${row.v} loaded` };
      } catch (err) {
        return {
          ok: false,
          message: `sqlite-vec not loadable: ${err}`,
          fix: 'npm install sqlite-vec (or reinstall native deps for this OS/arch)',
        };
      }
    },
  };
}
