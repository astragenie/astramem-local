/**
 * verify.ts — prove a snapshot restores (W2.1).
 *
 * A backup that can't be opened is discovered at the worst possible moment.
 * Verification: reopen the snapshot read-only with the same key, run
 * PRAGMA integrity_check, and compare memories/transcripts row counts against
 * the live database the snapshot was taken from.
 */
import Database from 'better-sqlite3-multiple-ciphers';
import type { DB } from '../storage/db.js';

export interface VerifyResult {
  ok: boolean;
  integrity: string;
  counts: {
    memories: { live: number; snapshot: number };
    transcripts: { live: number; snapshot: number };
  };
  error?: string;
}

function countRows(db: DB, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return -1; // table absent
  }
}

/**
 * Verify `snapshotPath` against the live `db` it was snapshotted from.
 * Row-count tolerance: the live DB may have gained rows since the snapshot
 * started (online backup), so snapshot counts must be <= live counts and
 * within `tolerance` of them — never greater, never wildly behind.
 */
export function verifySnapshot(
  liveDb: DB,
  snapshotPath: string,
  key?: string,
  tolerance = 10,
): VerifyResult {
  const liveCounts = {
    memories: countRows(liveDb, 'memories'),
    transcripts: countRows(liveDb, 'transcripts'),
  };
  const result: VerifyResult = {
    ok: false,
    integrity: '',
    counts: {
      memories: { live: liveCounts.memories, snapshot: -1 },
      transcripts: { live: liveCounts.transcripts, snapshot: -1 },
    },
  };

  let snap: DB | null = null;
  try {
    snap = new Database(snapshotPath, { readonly: true }) as DB;
    if (key) snap.pragma(`key='${key.replace(/'/g, "''")}'`);

    const integrityRows = snap.pragma('integrity_check') as Array<{ integrity_check: string }>;
    result.integrity = integrityRows.map(r => r.integrity_check).join('; ');
    if (result.integrity !== 'ok') {
      result.error = `integrity_check: ${result.integrity}`;
      return result;
    }

    result.counts.memories.snapshot = countRows(snap, 'memories');
    result.counts.transcripts.snapshot = countRows(snap, 'transcripts');

    for (const table of ['memories', 'transcripts'] as const) {
      const { live, snapshot } = result.counts[table];
      if (snapshot < 0) {
        result.error = `snapshot missing ${table} table`;
        return result;
      }
      // Snapshot may lag the live DB slightly (online backup) but must never
      // exceed it or fall further behind than `tolerance` rows.
      if (snapshot > live || live - snapshot > tolerance) {
        result.error = `${table} count mismatch: live=${live} snapshot=${snapshot} (tolerance ${tolerance})`;
        return result;
      }
    }

    result.ok = true;
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  } finally {
    try { snap?.close(); } catch { /* ignore */ }
  }
}
