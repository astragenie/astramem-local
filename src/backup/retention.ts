/**
 * retention.ts — prune old backup snapshots, keeping the newest N.
 *
 * Scans `dir` for files matching `memory-*.sqlite`, sorts by mtime descending,
 * keeps the first `keep`, deletes the rest.
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface RetentionResult {
  kept: string[];
  deleted: string[];
}

/**
 * Prune old backup snapshots in `dir`, keeping the newest `keep` files.
 *
 * Only files matching `memory-*.sqlite` are considered — other files in the
 * directory are left untouched.
 *
 * @param dir  Directory to scan (must exist; throws if not readable).
 * @param keep Number of snapshots to retain (must be >= 1).
 * @returns    { kept, deleted } arrays of absolute paths.
 */
export function pruneOldBackups(dir: string, keep: number): RetentionResult {
  if (keep < 1) throw new RangeError(`keep must be >= 1, got ${keep}`);

  // Gather candidate files
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // Directory does not exist yet — nothing to prune
    return { kept: [], deleted: [] };
  }

  const candidates = entries
    .filter(name => /^memory-.*\.sqlite$/.test(name))
    .map(name => {
      const fullPath = join(dir, name);
      let mtime = 0;
      try {
        mtime = statSync(fullPath).mtimeMs;
      } catch {
        // File vanished between readdir and stat — skip it
        return null;
      }
      return { path: fullPath, mtime };
    })
    .filter((x): x is { path: string; mtime: number } => x !== null);

  // Sort newest first
  candidates.sort((a, b) => b.mtime - a.mtime);

  const kept = candidates.slice(0, keep).map(c => c.path);
  const toDelete = candidates.slice(keep);
  const deleted: string[] = [];

  for (const candidate of toDelete) {
    try {
      unlinkSync(candidate.path);
      deleted.push(candidate.path);
    } catch {
      // Best-effort: if deletion fails (e.g. race condition) skip it
    }
  }

  return { kept, deleted };
}
