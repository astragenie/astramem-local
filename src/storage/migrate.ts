import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';
import { SCHEMA_VERSION } from '../server/lib/wire-meta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

export function migrate(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_version').all() as {version: number}[])
      .map(r => r.version)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const f of files) {
    const versionStr = f.split('-')[0];
    const version = parseInt(versionStr ?? '', 10);
    if (Number.isNaN(version)) throw new Error(`bad migration name: ${f}`);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    });
    tx();
  }

  // Boot-time schema-version drift guard: the SCHEMA_VERSION constant in
  // wire-meta.ts MUST match the highest migration applied to the DB.
  // If they diverge a migration was added without bumping the constant (or
  // vice-versa). Fail loudly rather than silently serve wrong metadata.
  const dbMaxRow = db
    .prepare('SELECT MAX(version) AS max_version FROM schema_version')
    .get() as { max_version: number | null };
  const dbMax = dbMaxRow.max_version ?? 0;
  if (dbMax !== SCHEMA_VERSION) {
    throw new Error(
      `Schema-version constant drift: wire-meta says ${SCHEMA_VERSION}, DB says ${dbMax}. ` +
      `Bump wire-meta.SCHEMA_VERSION when adding a migration.`,
    );
  }
}
