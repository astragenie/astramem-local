/**
 * Durable ingest spool (FEAT-449) — shared path/write/list/quarantine
 * helpers for the `capture claude` CLI (writer, src/cli/capture.ts) and the
 * daemon's spool-drain worker (reader, src/ingest/spool-drain.ts).
 *
 * Captured envelope CONTENT is written here atomically (tmp-file + rename —
 * never a torn file) at capture time, decoupled from the daemon's
 * availability: AC-8 — a capture that runs while the daemon is stopped still
 * leaves a durable spool file, drained on the daemon's next tick once it
 * starts. AC-2 — the filename IS the idempotency key (a content hash), so
 * re-capturing unmodified content overwrites the same path rather than
 * accumulating duplicates.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function spoolDir(dataDir: string): string {
  return join(dataDir, 'ingest-spool');
}

export function spoolQuarantineDir(dataDir: string): string {
  return join(spoolDir(dataDir), '.quarantine');
}

/**
 * Write `body` (a JSON-serializable envelope) to the spool keyed by
 * `idempotencyKey`, via tmp-file + atomic rename — a reader can never
 * observe a torn/partial file. Re-writing the same key is a same-path
 * overwrite, not a duplicate (AC-2). Returns the final spool file path.
 */
export function writeToSpool(dataDir: string, idempotencyKey: string, body: unknown): string {
  // Defense-in-depth: the key becomes a filename segment. Every caller passes
  // a SHA-256 hex digest; reject anything else so no future caller can
  // path-traverse (`../`) or escape the spool dir via a crafted key.
  if (!/^[0-9a-f]{64}$/.test(idempotencyKey)) {
    throw new Error(`writeToSpool: idempotencyKey must be a 64-char lowercase hex digest, got ${JSON.stringify(idempotencyKey).slice(0, 80)}`);
  }
  const dir = spoolDir(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `${idempotencyKey}.json`);
  const tmpPath = join(dir, `.${idempotencyKey}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(body, null, 2));
  renameSync(tmpPath, finalPath);
  return finalPath;
}

export interface SpoolFile {
  path: string;
  /** The idempotency key — the filename stem (without `.json`). */
  key: string;
  size: number;
}

/** List drainable spool files — excludes the `.quarantine/` subdir and any
 *  in-flight tmp file (dotfile-prefixed, per writeToSpool above). */
export function listSpoolFiles(dataDir: string): SpoolFile[] {
  const dir = spoolDir(dataDir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // spool dir doesn't exist yet — nothing captured, not an error
  }
  const out: SpoolFile[] = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.') || !e.name.endsWith('.json')) continue;
    const path = join(dir, e.name);
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue; // vanished between readdir and stat (raced another drain) — skip
    }
    out.push({ path, key: e.name.slice(0, -'.json'.length), size });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Move a poison/oversize spool file into `ingest-spool/.quarantine/` (AC-5),
 * writing a sibling `<key>.reason.txt` so the reason is auditable on disk.
 * Best-effort: if the source already vanished (raced another drain tick),
 * this is a no-op rather than a throw.
 */
export function quarantineSpoolFile(dataDir: string, file: SpoolFile, reason: string): void {
  const qDir = spoolQuarantineDir(dataDir);
  if (!existsSync(qDir)) mkdirSync(qDir, { recursive: true });
  const dest = join(qDir, `${file.key}.json`);
  try {
    renameSync(file.path, dest);
  } catch {
    return;
  }
  try {
    writeFileSync(join(qDir, `${file.key}.reason.txt`), `${reason}\n`);
  } catch {
    /* best-effort — the quarantined envelope itself is the important part */
  }
}

/** Delete a successfully-drained spool file. Best-effort — already-gone is fine. */
export function deleteSpoolFile(file: SpoolFile): void {
  try {
    unlinkSync(file.path);
  } catch {
    /* already gone — fine */
  }
}
