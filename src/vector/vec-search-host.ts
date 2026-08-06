/**
 * vec-search-host.ts — main-thread host for the KNN offload worker
 * (vec-search-worker.ts). Mirrors the OnnxWorkerHostProvider pattern
 * (ADR-019 Decision 2d, targeted worker_thread offload of heavy synchronous
 * call sites): lazy spawn + ready handshake, pending-request map, per-request
 * timeout that can actually FIRE because the heavy work no longer runs on the
 * loop, crash-respawn, and a deliberate-terminate flag so clean shutdown
 * doesn't log like a crash.
 *
 * Failure posture (ADR-015, loud but never down): an INFRASTRUCTURE failure —
 * spawn timeout, worker error/exit, worker unavailable — falls back to the
 * caller-supplied synchronous fallback (the main-connection SqliteVecStore),
 * with a WARN and a counter. Degraded (the old blocking behavior) beats broken.
 *
 * A per-search TIMEOUT is deliberately NOT in that set (2026-08-05). Falling
 * back after a search timeout is guaranteed to block the event loop for AT
 * LEAST the timeout that just expired — the query has already demonstrated it
 * exceeds the budget, and the fallback runs that same query synchronously on
 * the loop. That is not "degraded", it is the daemon going down: measured on
 * 2026-08-05 as 30-64s event-loop blocks (el_p99 ~70ms, el_max 64,391ms) on an
 * IDLE box at 17% CPU, a 450,015ms gap in the 30s spool-drain tick with total
 * log silence, and 30 `vec search timed out after 30000ms` fallbacks — each
 * one taking /health with it, which is what the watchdog then killed (13 of 15
 * kills were previously-healthy instances). Serving one FTS-only search costs
 * a little recall; freezing the loop costs capture, sync, jobs and doctor for
 * a minute and then earns a kill. ADR-015's "never down" is better served by
 * failing the one query.
 *
 * Callers already handle this: src/search/search.ts:834 wraps the offload in
 * `catch { /* FTS-only mode *\/ }`, so a throw degrades hybrid search to BM25
 * rather than erroring the request.
 *
 * This is CONTAINMENT, not a performance fix. A worker scan exceeding 30s at
 * all is itself pathological against the measured 0.7-1.5s/scan baseline — see
 * docs/research/20260805-daemon-stability-forensics.md and docs/memory.md's
 * vec0-join-degrading-to-per-row-probe incident for the underlying scale
 * problem, which still needs its own fix.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { VecHit } from '../contracts/index.js';
import { childLogger } from '../log/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Sibling compiled file — resolves against BUILT output only (`bun run
 * build` first), same caveat as onnx-worker-host.ts. Tests inject
 * workerPath/workerFactory instead. */
const DEFAULT_WORKER_PATH = join(__dirname, 'vec-search-worker.js');

/** Open+key+prepare on a local file — generous; a stuck spawn falls back. */
const DEFAULT_SPAWN_TIMEOUT_MS = 15_000;
/** Well above the measured 0.7-1.5s/scan with room for queueing behind
 * sibling queries on the same worker thread. */
const DEFAULT_SEARCH_TIMEOUT_MS = 30_000;

/**
 * Thrown when the WORKER accepted a search but did not answer within
 * `searchTimeoutMs`. Distinct from every other failure in this file because it
 * is the one case where the synchronous fallback is known-harmful rather than
 * merely slow: the query has already proven it exceeds the budget, so running
 * it on the loop blocks for at least that long. See the file header.
 *
 * Exported so callers and tests can distinguish "vector search gave up" from
 * "the worker is broken" without string-matching a message.
 */
export class VecSearchTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`vec search timed out after ${timeoutMs}ms`);
    this.name = 'VecSearchTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Structural subset of worker_threads.Worker used here — test seam. */
export interface VecWorkerLike {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (msg: unknown) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number> | void;
}

export interface VecSearchHostOpts {
  dbPath: string;
  key?: string;
  /** Synchronous fallback used whenever the worker path fails. */
  fallback: (vec: Float32Array, k: number) => Promise<VecHit[]>;
  /** Test seams. */
  workerPath?: string;
  workerFactory?: (path: string, workerData: { dbPath: string; key?: string }) => VecWorkerLike;
  spawnTimeoutMs?: number;
  searchTimeoutMs?: number;
}

interface Pending {
  resolve: (hits: VecHit[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function defaultFactory(path: string, workerData: { dbPath: string; key?: string }): VecWorkerLike {
  return new Worker(path, { workerData }) as unknown as VecWorkerLike;
}

export class VecSearchWorkerHost {
  private readonly log = childLogger({ component: 'vec-search-host' });
  private worker: VecWorkerLike | null = null;
  private readyPromise: Promise<void> | null = null;
  private nextId = 1;
  private terminating = false;
  private fallbacks = 0;
  private searchTimeouts = 0;
  private readonly pending = new Map<number, Pending>();
  /** Serializes main-thread fallback scans. A worker crash rejects every
   *  in-flight search at once; without this, N callers would each start a
   *  full synchronous KNN scan back-to-back with no event-loop turns between
   *  them — reproducing the loop-stacking pattern this class exists to
   *  prevent, just crash-triggered. Chaining them lets queued HTTP work run
   *  between scans. (Review MEDIUM on 3c9a81f2.) */
  private fallbackChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: VecSearchHostOpts) {}

  /** Total searches served by the sync fallback instead of the worker —
   *  a rising number means the offload is not actually offloading. */
  get fallbackCount(): number {
    return this.fallbacks;
  }

  /** Searches abandoned because the worker blew `searchTimeoutMs`. Counted
   *  separately from `fallbackCount` because the two mean opposite things: a
   *  fallback is the offload failing to offload, whereas a timeout is the
   *  offload WORKING and the underlying query being too slow. A rising number
   *  here means recall is silently degrading to FTS-only and the vec query
   *  needs a performance fix — not that this class is misbehaving. */
  get searchTimeoutCount(): number {
    return this.searchTimeouts;
  }

  async search(vec: Float32Array, k: number): Promise<VecHit[]> {
    try {
      await this.ensureWorker();
      return await this.searchOnWorker(vec, k);
    } catch (err) {
      if (err instanceof VecSearchTimeoutError) {
        // Do NOT fall back — see the file header. The synchronous fallback runs
        // the SAME query that just exceeded `timeoutMs` on the worker, so it
        // would block the event loop for at least that long and take /health
        // (and capture, sync, jobs, doctor) down with it. Callers degrade to
        // FTS-only on a throw; that is the cheaper failure by a wide margin.
        this.searchTimeouts++;
        this.log.error(
          { error_message: err.message, timeout_ms: err.timeoutMs, search_timeout_count: this.searchTimeouts },
          'vec search timed out on the worker — failing this search instead of blocking the event loop with a main-thread scan',
        );
        throw err;
      }
      this.fallbacks++;
      // WARN every time (each one is a full event-loop-blocking scan on the
      // main thread — the exact thing this class exists to prevent), but keep
      // the daemon serving. Reached only for INFRASTRUCTURE failures (spawn
      // timeout, worker error/exit, worker unavailable), where the query itself
      // has not been shown to be slow.
      this.log.warn(
        { error_message: err instanceof Error ? err.message : String(err), fallback_count: this.fallbacks },
        'vec search fell back to main-thread scan',
      );
      const run = (): Promise<VecHit[]> => this.opts.fallback(vec, k);
      const chained = this.fallbackChain.then(run, run);
      this.fallbackChain = chained.catch(() => undefined);
      return chained;
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const path = this.opts.workerPath ?? DEFAULT_WORKER_PATH;
      const factory = this.opts.workerFactory ?? defaultFactory;
      const spawnTimeout = setTimeout(() => {
        reject(new Error(`vec-search worker not ready within ${this.opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS}ms`));
        this.teardown();
      }, this.opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);

      let w: VecWorkerLike;
      try {
        w = factory(path, { dbPath: this.opts.dbPath, key: this.opts.key });
      } catch (err) {
        clearTimeout(spawnTimeout);
        this.readyPromise = null;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.worker = w;

      w.on('message', (msg) => {
        const m = msg as { type?: string; id?: number; rows?: { id: string; distance: number }[]; error?: string };
        if (m.type === 'ready') {
          clearTimeout(spawnTimeout);
          resolve();
          return;
        }
        if (typeof m.id === 'number') {
          const p = this.pending.get(m.id);
          if (!p) return; // already timed out — result arrived late, drop it
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.error !== undefined) p.reject(new Error(m.error));
          // Same score mapping as SqliteVecStore.search — keep in lock-step.
          else p.resolve((m.rows ?? []).map((r) => ({ id: r.id, score: 1 / (1 + r.distance) })));
        }
      });
      w.on('error', (err) => {
        clearTimeout(spawnTimeout);
        if (!this.terminating) this.log.warn({ error_message: err.message }, 'vec-search worker error');
        this.failAll(err);
        this.teardown();
        reject(err);
      });
      w.on('exit', (code) => {
        clearTimeout(spawnTimeout);
        if (!this.terminating) this.log.warn({ exit_code: code }, 'vec-search worker exited — will respawn on next search');
        this.failAll(new Error(`vec-search worker exited (code ${code})`));
        this.teardown();
        reject(new Error(`vec-search worker exited during spawn (code ${code})`));
      });
    });
    // A failed spawn must not poison future calls — clear so the next search
    // re-attempts (teardown() already nulled it, but cover the sync-throw path).
    this.readyPromise.catch(() => { this.readyPromise = null; });
    return this.readyPromise;
  }

  private searchOnWorker(vec: Float32Array, k: number): Promise<VecHit[]> {
    const w = this.worker;
    if (!w) return Promise.reject(new Error('vec-search worker not available'));
    const id = this.nextId++;
    return new Promise<VecHit[]>((resolve, reject) => {
      const timeoutMs = this.opts.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VecSearchTimeoutError(timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // Copy, don't transfer: 4KB per query, and callers reuse their vec
      // (rerank/decompose read it after the search).
      const copy = vec.slice();
      w.postMessage({ id, vec: copy.buffer, k });
    });
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private teardown(): void {
    this.worker = null;
    this.readyPromise = null;
  }

  async stop(): Promise<void> {
    this.terminating = true;
    const w = this.worker;
    this.teardown();
    if (w) {
      try { await w.terminate(); } catch { /* already dead */ }
    }
  }
}
