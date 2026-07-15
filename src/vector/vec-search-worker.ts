/**
 * vec-search-worker.ts — worker_thread entry that serves sqlite-vec KNN
 * queries from its OWN read-only database connection.
 *
 * Why this exists (2026-07-15 incident): the brute-force KNN
 * (`memories_vec MATCH ?`) is a synchronous native better-sqlite3 call that
 * scans every vector page — ~0.7-1.5s at 36k×1024-dim under SQLCipher and
 * growing linearly with the corpus. Executed on the daemon's main thread it
 * blocks the event loop for the whole scan; combined with other sync slices
 * it saturated the loop until /health probes timed out and the hang-watchdog
 * killed a healthy daemon. On a worker thread the same scan costs the loop
 * nothing.
 *
 * Connection isolation: better-sqlite3 is thread-safe only as one-connection-
 * per-thread — this worker opens its own READ-ONLY handle (WAL readers never
 * block the main connection's writer). Write paths (upsert/clear) stay on the
 * main thread's connection, untouched.
 *
 * Protocol (host: vec-search-host.ts):
 *   worker -> host:  { type: 'ready' }                    after open+prepare
 *   host -> worker:  { id, vec: ArrayBuffer, k }          one KNN request
 *   worker -> host:  { id, rows: [{id, distance}] }       success
 *                    { id, error: string }                per-request failure
 * Boot failure: worker throws -> host sees 'error'/'exit' and falls back.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';

interface VecWorkerData {
  dbPath: string;
  key?: string;
}

interface SearchRequest {
  id: number;
  vec: ArrayBuffer;
  k: number;
}

if (!parentPort) throw new Error('vec-search-worker must run as a worker thread');
const port = parentPort;

const { dbPath, key } = workerData as VecWorkerData;

// Read-only: this connection must never hold a write lock against the main
// thread. PRAGMA key must come first (SQLCipher), before any page is read.
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
if (key) db.pragma(`key='${key.replace(/'/g, "''")}'`);
// Wait out transient write locks instead of throwing SQLITE_BUSY — mirrors
// openDb (storage/db.ts). Write pragmas (journal_mode etc.) are deliberately
// absent: not permitted on a read-only connection, and WAL is a property of
// the database file already set by the main connection.
db.pragma('busy_timeout = 5000');
sqliteVec.load(db);

// Prepared once — same query as SqliteVecStore.search (vector/sqlite-vec.ts);
// preparing at boot also verifies the schema before we report ready.
const knn = db.prepare(`
  SELECT m.id, mv.distance
  FROM memories_vec mv
  JOIN memories m ON m.rowid = mv.rowid
  WHERE mv.embedding MATCH ? AND mv.k = ?
`);

port.on('message', (msg: SearchRequest) => {
  try {
    const rows = knn.all(Buffer.from(msg.vec), msg.k) as { id: string; distance: number }[];
    port.postMessage({ id: msg.id, rows });
  } catch (err) {
    port.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});

port.postMessage({ type: 'ready' });
