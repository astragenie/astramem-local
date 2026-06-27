/**
 * backup.ts — `astramem-local backup` CLI command.
 *
 * Usage:
 *   astramem-local backup [--out PATH] [--keep N] [--json]
 *
 * Exit codes:
 *   0 = success
 *   1 = failure (write error, no space, DB locked, invalid args)
 */
import { join } from 'node:path';
import { createSnapshot } from '../backup/snapshot.js';
import { pruneOldBackups } from '../backup/retention.js';
import { defaultConfig } from '../config/config.js';
import { openDb } from '../storage/db.js';
import { migrate } from '../storage/migrate.js';

function parseArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/**
 * Generate a timestamped filename: `memory-YYYYMMDDTHHmmss.sqlite`
 */
function defaultFilename(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `memory-${date}.sqlite`;
}

export async function backupCommand(args: string[]): Promise<void> {
  const outArg = parseArg(args, '--out');
  const keepArg = parseArg(args, '--keep');
  const jsonMode = hasFlag(args, '--json');

  const keep = keepArg !== undefined ? Number(keepArg) : 7;
  if (!Number.isInteger(keep) || keep < 1) {
    console.error('backup: --keep must be a positive integer');
    process.exit(1);
  }

  const cfg = defaultConfig();
  const dataDir = cfg.dataDir;
  const backupDir = join(dataDir, 'backups');

  const outPath = outArg ?? join(backupDir, defaultFilename());

  // Open the live DB so we can use its backup API.
  // Migrations run automatically when the DB is first opened.
  const dbPath = join(dataDir, 'memory.sqlite');
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb(dbPath);
    migrate(db);
  } catch (err) {
    console.error(`backup: failed to open database at ${dbPath}: ${err}`);
    process.exit(1);
  }

  let snapshotResult: { path: string; size_bytes: number; duration_ms: number };
  try {
    snapshotResult = await createSnapshot(db, outPath);
  } catch (err) {
    console.error(`backup: snapshot failed: ${err}`);
    db.close();
    process.exit(1);
  }

  db.close();

  // Apply retention policy
  const retention = pruneOldBackups(backupDir, keep);

  if (jsonMode) {
    console.log(
      JSON.stringify({
        path: snapshotResult.path,
        size_bytes: snapshotResult.size_bytes,
        duration_ms: snapshotResult.duration_ms,
        kept: retention.kept.length,
        deleted: retention.deleted.length,
      })
    );
  } else {
    const kb = (snapshotResult.size_bytes / 1024).toFixed(1);
    console.log(`Backup created: ${snapshotResult.path}`);
    console.log(`  Size:     ${kb} KB`);
    console.log(`  Duration: ${snapshotResult.duration_ms}ms`);
    console.log(
      `  Retention: kept ${retention.kept.length}, deleted ${retention.deleted.length}`
    );
  }
}
