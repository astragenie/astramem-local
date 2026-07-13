/**
 * restore.ts — `astramem-local restore <snapshot>` (W2.2).
 *
 * Until now restore was an undocumented manual file copy. This command makes
 * it safe:
 *   1. verify the snapshot BEFORE touching anything (integrity_check + key)
 *   2. stop a running daemon (via daemon.lock, same as reinstall)
 *   3. set the current DB aside as memory.sqlite.pre-restore.bak (never lost)
 *   4. swap the snapshot in via copy-to-tmp + atomic rename
 *   5. run schema migrations (an old snapshot may predate current schema)
 *   6. restart the service if one is registered, verify /health
 *
 * Exit codes: 0 = restored + healthy (or restored, daemon left stopped);
 * 1 = any failure — the original DB is never deleted.
 *
 * --force / --force-mismatch: step 2's identity-verified stop
 * (`stopLockHolder`) aborts by default on ANY failure. `--force` bypasses
 * that abort ONLY for the "could not check" sub-cases (malformed lock, OS
 * identity query unavailable, signal/stop-mechanics failures) — never the
 * snapshot probe (step 1), the aside-copy (step 3), or the atomic swap
 * (step 3-4), which stay unconditional. A CONFIRMED identity mismatch
 * (`reason: 'identity-mismatch'` — the check ran and proved the live PID is
 * NOT our daemon) additionally requires `--force-mismatch` alongside
 * `--force`: that is a known-wrong-process finding, not an unverified risk,
 * and deserves a second, differently-worded confirmation rather than being
 * silently swallowed by the same flag that covers "the query failed".
 */
import { existsSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { defaultConfigDir } from '../config/datadir.js';
import { getOrCreateKey } from '../storage/keystore.js';
import { stopLockHolder } from '../service/instance-lock.js';
import { getServiceAdapter } from '../service/index.js';
import { openDb } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';
import { waitForHealth } from './wait-health.js';
import type { DB } from '../storage/db.js';

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Standalone integrity probe of a snapshot file (key-aware). */
function probeSnapshot(path: string, key?: string): { ok: boolean; error?: string } {
  let db: DB | null = null;
  try {
    db = new Database(path, { readonly: true }) as DB;
    if (key) db.pragma(`key='${key.replace(/'/g, "''")}'`);
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const verdict = rows.map(r => r.integrity_check).join('; ');
    return verdict === 'ok' ? { ok: true } : { ok: false, error: `integrity_check: ${verdict}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export async function restoreCommand(args: string[]): Promise<void> {
  const snapshotPath = args.find(a => !a.startsWith('-'));
  const noRestart = hasFlag(args, '--no-restart');
  const force = hasFlag(args, '--force');
  const forceMismatch = hasFlag(args, '--force-mismatch');
  if (!snapshotPath) {
    console.error(
      'restore: snapshot path required\n' +
      'Usage: astramem-local restore <snapshot.sqlite> [--no-restart] [--force] [--force-mismatch]',
    );
    process.exit(1);
  }
  if (!existsSync(snapshotPath)) {
    console.error(`restore: snapshot not found: ${snapshotPath}`);
    process.exit(1);
  }

  const { cfg, port, dataDir } = resolveRuntimeConfig();
  if (dataDir === ':memory:') {
    console.error('restore: refusing to restore into :memory:');
    process.exit(1);
  }
  const dbPath = join(dataDir, 'memory.sqlite');
  const key = cfg.security.encryption.enabled ? getOrCreateKey(defaultConfigDir()).key : undefined;

  console.log(`\nAstraMemory restore\n  snapshot: ${snapshotPath}\n  target  : ${dbPath}\n`);

  // 1. Verify the snapshot before touching anything.
  const probe = probeSnapshot(snapshotPath, key);
  if (!probe.ok) {
    console.error(`✗ snapshot failed verification: ${probe.error}`);
    console.error('  Nothing was changed.');
    process.exit(1);
  }
  console.log('  · snapshot integrity: ok');

  // 2. Stop the daemon. stopLockHolder verifies the lock holder's PID +
  // OS-reported start time before ever signaling it — a recycled PID is left
  // untouched. Restore is about to rename the live DB file out from under
  // whoever holds it, so an unverified stop is treated as fatal (not a
  // best-effort warning): proceeding while an unconfirmed process may still
  // be writing risks silently corrupting the swapped-in snapshot, a strictly
  // worse outcome than aborting and asking the operator to check by hand.
  const stopResult = await stopLockHolder(dataDir, port);
  console.log(`  · stop daemon: ${stopResult.detail}`);
  if (!stopResult.ok) {
    const isConfirmedMismatch = stopResult.reason === 'identity-mismatch';
    // Plain --force covers every "could not check" sub-case (malformed lock,
    // OS identity query unavailable, signal/stop-mechanics failures). A
    // CONFIRMED mismatch is a different, stronger finding — the identity
    // check RAN and proved this is NOT our daemon — so it needs the second
    // flag too, not just --force alone.
    const bypassed = force && (!isConfirmedMismatch || forceMismatch);
    if (!bypassed) {
      console.error(`✗ ${stopResult.detail}`);
      if (isConfirmedMismatch) {
        console.error('  This is a CONFIRMED mismatch, not an unverifiable check: the identity check');
        console.error('  RAN and the OS reports the live process at this PID is NOT our daemon.');
        console.error('  --force alone will not bypass this. If you have independently verified it is');
        console.error('  safe to proceed anyway, rerun with --force --force-mismatch.');
      } else if (!force) {
        console.error('  If you have independently verified the daemon is actually stopped (e.g. the');
        console.error('  identity query itself is unavailable in this environment), rerun with --force.');
      }
      console.error('  Nothing was changed. Confirm the daemon is stopped and retry.');
      process.exit(1);
    }
    console.error(
      `⚠ ${isConfirmedMismatch ? '--force --force-mismatch' : '--force'}: bypassing the identity-verification abort.`,
    );
    console.error(`  Reason bypassed: ${stopResult.detail}`);
    console.error('  An unidentified process may still hold this lock and be writing to the database');
    console.error('  that is about to be replaced — if so, this restore can corrupt the swapped-in');
    console.error('  snapshot. Proceeding ONLY because the override flag(s) were passed; this is not a');
    console.error('  substitute for confirming by other means that the real daemon is stopped.');
  }

  // 3+4. Set current DB aside, swap snapshot in atomically.
  const asidePath = `${dbPath}.pre-restore.bak`;
  const tmpPath = `${dbPath}.restoring-tmp`;
  try {
    copyFileSync(snapshotPath, tmpPath);
    if (existsSync(dbPath)) {
      rmSync(asidePath, { force: true });
      renameSync(dbPath, asidePath);
      console.log(`  · current DB set aside: ${asidePath}`);
      // Stale WAL/SHM belong to the old DB — remove so SQLite doesn't pair
      // them with the restored file (mismatched WAL corrupts).
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
    renameSync(tmpPath, dbPath);
    console.log('  · snapshot swapped in');
  } catch (err) {
    rmSync(tmpPath, { force: true });
    console.error(`✗ swap failed: ${(err as Error).message}`);
    console.error(`  Original DB ${existsSync(asidePath) ? `is at ${asidePath} — rename it back` : 'was not moved'}.`);
    process.exit(1);
  }

  // 5. Migrations — an older snapshot may predate the current schema.
  try {
    const db = openDb(dbPath, key ? { key } : {});
    migrate(db, cfg.embedding.dim);
    db.close();
    console.log('  · schema migrations applied');
  } catch (err) {
    console.error(`✗ migration on restored DB failed: ${(err as Error).message}`);
    console.error(`  Roll back: delete ${dbPath} and rename ${asidePath} back.`);
    process.exit(1);
  }

  // 6. Restart service when one is registered.
  if (!noRestart) {
    try {
      const adapter = getServiceAdapter();
      const status = await adapter.status();
      if (status.installed) {
        await adapter.start();
        const healthy = await waitForHealth(port, 30_000);
        console.log(healthy ? `  ✓ daemon healthy on :${port}` : `  ⚠ daemon did not report healthy within 30s — check 'astramem-local doctor'`);
      } else {
        console.log('  · no service registered — start manually (serve / service start)');
      }
    } catch (err) {
      console.log(`  ⚠ restart failed: ${(err as Error).message} — start manually`);
    }
  }

  console.log(`\n✓ restore complete. Previous DB kept at ${asidePath} — delete it once verified.\n`);
}
