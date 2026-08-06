import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { VecSearchWorkerHost, VecSearchTimeoutError, type VecWorkerLike } from '../../src/vector/vec-search-host.js';
import type { VecHit } from '../../src/contracts/index.js';

/** In-process fake worker — mirrors the protocol without an OS thread. */
class FakeWorker implements VecWorkerLike {
  handlers: Record<string, ((...args: never[]) => void)[]> = {};
  posted: Array<{ id: number; vec: ArrayBuffer; k: number }> = [];
  terminated = false;
  constructor(private readonly behavior: 'ok' | 'silent' | 'req-error' | 'crash-on-search' = 'ok') {}
  postMessage(value: unknown): void {
    const msg = value as { id: number; vec: ArrayBuffer; k: number };
    this.posted.push(msg);
    if (this.behavior === 'ok') {
      queueMicrotask(() => this.emit('message', { id: msg.id, rows: [{ id: 'atom-1', distance: 1 }] }));
    } else if (this.behavior === 'req-error') {
      queueMicrotask(() => this.emit('message', { id: msg.id, error: 'boom in worker' }));
    } else if (this.behavior === 'crash-on-search') {
      queueMicrotask(() => this.emit('error', new Error('worker crashed')));
    }
    // 'silent': never answers — exercises the search timeout.
  }
  on(event: string, listener: (...args: never[]) => void): this {
    (this.handlers[event] ??= []).push(listener);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.handlers[event] ?? []) (l as (...a: unknown[]) => void)(...args);
  }
  ready(): void {
    this.emit('message', { type: 'ready' });
  }
  terminate(): void {
    this.terminated = true;
  }
}

function makeHost(worker: FakeWorker, extra?: Partial<ConstructorParameters<typeof VecSearchWorkerHost>[0]>) {
  const fallbackHits: VecHit[] = [{ id: 'fallback-atom', score: 0.5 }];
  let fallbackCalls = 0;
  const host = new VecSearchWorkerHost({
    dbPath: 'unused.sqlite',
    fallback: async () => { fallbackCalls++; return fallbackHits; },
    workerFactory: () => {
      // ready arrives right after construction, as the real worker does
      queueMicrotask(() => worker.ready());
      return worker;
    },
    spawnTimeoutMs: 500,
    searchTimeoutMs: 300,
    ...extra,
  });
  return { host, fallbackHits, getFallbackCalls: () => fallbackCalls };
}

const vec = new Float32Array(4).fill(0.5);

describe('VecSearchWorkerHost', () => {
  it('serves hits from the worker with the SqliteVecStore score mapping (1/(1+distance))', async () => {
    const { host } = makeHost(new FakeWorker('ok'));
    const hits = await host.search(vec, 5);
    expect(hits).toEqual([{ id: 'atom-1', score: 0.5 }]); // distance 1 -> 0.5
  });

  it('copies the query vector instead of transferring — caller buffer stays usable', async () => {
    const w = new FakeWorker('ok');
    const { host } = makeHost(w);
    await host.search(vec, 3);
    expect(vec[0]).toBe(0.5); // not detached
    expect(w.posted[0]!.k).toBe(3);
  });

  it('falls back on a per-request worker error and counts it', async () => {
    const { host, fallbackHits, getFallbackCalls } = makeHost(new FakeWorker('req-error'));
    const hits = await host.search(vec, 5);
    expect(hits).toBe(fallbackHits);
    expect(getFallbackCalls()).toBe(1);
    expect(host.fallbackCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Search timeout: THROW, never fall back.
  //
  // This reverses the original behaviour (which fell back to the synchronous
  // main-thread scan on a search timeout, same as every other failure). The
  // fallback runs the SAME query that just blew the timeout, on the event loop
  // — so it blocks for at least that long. Measured 2026-08-05: 30 occurrences
  // of `vec search timed out after 30000ms`, 30-64s event-loop blocks
  // (el_p99 ~70ms, el_max 64,391ms) on an IDLE box at 17% CPU, a 450,015ms gap
  // in the 30s spool-drain tick, and watchdog kills of a daemon that really was
  // unresponsive. Failing one search (callers degrade to FTS-only) is far
  // cheaper than freezing capture, sync, jobs and doctor for a minute.
  //
  // Infrastructure failures still fall back — see the tests above/below.
  // ---------------------------------------------------------------------------
  it('throws VecSearchTimeoutError on search timeout instead of blocking the loop with a fallback scan', async () => {
    const { host, getFallbackCalls } = makeHost(new FakeWorker('silent'));

    await expect(host.search(vec, 5)).rejects.toBeInstanceOf(VecSearchTimeoutError);

    expect(getFallbackCalls()).toBe(0); // the whole point: no main-thread scan
    expect(host.fallbackCount).toBe(0);
    expect(host.searchTimeoutCount).toBe(1);
  });

  it('carries the timeout budget on the error so callers need not string-match', async () => {
    const { host } = makeHost(new FakeWorker('silent'));

    await expect(host.search(vec, 5)).rejects.toMatchObject({
      name: 'VecSearchTimeoutError',
      timeoutMs: 300,
    });
  });

  it('counts timeouts separately from fallbacks — they mean opposite things', async () => {
    // A timeout means the offload WORKED and the query is too slow; a fallback
    // means the offload itself failed. Conflating them hides which is happening.
    const { host } = makeHost(new FakeWorker('silent'));
    await expect(host.search(vec, 5)).rejects.toBeInstanceOf(VecSearchTimeoutError);
    await expect(host.search(vec, 5)).rejects.toBeInstanceOf(VecSearchTimeoutError);

    expect(host.searchTimeoutCount).toBe(2);
    expect(host.fallbackCount).toBe(0);
  });

  it('still falls back when the worker is unavailable — infrastructure failure, query not implicated', async () => {
    // Spawn failure is the case the fallback exists for: nothing has shown the
    // QUERY to be slow, only that the worker could not be started.
    const fallbackHits: VecHit[] = [{ id: 'fb-spawn', score: 0.25 }];
    let fallbackCalls = 0;
    const host = new VecSearchWorkerHost({
      dbPath: 'unused.sqlite',
      fallback: async () => { fallbackCalls++; return fallbackHits; },
      workerFactory: () => { throw new Error('worker module missing'); },
      spawnTimeoutMs: 200,
      searchTimeoutMs: 300,
    });

    const hits = await host.search(vec, 5);

    expect(hits).toBe(fallbackHits);
    expect(fallbackCalls).toBe(1);
    expect(host.fallbackCount).toBe(1);
    expect(host.searchTimeoutCount).toBe(0);
  });

  it('falls back on worker crash and respawns on the next call', async () => {
    let spawned = 0;
    const workers = [new FakeWorker('crash-on-search'), new FakeWorker('ok')];
    const fallbackHits: VecHit[] = [{ id: 'fb', score: 0.1 }];
    const host = new VecSearchWorkerHost({
      dbPath: 'unused.sqlite',
      fallback: async () => fallbackHits,
      workerFactory: () => {
        const w = workers[spawned++]!;
        queueMicrotask(() => w.ready());
        return w;
      },
      spawnTimeoutMs: 500,
      searchTimeoutMs: 300,
    });
    const first = await host.search(vec, 5);
    expect(first).toBe(fallbackHits); // crash -> fallback
    const second = await host.search(vec, 5);
    expect(second).toEqual([{ id: 'atom-1', score: 0.5 }]); // respawned worker serves
    expect(spawned).toBe(2);
  });

  it('stop() terminates the worker without logging it as a crash', async () => {
    const w = new FakeWorker('ok');
    const { host } = makeHost(w);
    await host.search(vec, 1);
    await host.stop();
    expect(w.terminated).toBe(true);
  });
});

/**
 * Integration: a REAL worker thread against a real plaintext DB — proves the
 * end-to-end wiring (open, sqlite-vec load, prepared KNN, protocol) matches
 * the in-process store. Needs built output (dist/) for the worker script,
 * same convention as the repo's other dist-dependent tests.
 */
const distWorker = resolve(__dirname, '../../dist/vector/vec-search-worker.js');
describe.skipIf(!existsSync(distWorker))('VecSearchWorkerHost (real worker, real DB)', () => {
  let dir: string;
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* win32 lag */ } });

  it('returns the same hits as the synchronous SqliteVecStore', async () => {
    dir = mkdtempSync(join(tmpdir(), 'astramem-vecworker-'));
    const dbPath = join(dir, 'memory.sqlite');
    const { openDb } = await import('../../src/storage/db.js');
    const db = openDb(dbPath);
    db.exec(`
      CREATE TABLE memories (id TEXT PRIMARY KEY);
      CREATE VIRTUAL TABLE memories_vec USING vec0(embedding FLOAT[4]);
    `);
    const { SqliteVecStore } = await import('../../src/vector/sqlite-vec.js');
    const store = new SqliteVecStore(db, 4);
    const mk = (id: string, v: number[]) => {
      db.prepare('INSERT INTO memories (id) VALUES (?)').run(id);
      return store.upsert(id, new Float32Array(v));
    };
    await mk('near', [1, 0, 0, 0]);
    await mk('far', [0, 0, 0, 1]);
    const q = new Float32Array([0.9, 0.1, 0, 0]);
    const syncHits = await store.search(q, 2);

    const host = new VecSearchWorkerHost({
      dbPath,
      fallback: async () => { throw new Error('fallback must not be used in this test'); },
      workerPath: distWorker,
    });
    try {
      const workerHits = await host.search(q, 2);
      expect(workerHits).toEqual(syncHits);
      expect(workerHits[0]!.id).toBe('near');
      expect(host.fallbackCount).toBe(0);
    } finally {
      await host.stop();
      db.close();
    }
  });
});
