import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { EmbedHealth, EmbedProvider } from '../../contracts/embed.js';
import { DEFAULT_EMBED_DIM } from '../../contracts/embed.js';
import { childLogger } from '../../log/logger.js';
import type { OnnxEmbedConfig } from './onnx.js';
import { DEFAULT_MODEL_LABEL } from './onnx-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Sibling compiled file — onnx-worker.ts builds to onnx-worker.js in the
 * SAME dist directory as this module (tsc preserves directory structure).
 * `new Worker()` loads a fresh Node realm via the plain module loader (not
 * vite-node's transform), so this only resolves correctly against BUILT
 * output — `bun run build` first, same as every other runtime entry point in
 * this repo. Tests never hit this path (see `workerFactory` DI below). */
const DEFAULT_WORKER_PATH = join(__dirname, 'onnx-worker.js');

/** Model load + first-run weight download can legitimately take the ~18s
 * this repo's own validation measured cold (plus network variance for a
 * genuinely first-time download) — generous on purpose, this only gates the
 * ONE-TIME (per worker lifetime) ready handshake, not per-embed latency. */
const DEFAULT_SPAWN_TIMEOUT_MS = 120_000;
/** Per-request cap once the worker is warm. Mirrors this repo's own
 * `PROBE_TIMEOUT_MS = 30_000` convention (serve.ts's startEmbedPreflight) —
 * comfortably above the ~400-950ms/call this hardware measured, with
 * headroom for a request queued behind concurrent siblings on the same
 * worker thread. */
const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

/** Minimal structural subset of `node:worker_threads`' `Worker` actually
 * used here — lets unit tests inject a fake in-process stand-in instead of
 * spawning a real OS thread + downloading a real model (mirrors
 * `OnnxEmbedProvider`'s `loadBackend` DI seam in onnx.ts). A real `Worker`
 * instance satisfies this shape unchanged. */
export interface OnnxWorkerLike {
  postMessage(value: unknown, transferList?: readonly ArrayBuffer[]): void;
  on(event: 'message', listener: (msg: unknown) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number> | void;
}

export interface OnnxWorkerHostOpts {
  /** Overrides the resolved worker script path — test/DI seam only. */
  workerPath?: string;
  /** Overrides how the worker is constructed — test/DI seam only. Production
   * code never sets this; defaults to a real `new Worker(path, {workerData})`. */
  workerFactory?: (path: string, workerData: OnnxEmbedConfig) => OnnxWorkerLike;
  spawnTimeoutMs?: number;
  embedTimeoutMs?: number;
}

interface PendingEmbed {
  resolve: (vecs: Float32Array[]) => void;
  reject: (err: Error) => void;
}
interface PendingHealth {
  resolve: (h: EmbedHealth) => void;
}

function defaultWorkerFactory(path: string, workerData: OnnxEmbedConfig): OnnxWorkerLike {
  return new Worker(path, { workerData }) as unknown as OnnxWorkerLike;
}

/**
 * ADR-019 Decision 2(d) — transparent worker_thread offload for the ONNX
 * embed provider. Implements the SAME `EmbedProvider` interface
 * `OnnxEmbedProvider` does, so `buildEmbedProvider` (providers/index.ts) can
 * swap the concrete class for `provider: 'onnx'` with zero changes at any
 * call site (search.ts, distill's 08-embed-index.ts, doctor's embed probes)
 * — every one of them keeps calling `embed()`/`health()` exactly as before.
 *
 * What changes: `session.run()` (the confirmed 400-950ms/call synchronous,
 * never-yields native binding — see
 * `.claude/artifacts/crew/validations/20260715T000000Z-validation-onnx-embed-event-loop-block.md`)
 * now executes on a dedicated worker thread, never on the daemon's main
 * event loop. A side benefit ADR-019 calls out explicitly: the per-embed
 * timeout below is a plain `setTimeout` on the MAIN thread, which can now
 * actually fire while the worker computes — unlike every timer-based defense
 * this repo already had (ADR-019's root-cause item 4), because the thing
 * that used to starve the event loop no longer runs on it.
 */
export class OnnxWorkerHostProvider implements EmbedProvider {
  readonly name = 'onnx' as const;
  readonly model: string;
  readonly dim: number;
  readonly queryPrefix: string;

  private readonly config: OnnxEmbedConfig;
  private readonly workerPath: string;
  private readonly workerFactory: (path: string, workerData: OnnxEmbedConfig) => OnnxWorkerLike;
  private readonly spawnTimeoutMs: number;
  private readonly embedTimeoutMs: number;
  private readonly log = childLogger({ provider: 'onnx-worker-host' });

  private worker: OnnxWorkerLike | null = null;
  private readyPromise: Promise<void> | null = null;
  private nextId = 1;
  /** Set for the duration of a deliberate terminate() call so the 'exit'
   * handler below can tell "I asked it to stop" apart from a genuine crash
   * — otherwise a clean shutdown logs the exact same WARN a real ORT crash
   * does, which would train an operator to ignore the real signal. */
  private terminating = false;
  private readonly pendingEmbeds = new Map<number, PendingEmbed>();
  private readonly pendingHealth = new Map<number, PendingHealth>();

  constructor(config: OnnxEmbedConfig = {}, opts: OnnxWorkerHostOpts = {}) {
    this.config = config;
    this.model = config.model ?? DEFAULT_MODEL_LABEL;
    this.dim = config.dim ?? DEFAULT_EMBED_DIM;
    this.queryPrefix = config.queryPrefix ?? '';
    this.workerPath = opts.workerPath ?? DEFAULT_WORKER_PATH;
    this.workerFactory = opts.workerFactory ?? defaultWorkerFactory;
    this.spawnTimeoutMs = opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;
    this.embedTimeoutMs = opts.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  }

  /**
   * ADR-018 SLICE-2's startup-preload contract, now absorbing the worker
   * spawn (ADR-019): public, idempotent wrapper that spawns the worker and
   * waits for the model to finish loading. `serve.ts`'s existing duck-typed
   * `typeof embedProvider.preload === 'function'` boot-time call (SLICE-2)
   * needs NO change — it now warms the WORKER instead of an in-process
   * backend, transparently.
   */
  async preload(): Promise<void> {
    await this.ensureWorker();
  }

  /** Spawns the worker (if none is currently live) and returns the promise
   * that resolves once it reports 'ready' (model loaded). Idempotent: a
   * second caller while a spawn is already in flight shares the same
   * promise rather than double-spawning. */
  private ensureWorker(): Promise<void> {
    if (this.worker && this.readyPromise) return this.readyPromise;

    const worker = this.workerFactory(this.workerPath, this.config);
    this.worker = worker;

    const readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `onnx worker did not become ready within ${this.spawnTimeoutMs}ms ` +
            '(model load or first-run weight download taking longer than expected)',
          ),
        );
      }, this.spawnTimeoutMs);
      if (typeof (timer as NodeJS.Timeout).unref === 'function') (timer as NodeJS.Timeout).unref();

      worker.on('message', (msg: unknown) => {
        const m = msg as { type?: string; message?: string };
        if (m?.type === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        if (m?.type === 'ready-error') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`onnx worker failed to load model: ${m.message ?? 'unknown error'}`));
          return;
        }
        this.handleWorkerMessage(msg);
      });

      worker.on('error', (err: Error) => {
        this.log.error({ err: err?.message }, 'onnx worker error');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
        this.handleWorkerCrash(err instanceof Error ? err : new Error(String(err)));
      });

      worker.on('exit', (code: number) => {
        if (code !== 0 && !this.terminating) {
          this.log.warn({ code }, 'onnx worker exited unexpectedly');
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`onnx worker exited (code ${code}) before becoming ready`));
        }
        this.handleWorkerCrash(new Error(`onnx worker exited with code ${code}`));
      });
    });

    // A failed spawn is NOT memoized — mirrors OnnxEmbedProvider.getBackend()'s
    // documented "failed load is not memoized" contract (onnx.ts), so a
    // transient failure (network unreachable on first download, a one-off
    // native-ORT crash) can be retried on the NEXT call instead of
    // permanently wedging the provider.
    this.readyPromise = readyPromise.catch((err: Error) => {
      this.worker = null;
      this.readyPromise = null;
      throw err;
    });
    return this.readyPromise;
  }

  private handleWorkerMessage(msg: unknown): void {
    const m = msg as { type?: string; id?: number; buffers?: ArrayBuffer[]; message?: string; health?: EmbedHealth };
    if (m?.type === 'embed-result' && typeof m.id === 'number') {
      const pending = this.pendingEmbeds.get(m.id);
      if (!pending) return; // already timed out / aborted — discard the late reply
      this.pendingEmbeds.delete(m.id);
      const vecs = (m.buffers ?? []).map((b) => new Float32Array(b));
      pending.resolve(vecs);
      return;
    }
    if (m?.type === 'embed-error' && typeof m.id === 'number') {
      const pending = this.pendingEmbeds.get(m.id);
      if (!pending) return;
      this.pendingEmbeds.delete(m.id);
      pending.reject(new Error(m.message ?? 'onnx worker embed failed'));
      return;
    }
    if (m?.type === 'health-result' && typeof m.id === 'number') {
      const pending = this.pendingHealth.get(m.id);
      if (!pending) return;
      this.pendingHealth.delete(m.id);
      pending.resolve(
        m.health ?? { ok: false, model: this.model, dim: this.dim, error: 'malformed health-result message' },
      );
    }
  }

  /**
   * Worker died mid-flight (native ORT crash is a known v1 risk — ADR-018's
   * own risk register). Fails every in-flight request LOUDLY AND
   * IMMEDIATELY (never lets one hang to its own timeout), then drops the
   * worker reference so the very next `embed()`/`health()`/`preload()` call
   * transparently respawns a fresh worker — the on-demand-respawn mirrors
   * `OnnxEmbedProvider`'s own "failed load is not memoized, retry on next
   * call" posture rather than an unbounded background auto-restart loop
   * (which would risk crash-looping forever against a genuinely broken
   * model/artifact instead of surfacing the failure).
   */
  private handleWorkerCrash(err: Error): void {
    this.worker = null;
    this.readyPromise = null;
    for (const [id, pending] of this.pendingEmbeds) {
      pending.reject(new Error(`onnx worker crashed while embedding: ${err.message}`));
      this.pendingEmbeds.delete(id);
    }
    for (const [id, pending] of this.pendingHealth) {
      pending.resolve({ ok: false, model: this.model, dim: this.dim, error: `onnx worker crashed: ${err.message}` });
      this.pendingHealth.delete(id);
    }
  }

  /**
   * `signal`: unlike `OnnxEmbedProvider`'s narrowed in-process contract
   * (checked only between texts within one synchronous call), the worker
   * boundary lets this proxy honor abort/timeout from a DIFFERENT thread —
   * an abort or timeout REJECTS THIS PROMISE IMMEDIATELY on the main thread
   * regardless of what the worker is doing, and best-effort relays a
   * `{type:'cancel'}` message so the worker's own between-texts checkpoint
   * (still the underlying mechanism) can stop early too. No pending message
   * is ever leaked: every branch below removes the request from
   * `pendingEmbeds` exactly once before settling.
   */
  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
    }

    await this.ensureWorker();
    const worker = this.worker;
    if (!worker) throw new Error('onnx worker unavailable after spawn (unexpected — spawn should have thrown)');

    const id = this.nextId++;

    return new Promise<Float32Array[]>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pendingEmbeds.delete(id);
        if (signal) signal.removeEventListener('abort', onAbort);
        try { worker.postMessage({ type: 'cancel', id }); } catch { /* worker may already be gone */ }
        reject(
          new Error(
            `onnx embed timed out after ${this.embedTimeoutMs}ms (worker thread busy or stuck — request abandoned, ` +
            'main event loop was NOT blocked while waiting)',
          ),
        );
      }, this.embedTimeoutMs);
      if (typeof (timer as NodeJS.Timeout).unref === 'function') (timer as NodeJS.Timeout).unref();

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingEmbeds.delete(id);
        try { worker.postMessage({ type: 'cancel', id }); } catch { /* worker may already be gone */ }
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      this.pendingEmbeds.set(id, {
        resolve: (vecs) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(vecs);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      });

      worker.postMessage({ type: 'embed', id, texts });
    });
  }

  /**
   * Reports worker liveness (spawns one if none exists — same lazy posture
   * as `embed()`) PLUS a real embed round-trip (no network) — relayed
   * through a dedicated `{type:'health'}` message so the worker calls its
   * OWN `OnnxEmbedProvider.health()` directly (onnx.ts's smoke-inference +
   * dim-assert logic, unchanged), rather than this proxy reimplementing
   * that check on top of `embed()`.
   */
  async health(): Promise<EmbedHealth> {
    try {
      await this.ensureWorker();
    } catch (err) {
      return { ok: false, model: this.model, dim: this.dim, error: err instanceof Error ? err.message : String(err) };
    }
    const worker = this.worker;
    if (!worker) {
      return { ok: false, model: this.model, dim: this.dim, error: 'onnx worker not running after spawn' };
    }

    const id = this.nextId++;
    return new Promise<EmbedHealth>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.pendingHealth.delete(id);
        resolve({
          ok: false,
          model: this.model,
          dim: this.dim,
          error: `onnx worker health check timed out after ${this.embedTimeoutMs}ms`,
        });
      }, this.embedTimeoutMs);
      if (typeof (timer as NodeJS.Timeout).unref === 'function') (timer as NodeJS.Timeout).unref();

      this.pendingHealth.set(id, {
        resolve: (h) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(h);
        },
      });

      worker.postMessage({ type: 'health', id });
    });
  }

  /**
   * Graceful shutdown — mirrors serve.ts's other lifecycle handles
   * (`shipper.stop()`, the job-queue `worker.stop()`). Fails any in-flight
   * request loudly (via the same `handleWorkerCrash` path a real crash
   * takes) rather than leaving it to time out, then terminates the OS
   * thread. Safe to call even if a worker was never spawned.
   */
  async terminate(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    if (!worker) return;
    this.terminating = true;
    this.handleWorkerCrash(new Error('onnx worker terminated (daemon shutdown)'));
    try {
      await worker.terminate();
    } finally {
      this.terminating = false;
    }
  }
}
