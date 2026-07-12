import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnProxy, killProxy, resolveProxyEntry, type ProxyHandle } from './proxy-driver.js';
import { startUpstreamStub, type UpstreamStubHandle } from './upstream-stub.js';
import { checkPortOwner } from '../../shared/daemon-manifest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PROXY_CLI = join(HERE, '__fixtures__', 'fake-proxy-cli.mjs');

describe('resolveProxyEntry', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('returns the explicit path when it exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'proxy-entry-test-'));
    const entry = join(dir, 'index.js');
    writeFileSync(entry, '// stub', 'utf8');
    expect(resolveProxyEntry(entry, dir)).toBe(entry);
  });

  it('returns undefined for an explicit path that does not exist', () => {
    expect(resolveProxyEntry(join(tmpdir(), 'definitely-not-here-12345.js'), tmpdir())).toBeUndefined();
  });

  it('falls back to <repoRoot>/dist/cli/index.js when no explicit path is given', () => {
    dir = mkdtempSync(join(tmpdir(), 'proxy-entry-test-'));
    expect(resolveProxyEntry(undefined, dir)).toBeUndefined();
    const distDir = join(dir, 'dist', 'cli');
    mkdirSync(distDir, { recursive: true });
    const entry = join(distDir, 'index.js');
    writeFileSync(entry, '// stub', 'utf8');
    expect(resolveProxyEntry(undefined, dir)).toBe(entry);
  });
});

describe('spawnProxy / killProxy — lifecycle against the fake proxy CLI fixture', () => {
  let stub: UpstreamStubHandle | undefined;
  let proxy: ProxyHandle | undefined;

  afterEach(async () => {
    if (proxy) await killProxy(proxy);
    if (stub) await stub.close();
    proxy = undefined;
    stub = undefined;
  });

  it('boots on an ephemeral port, relays a request to upstream, and reports pid/baseUrl', async () => {
    stub = await startUpstreamStub({ bodySize: 64 });
    proxy = await spawnProxy({ entry: FAKE_PROXY_CLI, upstream: stub.baseUrl });

    expect(proxy.pid).toBeGreaterThan(0);
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.baseUrl).toBe(`http://127.0.0.1:${proxy.port}`);

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(64);
    expect(stub.requestCount()).toBe(1);
  });

  it('rejects when the CLI never prints a boot line (e.g. missing --upstream)', async () => {
    await expect(spawnProxy({ entry: FAKE_PROXY_CLI, upstream: '', port: 0 })).rejects.toThrow();
  });

  it('killProxy leaves zero orphan PIDs — the port is unbound after teardown', async () => {
    stub = await startUpstreamStub();
    proxy = await spawnProxy({ entry: FAKE_PROXY_CLI, upstream: stub.baseUrl });
    const port = proxy.port;
    const pid = proxy.pid!;

    const beforeKill = checkPortOwner(port);
    expect(beforeKill.ok).toBe(true);
    if (beforeKill.ok) expect(beforeKill.pid).toBe(pid);

    await killProxy(proxy);
    proxy = undefined; // already torn down; afterEach must not double-kill

    // Poll briefly — SIGTERM -> server.close() is asynchronous.
    const deadline = Date.now() + 5_000;
    let stillBound = true;
    while (Date.now() < deadline) {
      const check = checkPortOwner(port);
      stillBound = check.ok ? check.pid !== undefined : true;
      if (!stillBound) break;
      await new Promise(r => setTimeout(r, 100));
    }
    expect(stillBound).toBe(false);
  });

  it('killProxy on an already-exited process is a safe no-op', async () => {
    stub = await startUpstreamStub();
    proxy = await spawnProxy({ entry: FAKE_PROXY_CLI, upstream: stub.baseUrl });
    await killProxy(proxy);
    await expect(killProxy(proxy)).resolves.toBeUndefined();
    proxy = undefined;
  });
});

describe('proxy module absence — the harness must degrade cleanly, never throw', () => {
  it('resolveProxyEntry returns undefined (not an error) when nothing is built yet', () => {
    const missingRoot = mkdtempSync(join(tmpdir(), 'no-proxy-built-'));
    try {
      expect(resolveProxyEntry(undefined, missingRoot)).toBeUndefined();
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
    }
  });
});
