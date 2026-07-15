/**
 * vec-search-host.ts — main-thread host for the KNN offload worker
 * (vec-search-worker.ts). Mirrors the OnnxWorkerHostProvider pattern
 * (ADR-019 Decision 2d, targeted worker_thread offload of heavy synchronous
 * call sites): lazy spawn + ready handshake, pending-request map, per-request
 * timeout that can actually FIRE because the heavy work no longer runs on the
 * loop, crash-respawn, and a deliberate-terminate flag so clean shutdown
 * doesn't log like a crash.
 *
 * Failure posture (ADR-015, loud but never down): ANY worker failure — spawn
 * timeout, per-search timeout, worker error/exit — falls back to the caller-
 * supplied synchronous fallback (the main-connection SqliteVecStore), with a
 * WARN and a counter. Degraded (the old blocking behavior) beats broken.
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
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly opts: VecSearchHostOpts) {}

  /** Total searches served by the sync fallback instead of the worker —
   *  a rising number means the offload is not actually offloading. */
  get fallbackCount(): number {
    return this.fallbacks;
  }

  async search(vec: Float32Array, k: number): Promise<VecHit[]> {
    try {
      await this.ensureWorker();
      return await this.searchOnWorker(vec, k);
    } catch (err) {
      this.fallbacks++;
      // WARN every time (each one is a full event-loop-blocking scan on the
      // main thread — the exact thing this class exists to prevent), but keep
      // the daemon serving.
      this.log.warn(
        { error_message: err instanceof Error ? err.message : String(err), fallback_count: this.fallbacks },
        'vec search fell back to main-thread scan',
      );
      return this.opts.fallback(vec, k);
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`vec search timed out after ${this.opts.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS}ms`));
      }, this.opts.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS);
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
