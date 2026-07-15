/**
 * Process-wide KNN offload registration (2026-07-15 incident fix).
 *
 * The search layer constructs its SqliteVecStore inline per query
 * (src/search/search.ts), reached through four independent route layers
 * (search, recall, mcp, dashboard-search) — threading an injected store
 * through every signature would churn all of them for one daemon-only
 * concern. Instead the DAEMON registers an offload function at boot
 * (serve.ts, after the DB key is resolved) and the search layer consults it:
 * registered -> KNN runs on the worker thread (vec-search-host.ts);
 * not registered (mcp-stdio, CLI, eval harness, tests, :memory:) -> the
 * inline synchronous store, byte-identical to prior behavior.
 *
 * Deliberately a module-level slot, not config: it must be impossible to
 * half-configure (either the daemon registered a working host or callers get
 * the old path), and only serve.ts may register.
 */
import type { VecHit } from '../contracts/index.js';

export type VecSearchOffload = (vec: Float32Array, k: number) => Promise<VecHit[]>;

let offload: VecSearchOffload | null = null;

export function setVecSearchOffload(fn: VecSearchOffload | null): void {
  offload = fn;
}

export function getVecSearchOffload(): VecSearchOffload | null {
  return offload;
}
