import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once, type EventEmitter } from 'node:events';
import pino from 'pino';
import { createServiceLogStream } from '../../src/log/logger.js';

type ServiceStream = ReturnType<typeof createServiceLogStream>;

/** sync:false opens the fd asynchronously — flushSync before 'ready' throws.
 *  Production never flushSyncs (pino buffers until ready — the point of the
 *  non-blocking design); tests must await readiness to assert file contents. */
async function readyStream(dir: string, opts?: Parameters<typeof createServiceLogStream>[1]): Promise<ServiceStream> {
  const dest = createServiceLogStream(dir, opts);
  await once(dest as unknown as EventEmitter, 'ready');
  return dest;
}

/**
 * Regression guard for the 2026-07-15 daemon-freeze incident: service-mode
 * logging must be an IN-PROCESS destination (SonicBoom), never a worker-thread
 * transport (pino-roll / thread-stream) — thread-stream's write path blocks
 * the main thread in Atomics.wait when its ring buffer fills and the worker
 * stalls, freezing the whole event loop (observed live: 23+ min, 0 CPU).
 */
describe('createServiceLogStream', () => {
  let dir: string;
  const streams: ServiceStream[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astramem-logstream-'));
  });
  afterEach(() => {
    // destroy streams BEFORE removing the dir — the async opener / rotate
    // timer must not race a deleted directory (ENOENT mkdir noise).
    for (const s of streams.splice(0)) { try { (s as unknown as { destroy: () => void }).destroy(); } catch { /* already closed */ } }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* win32 handle lag */ }
  });

  it('is an in-process SonicBoom destination, not a worker-thread transport', async () => {
    const dest = await readyStream(dir);
    streams.push(dest);
    // SonicBoom exposes reopen/flushSync on the stream object itself; a
    // thread-stream transport does not satisfy this shape in-process.
    expect(typeof dest.reopen).toBe('function');
    expect(typeof dest.flushSync).toBe('function');
    expect(dest.constructor.name).toBe('SonicBoom');
  });

  it('writes parseable pino JSON lines to daemon.live.log, visible after flushSync (no worker round-trip)', async () => {
    const dest = await readyStream(dir);
    streams.push(dest);
    const log = pino({}, dest);
    log.info({ probe: 42 }, 'stream smoke');
    dest.flushSync();
    const live = join(dir, 'daemon.live.log');
    const lines = readFileSync(live, 'utf8').trim().split('\n');
    const parsed = JSON.parse(lines[lines.length - 1]!);
    expect(parsed.msg).toBe('stream smoke');
    expect(parsed.probe).toBe(42);
    expect(typeof parsed.time).toBe('number');
  });

  it('rotates the live file past maxBytes and recreates it, keeping writes flowing', async () => {
    const dest = await readyStream(dir, { maxBytes: 2048, checkMs: 40 });
    streams.push(dest);
    const log = pino({}, dest);
    const fat = 'x'.repeat(256);
    for (let i = 0; i < 20; i++) log.info({ i, fat }, 'fill');
    dest.flushSync();
    // wait for at least one rotation sweep
    await new Promise(r => setTimeout(r, 250));
    const rotated = readdirSync(dir).filter(n => /^daemon\.live\.\d+\.log$/.test(n));
    expect(rotated.length).toBeGreaterThanOrEqual(1);
    // live file must be recreated and still writable after rotation.
    // SonicBoom's reopen() (called by the rotation sweep) is asynchronous: a
    // write issued while the reopen is in flight is buffered and lands on the
    // NEW fd slightly later, so a one-shot read here races it (flaked on the
    // Linux CI runner). Poll bounded instead of reading once.
    log.info({ post: true }, 'after rotation');
    const live = join(dir, 'daemon.live.log');
    let liveContent = '';
    for (let attempt = 0; attempt < 50; attempt++) {
      try { dest.flushSync(); } catch { /* reopen in flight — retry */ }
      if (existsSync(live)) {
        liveContent = readFileSync(live, 'utf8');
        if (liveContent.includes('after rotation')) break;
      }
      await new Promise(r => setTimeout(r, 40));
    }
    expect(existsSync(live)).toBe(true);
    expect(liveContent).toContain('after rotation');
  });

  it('prunes rotated copies beyond keep, never touching the live file', async () => {
    // Pre-seed 7 fake rotated files with ascending stamps.
    for (let i = 1; i <= 7; i++) {
      writeFileSync(join(dir, `daemon.live.${1000 + i}.log`), 'old');
    }
    const dest = await readyStream(dir, { maxBytes: 512, keep: 3, checkMs: 40 });
    streams.push(dest);
    const log = pino({}, dest);
    const fat = 'y'.repeat(300);
    for (let i = 0; i < 5; i++) log.info({ i, fat }, 'fill');
    dest.flushSync();
    await new Promise(r => setTimeout(r, 250));
    const rotated = readdirSync(dir).filter(n => /^daemon\.live\.\d+\.log$/.test(n));
    expect(rotated.length).toBeLessThanOrEqual(3);
    expect(existsSync(join(dir, 'daemon.live.log'))).toBe(true);
  });

  it('dashboard log discovery matches the new filenames (daemon.*.log shape)', () => {
    // Mirror of dashboard-logs-html.ts's discovery regex — keep in lock-step.
    const discovery = /^daemon\.[^/\\]*\.log$/;
    expect(discovery.test('daemon.live.log')).toBe(true);
    expect(discovery.test(`daemon.live.${Date.now()}.log`)).toBe(true);
    expect(discovery.test('daemon.1.log')).toBe(true); // legacy pino-roll files
  });
});
