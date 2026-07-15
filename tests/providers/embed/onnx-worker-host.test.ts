/**
 * tests/providers/embed/onnx-worker-host.test.ts
 *
 * ADR-019 Decision 2(d) — OnnxWorkerHostProvider's orchestration logic
 * (spawn/ready handshake, message id sequencing, transfer-list buffer
 * reconstruction, timeout, AbortSignal, crash/respawn, health round-trip,
 * terminate) exercised via the `workerFactory` DI seam (mirrors
 * OnnxEmbedProvider's `loadBackend` seam in onnx.ts) — a `FakeWorker`
 * stands in for `node:worker_threads`' real `Worker`, so these tests never
 * spawn a real OS thread, never download a real model, and run in
 * milliseconds. The real-worker + real-model spawn path is covered by a
 * separate live/manual measurement (see the ADR-019 validation artifact);
 * unit tests here prove the HOST's own bookkeeping is correct regardless of
 * what's on the other end of the message channel.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { OnnxWorkerHostProvider, type OnnxWorkerLike } from '../../../src/providers/embed/onnx-worker-host.js';
import type { EmbedHealth } from '../../../src/contracts/embed.js';
import { runEmbedContractSuite } from '../_contract-suite.js';

class FakeWorker extends EventEmitter implements OnnxWorkerLike {
  posted: unknown[] = [];
  terminated = false;

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  /** Test helper: simulate the worker replying with a 'ready' message. */
  emitReady(): void {
    this.emit('message', { type: 'ready' });
  }

  private lastOfType(type: string): { id: number } {
    const last = [...this.posted].reverse().find((m) => (m as { type?: string }).type === type) as
      | { id: number }
      | undefined;
    if (!last) throw new Error(`no "${type}" message was posted`);
    return last;
  }

  /** Test helper: simulate the last posted embed request's response. */
  respondToLastEmbed(vecs: Float32Array[]): void {
    const last = this.lastOfType('embed');
    const buffers = vecs.map((v) => v.buffer) as ArrayBuffer[];
    this.emit('message', { type: 'embed-result', id: last.id, buffers }, buffers);
  }

  /** Test helper: simulate the last posted health request's response. */
  respondToLastHealth(health: EmbedHealth): void {
    const last = this.lastOfType('health');
    this.emit('message', { type: 'health-result', id: last.id, health });
  }
}

/** Auto-responding worker for the shared contract suite, which only knows
 * the generic EmbedProvider surface (embed()/health()) and can't reach into
 * this test file to drive responses manually — responds to any posted
 * 'embed'/'health' message on its own microtask turn. */
class AutoRespondWorker extends FakeWorker {
  constructor(private readonly dim: number) {
    super();
  }

  override postMessage(value: unknown): void {
    super.postMessage(value);
    const m = value as { type?: string; id?: number; texts?: string[] };
    if (m.type === 'embed') {
      const vecs = (m.texts ?? []).map((_t, i) => makeUnitVec(this.dim, i));
      const buffers = vecs.map((v) => v.buffer) as ArrayBuffer[];
      queueMicrotask(() => this.emit('message', { type: 'embed-result', id: m.id, buffers }, buffers));
    } else if (m.type === 'health') {
      queueMicrotask(() =>
        this.emit('message', {
          type: 'health-result',
          id: m.id,
          health: { ok: true, model: 'mxbai-embed-large-v1', dim: this.dim },
        }),
      );
    }
  }
}

function makeUnitVec(dim: number, seed = 0): Float32Array {
  const raw = Array.from({ length: dim }, (_, i) => Math.sin(seed + i * 0.01) + 1e-6);
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return new Float32Array(raw.map((v) => v / norm));
}

/** Builds a provider whose workerFactory hands out FakeWorkers that become
 * ready on the next microtask automatically — the common case most tests
 * want (spawn + ready handshake already proven separately). */
function providerWithAutoReadyWorker(opts: { embedTimeoutMs?: number; spawnTimeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const workerFactory = () => {
    const w = new FakeWorker();
    workers.push(w);
    queueMicrotask(() => w.emitReady());
    return w;
  };
  const provider = new OnnxWorkerHostProvider(
    { model: 'mxbai-embed-large-v1', dim: 1024 },
    { workerFactory, ...opts },
  );
  return { provider, workers };
}

describe('OnnxWorkerHostProvider (ADR-019 Decision 2(d))', () => {
  // ---------------------------------------------------------------------
  // Contract suite — same shared EmbedProvider contract every provider
  // must satisfy, exercised end-to-end through the fake worker channel.
  // ---------------------------------------------------------------------
  runEmbedContractSuite('onnx', () => {
    const workerFactory = () => {
      const w = new AutoRespondWorker(1024);
      queueMicrotask(() => w.emitReady());
      return w;
    };
    return new OnnxWorkerHostProvider({ model: 'mxbai-embed-large-v1', dim: 1024 }, { workerFactory });
  });

  describe('spawn + ready handshake', () => {
    it('spawns exactly one worker and waits for "ready" before resolving preload()', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      await provider.preload();
      expect(workers).toHaveLength(1);
    });

    it('a second preload() while one is already in flight shares the same spawn (no double-spawn)', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      await Promise.all([provider.preload(), provider.preload()]);
      expect(workers).toHaveLength(1);
    });

    it('rejects preload() when the worker never becomes ready within spawnTimeoutMs', async () => {
      const workerFactory = () => new FakeWorker(); // never emits 'ready'
      const provider = new OnnxWorkerHostProvider({}, { workerFactory, spawnTimeoutMs: 20 });
      await expect(provider.preload()).rejects.toThrow(/did not become ready/);
    });

    it('a failed spawn is not memoized — the next call spawns a fresh worker', async () => {
      let attempt = 0;
      const workers: FakeWorker[] = [];
      const workerFactory = () => {
        attempt++;
        const w = new FakeWorker();
        workers.push(w);
        if (attempt > 1) queueMicrotask(() => w.emitReady());
        return w;
      };
      const provider = new OnnxWorkerHostProvider({}, { workerFactory, spawnTimeoutMs: 20 });
      await expect(provider.preload()).rejects.toThrow(/did not become ready/);
      await provider.preload();
      expect(workers).toHaveLength(2);
    });
  });

  describe('embed() message round trip', () => {
    it('posts {type:"embed", id, texts} and resolves with Float32Array[] reconstructed from transferred buffers', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      const resultPromise = provider.embed(['hello', 'world']);
      await vi.waitFor(() => {
        expect(workers[0]?.posted.some((m) => (m as { type?: string }).type === 'embed')).toBe(true);
      });
      const w = workers[0]!;
      const embedMsg = w.posted.find((m) => (m as { type?: string }).type === 'embed') as {
        id: number;
        texts: string[];
      };
      expect(embedMsg.texts).toEqual(['hello', 'world']);
      const vecs = [makeUnitVec(1024, 1), makeUnitVec(1024, 2)];
      w.respondToLastEmbed(vecs);
      const result = await resultPromise;
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(Float32Array);
      expect(Array.from(result[0]!)).toEqual(Array.from(vecs[0]!));
      expect(Array.from(result[1]!)).toEqual(Array.from(vecs[1]!));
    });

    it('returns [] for empty input without spawning a worker', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      const result = await provider.embed([]);
      expect(result).toEqual([]);
      expect(workers).toHaveLength(0);
    });

    it('rejects immediately for an already-aborted signal without contacting the worker', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      const controller = new AbortController();
      controller.abort();
      await expect(provider.embed(['x'], controller.signal)).rejects.toThrow();
      expect(workers).toHaveLength(0);
    });

    it('surfaces an embed-error message from the worker as a rejection', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      const resultPromise = provider.embed(['x']);
      await vi.waitFor(() => expect(workers[0]?.posted.length).toBeGreaterThan(0));
      const w = workers[0]!;
      const embedMsg = w.posted.find((m) => (m as { type?: string }).type === 'embed') as { id: number };
      w.emit('message', { type: 'embed-error', id: embedMsg.id, message: 'ONNX embed produced no output vector' });
      await expect(resultPromise).rejects.toThrow('ONNX embed produced no output vector');
    });
  });

  describe('AbortSignal (thread-boundary cancellation — ADR-019, stronger than the in-process contract)', () => {
    it('rejects immediately on abort and posts a cancel message, even with no worker reply', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      const controller = new AbortController();
      const resultPromise = provider.embed(['a', 'b', 'c'], controller.signal);
      await vi.waitFor(() => expect(workers[0]?.posted.some((m) => (m as { type?: string }).type === 'embed')).toBe(true));
      controller.abort();
      await expect(resultPromise).rejects.toThrow();
      const w = workers[0]!;
      expect(w.posted.some((m) => (m as { type?: string }).type === 'cancel')).toBe(true);
    });

    it('a late worker reply after abort is discarded (no double-settle)', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      const controller = new AbortController();
      const resultPromise = provider.embed(['a'], controller.signal);
      await vi.waitFor(() => expect(workers[0]?.posted.length).toBeGreaterThan(0));
      controller.abort();
      await expect(resultPromise).rejects.toThrow();
      // Late reply must not throw / must not resolve a settled promise.
      expect(() => workers[0]!.respondToLastEmbed([makeUnitVec(1024)])).not.toThrow();
    });
  });

  describe('per-embed timeout (main-thread timer that can actually fire — ADR-019 AC)', () => {
    it('rejects after embedTimeoutMs when the worker never replies, and posts a cancel', async () => {
      const { provider, workers } = providerWithAutoReadyWorker({ embedTimeoutMs: 15 });
      await expect(provider.embed(['x'])).rejects.toThrow(/timed out/);
      const w = workers[0]!;
      expect(w.posted.some((m) => (m as { type?: string }).type === 'cancel')).toBe(true);
    });
  });

  describe('worker crash / respawn', () => {
    it('an unexpected exit rejects every in-flight embed immediately (fails loudly, does not hang)', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      const resultPromise = provider.embed(['x']);
      await vi.waitFor(() => expect(workers[0]?.posted.length).toBeGreaterThan(0));
      workers[0]!.emit('exit', 1);
      await expect(resultPromise).rejects.toThrow(/onnx worker/i);
    });

    it('the next call after a crash transparently spawns a fresh worker', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      await provider.preload();
      expect(workers).toHaveLength(1);
      workers[0]!.emit('exit', 1);

      const resultPromise = provider.embed(['x']);
      await vi.waitFor(() => {
        expect(workers).toHaveLength(2);
        expect(workers[1]?.posted.some((m) => (m as { type?: string }).type === 'embed')).toBe(true);
      });
      workers[1]!.respondToLastEmbed([makeUnitVec(1024)]);
      const result = await resultPromise;
      expect(result).toHaveLength(1);
    });

    it('a worker "error" event also crashes pending requests and triggers respawn on next call', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      await provider.preload();
      const resultPromise = provider.embed(['x']);
      await vi.waitFor(() => expect(workers[0]?.posted.some((m) => (m as { type?: string }).type === 'embed')).toBe(true));
      workers[0]!.emit('error', new Error('native ORT crash'));
      await expect(resultPromise).rejects.toThrow(/onnx worker crashed/i);

      const nextPromise = provider.embed(['y']);
      await vi.waitFor(() => {
        expect(workers).toHaveLength(2);
        expect(workers[1]?.posted.some((m) => (m as { type?: string }).type === 'embed')).toBe(true);
      });
      workers[1]!.respondToLastEmbed([makeUnitVec(1024)]);
      await expect(nextPromise).resolves.toHaveLength(1);
    });
  });

  describe('health() — dedicated {type:"health"} round trip (not reimplemented on top of embed())', () => {
    it('ok:true, relayed unchanged from the worker\'s own health-result', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      const healthPromise = provider.health();
      await vi.waitFor(() => expect(workers[0]?.posted.some((m) => (m as { type?: string }).type === 'health')).toBe(true));
      workers[0]!.respondToLastHealth({ ok: true, model: 'mxbai-embed-large-v1', dim: 1024 });
      const h = await healthPromise;
      expect(h).toEqual({ ok: true, model: 'mxbai-embed-large-v1', dim: 1024 });
    });

    it('ok:false, relayed unchanged from the worker\'s own health-result', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      const healthPromise = provider.health();
      await vi.waitFor(() => expect(workers[0]?.posted.some((m) => (m as { type?: string }).type === 'health')).toBe(true));
      workers[0]!.respondToLastHealth({
        ok: false,
        model: 'mxbai-embed-large-v1',
        dim: 1024,
        error: 'smoke inference produced dim 768, expected 1024',
      });
      const h = await healthPromise;
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/dim 768.*expected 1024/i);
    });

    it('ok:false when the worker fails to spawn', async () => {
      const workerFactory = () => new FakeWorker(); // never ready
      const provider = new OnnxWorkerHostProvider({}, { workerFactory, spawnTimeoutMs: 15 });
      const h = await provider.health();
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/did not become ready/);
    });

    it('ok:false when the worker never replies to the health request (timeout)', async () => {
      const { provider } = providerWithAutoReadyWorker({ embedTimeoutMs: 15 });
      const h = await provider.health();
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/health check timed out/);
    });
  });

  describe('terminate()', () => {
    it('rejects any in-flight embed and calls worker.terminate()', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      const resultPromise = provider.embed(['x']);
      await vi.waitFor(() => expect(workers[0]?.posted.length).toBeGreaterThan(0));
      await provider.terminate();
      await expect(resultPromise).rejects.toThrow(/onnx worker/i);
      expect(workers[0]!.terminated).toBe(true);
    });

    it('is a safe no-op when no worker was ever spawned', async () => {
      const { provider } = providerWithAutoReadyWorker();
      await expect(provider.terminate()).resolves.toBeUndefined();
    });

    it('a call after terminate() transparently respawns', async () => {
      const { provider, workers } = providerWithAutoReadyWorker();
      await provider.preload();
      await provider.terminate();
      const resultPromise = provider.embed(['x']);
      await vi.waitFor(() => {
        expect(workers).toHaveLength(2);
        expect(workers[1]?.posted.some((m) => (m as { type?: string }).type === 'embed')).toBe(true);
      });
      workers[1]!.respondToLastEmbed([makeUnitVec(1024)]);
      await expect(resultPromise).resolves.toHaveLength(1);
    });
  });
});
