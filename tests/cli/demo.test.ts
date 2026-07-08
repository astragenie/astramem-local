/**
 * tests/cli/demo.test.ts
 *
 * `astramem-local demo` forces its own isolation env (ASTRA_MEMORY_ISOLATED,
 * ASTRA_MEMORY_DATADIR=':memory:', ASTRA_MEMORY_MOCK_PROVIDERS) and picks its
 * own free port internally, then keeps a live daemon running until Ctrl+C —
 * so, like tests/cli/serve.test.ts, the only reliable way to exercise the
 * full end-to-end path is to spawn the built CLI as a child process and
 * assert on its stdout (and clean it up with SIGTERM afterwards).
 *
 * The seeding/recall wiring itself (`seedDemoMemories`/`runSampleRecall`) is
 * also unit-tested directly against a stubbed `fetch` — faster and hermetic,
 * and it pins down the exact request shape (endpoint, method, headers, body)
 * independent of a real daemon being up.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DEMO_SEED_MEMORIES,
  DEMO_SAMPLE_QUESTION,
  getFreePort,
  seedDemoMemories,
  runSampleRecall,
} from '../../src/cli/demo.js';

describe('DEMO_SEED_MEMORIES', () => {
  it('seeds between 4 and 5 example memories with non-empty text and a valid type', () => {
    expect(DEMO_SEED_MEMORIES.length).toBeGreaterThanOrEqual(4);
    expect(DEMO_SEED_MEMORIES.length).toBeLessThanOrEqual(5);
    for (const mem of DEMO_SEED_MEMORIES) {
      expect(mem.text.length).toBeGreaterThan(0);
      expect(mem.type.length).toBeGreaterThan(0);
    }
  });

  it('every seed type is a member of the canonical MEMORY_TYPES union', async () => {
    const { MEMORY_TYPES } = await import('../../src/contracts/memory.js');
    for (const mem of DEMO_SEED_MEMORIES) {
      expect(MEMORY_TYPES as readonly string[]).toContain(mem.type);
    }
  });
});

describe('getFreePort', () => {
  it('returns a usable, nonzero loopback port', async () => {
    const port = await getFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  it('returns a different port across concurrent calls (no obvious collision)', async () => {
    const [a, b] = await Promise.all([getFreePort(), getFreePort()]);
    expect(a).not.toBe(b);
  });
});

// ─── seeding + recall wiring, against a stubbed fetch ──────────────────────

describe('seedDemoMemories', () => {
  const baseUrl = 'http://127.0.0.1:1234';
  const headers = { 'content-type': 'application/json', authorization: 'Bearer tok' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs every seed memory to /remember with the expected body and headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'x', ok: true }), { status: 200 });
    }));

    await seedDemoMemories(baseUrl, headers);

    expect(calls).toHaveLength(DEMO_SEED_MEMORIES.length);
    for (const [i, mem] of DEMO_SEED_MEMORIES.entries()) {
      const call = calls[i]!;
      expect(call.url).toBe(`${baseUrl}/remember`);
      expect(call.init.method).toBe('POST');
      expect(call.init.headers).toBe(headers);
      const body = JSON.parse(call.init.body as string);
      expect(body.text).toBe(mem.text);
      expect(body.type).toBe(mem.type);
      expect(body.metadata).toEqual({ repo: 'demo', project: 'astramem-demo' });
    }
  });

  it('logs a warning but does not throw when one seed insert fails', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      if (n === 2) return new Response('server error', { status: 500 });
      return new Response(JSON.stringify({ id: 'x', ok: true }), { status: 200 });
    }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(seedDemoMemories(baseUrl, headers)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('runSampleRecall', () => {
  const baseUrl = 'http://127.0.0.1:1234';
  const headers = { 'content-type': 'application/json', authorization: 'Bearer tok' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /recall with the sample question and returns the parsed hits', async () => {
    let capturedBody: unknown;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${baseUrl}/recall`);
      expect(init.method).toBe('POST');
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ hits: [{ text: 'dark mode preference', score: 0.9, type: 'preference' }] }), { status: 200 });
    }));

    const hits = await runSampleRecall(baseUrl, headers);

    expect(capturedBody).toEqual({ text: DEMO_SAMPLE_QUESTION, limit: 3 });
    expect(hits).toEqual([{ text: 'dark mode preference', score: 0.9, type: 'preference' }]);
  });

  it('returns an empty array and warns (does not throw) on a failed recall', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const hits = await runSampleRecall(baseUrl, headers);

    expect(hits).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─── full CLI subprocess: `node dist/cli/index.js demo` ────────────────────

describe('astramem-local demo (subprocess)', () => {
  let proc: ChildProcess | undefined;

  afterEach(async () => {
    if (proc && proc.exitCode === null && !proc.killed) {
      proc.kill('SIGTERM');
      await new Promise(resolve => proc?.on('exit', resolve));
    }
    proc = undefined;
  });

  it('boots in-memory, seeds example memories, runs a sample recall, and prints next steps', async () => {
    proc = spawn('node', ['dist/cli/index.js', 'demo'], {
      // Deliberately do NOT pre-seed ASTRA_MEMORY_ISOLATED/DATADIR/MOCK_PROVIDERS
      // here — the whole point of this test is to prove `demoCommand` sets
      // them itself, matching the CLAUDE.md "both exist" isolation contract.
      env: { ...process.env, ASTRA_MEMORY_TOKEN: undefined },
      stdio: 'pipe',
    });

    let stdout = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', () => { /* swallowed — asserted via stdout only */ });

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !stdout.includes('next: astramem-local init')) {
      await sleep(200);
      if (proc.exitCode !== null) break; // exited early — stop polling, let the assertion below fail loudly
    }

    expect(stdout, 'demo did not reach its ready line in time').toContain('next: astramem-local init');
    expect(stdout).toContain(`seeding ${DEMO_SEED_MEMORIES.length} example memories`);
    expect(stdout).toContain(DEMO_SAMPLE_QUESTION);
    expect(stdout).toContain('Press Ctrl+C to stop.');
    // At least one seed line should have made it to stdout.
    expect(stdout).toContain(DEMO_SEED_MEMORIES[0]!.text);
  }, 30_000);
});
