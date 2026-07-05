/**
 * Vitest globalSetup — pays the one-time native-addon cold-load cost once,
 * up front, in an untimed setup phase, instead of letting it land
 * unpredictably inside whichever test happens to be the first (in whichever
 * worker thread) to touch better-sqlite3-multiple-ciphers / sqlite-vec.
 *
 * Root cause this addresses (FEAT-431, class B): tests/security/cipher-
 * spike.test.ts and tests/capture/codex.test.ts's end-to-end case both call
 * into `openDb()` (src/storage/db.ts), which does `new Database(path)`
 * (better-sqlite3-multiple-ciphers — a native addon, distinct from vanilla
 * better-sqlite3) followed by `sqliteVec.load(db)` (loads the sqlite-vec
 * native extension). The FIRST such call in a given OS process pays a real,
 * highly variable cost — dlopen/mmap of the shared library, first-time page
 * faults reading it off disk, the extension's own init routine — that is
 * NOT shared across vitest worker threads reliably and is exactly the kind
 * of cost that spikes hard under disk contention, antivirus/EDR real-time
 * scanning of a freshly-extracted .node binary, or a cold self-hosted-runner
 * checkout. Every subsequent call in the same process is fast (pages already
 * resident). This runs the exact same open+load sequence once, here, so the
 * OS page cache for both native libraries is warm before any timed test or
 * hook budget starts ticking.
 *
 * globalSetup runs once in its own process, before the worker pool spins up,
 * and is not subject to `testTimeout`/`hookTimeout` — so a slow cold load
 * here cannot itself cause a test failure. It also does not share Vitest's
 * per-worker Vite module-transform cache with the actual test run (that is a
 * separate, non-native-addon-related cost — see the migrate-dirs.test.ts
 * in-file warm-import fix for that half of class B); this file exists solely
 * to warm the OS-level disk cache for the native binaries themselves.
 */
export default async function setup(): Promise<void> {
  const { openDb } = await import('../../src/storage/db.js');
  const db = openDb(':memory:');
  db.close();
}
