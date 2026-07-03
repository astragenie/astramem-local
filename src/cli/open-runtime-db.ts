/**
 * open-runtime-db.ts — one way for CLI one-shots to open the production DB.
 *
 * queue/budget/rebuild predated encryption-at-rest and opened the DB with
 * `defaultConfig()` + no key: against an encrypted database they died with
 * "SqliteError: file is not a database", and against a non-default
 * config.yaml dataDir they opened the wrong file entirely — the same two
 * bug classes fixed for doctor/backup in the Wave-0/1 hardening.
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { defaultConfigDir } from '../config/datadir.js';
import { getOrCreateKey } from '../storage/keystore.js';
import { openDb, type DB } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import { isPlaintextSqlite } from '../storage/migrate-encrypt.js';
import type { Config } from '../config/config.js';

export interface RuntimeDb {
  db: DB;
  cfg: Config;
  dataDir: string;
}

/** Resolve config the same way serve does, open key-aware, run migrations.
 *
 * Key is applied only when the file on disk is actually encrypted: a
 * plaintext DB (fresh test dir, encryption recently toggled on but serve's
 * auto-migration not yet run) must be opened WITHOUT a key — PRAGMA key on
 * a plaintext file makes every read fail with "file is not a database".
 * serve owns the plaintext→encrypted migration; one-shot commands do not. */
export function openRuntimeDb(): RuntimeDb {
  const { cfg, dataDir } = resolveRuntimeConfig();
  const dbPath = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'memory.sqlite');
  const wantKey =
    dbPath !== ':memory:' &&
    cfg.security.encryption.enabled &&
    existsSync(dbPath) &&
    !isPlaintextSqlite(dbPath);
  const key = wantKey ? getOrCreateKey(defaultConfigDir()).key : undefined;
  const db = openDb(dbPath, key ? { key } : {});
  migrate(db, cfg.embedding.dim);
  return { db, cfg, dataDir };
}
