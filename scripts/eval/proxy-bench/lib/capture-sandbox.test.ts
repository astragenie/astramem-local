/**
 * capture-sandbox.ts's own behavior, independent of bench.mts: does the
 * sandboxed config.yaml actually flip `proxy.capture.enabled` for the
 * spawned proxy, and does it leave the real OS config dir untouched?
 *
 * The capture-on/off assertions talk to the REAL built proxy CLI (not the
 * fake-proxy-cli.mjs fixture, which doesn't read config.yaml at all) — skips
 * cleanly, never fails the suite, when dist/cli/index.js isn't built yet
 * (same precedent as bench.test.ts's final describe block).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProxySandbox, type ProxySandbox } from './capture-sandbox.js';
import { spawnProxy, killProxy, resolveProxyEntry, type ProxyHandle } from './proxy-driver.js';
import { startUpstreamStub, type UpstreamStubHandle } from './upstream-stub.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const realProxyEntry = resolveProxyEntry(undefined, REPO_ROOT);

describe('makeProxySandbox — config.yaml contents and isolation', () => {
  let sandbox: ProxySandbox | undefined;
  afterEach(() => { sandbox?.cleanup(); sandbox = undefined; });

  it('writes proxy.capture.enabled: true into the sandboxed config dir when requested', () => {
    sandbox = makeProxySandbox('capture-sandbox-test', true);
    const yaml = readFileSync(join(sandbox.configDir, 'config.yaml'), 'utf8');
    expect(yaml).toMatch(/proxy:\s*\n\s*capture:\s*\n\s*enabled: true/);
  });

  it('writes proxy.capture.enabled: false (matching the shipped default) when not requested', () => {
    sandbox = makeProxySandbox('capture-sandbox-test', false);
    const yaml = readFileSync(join(sandbox.configDir, 'config.yaml'), 'utf8');
    expect(yaml).toMatch(/proxy:\s*\n\s*capture:\s*\n\s*enabled: false/);
  });

  it('every sandbox gets a fresh, distinct root/configDir/dataDir (no cross-run leakage)', () => {
    const a = makeProxySandbox('capture-sandbox-test', false);
    const b = makeProxySandbox('capture-sandbox-test', false);
    try {
      expect(a.root).not.toBe(b.root);
      expect(a.configDir).not.toBe(b.configDir);
      expect(a.dataDir).not.toBe(b.dataDir);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('cleanup() removes the sandbox root entirely', () => {
    sandbox = makeProxySandbox('capture-sandbox-test', false);
    const root = sandbox.root;
    expect(existsSync(root)).toBe(true);
    sandbox.cleanup();
    expect(existsSync(root)).toBe(false);
    sandbox = undefined;
  });

  it('never mutates process.env beyond the call — real APPDATA/HOME are restored', () => {
    const before = { ...process.env };
    sandbox = makeProxySandbox('capture-sandbox-test', true);
    for (const key of ['APPDATA', 'LOCALAPPDATA', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'ASTRA_MEMORY_DATADIR']) {
      expect(process.env[key]).toBe(before[key]);
    }
  });
});

describe.skipIf(!realProxyEntry)('makeProxySandbox — end-to-end against the real built proxy CLI', () => {
  let sandbox: ProxySandbox | undefined;
  let stub: UpstreamStubHandle | undefined;
  let proxy: ProxyHandle | undefined;

  afterEach(async () => {
    if (proxy) await killProxy(proxy);
    if (stub) await stub.close();
    sandbox?.cleanup();
    proxy = undefined;
    stub = undefined;
    sandbox = undefined;
  });

  it('capture-on sandbox: the spawned proxy logs "capture is ON"', async () => {
    sandbox = makeProxySandbox('capture-sandbox-e2e-on', true);
    stub = await startUpstreamStub();
    proxy = await spawnProxy({ entry: realProxyEntry!, upstream: stub.baseUrl, env: sandbox.env });
    // The boot log's capture line is printed on the tick right after the
    // "serving on" line this handle already waited for — give it a moment.
    await new Promise(r => setTimeout(r, 200));
    expect(proxy.stdout()).toMatch(/capture is ON \(capture_source=proxy\)/);
  });

  it('capture-off sandbox: the spawned proxy does NOT log "capture is ON"', async () => {
    sandbox = makeProxySandbox('capture-sandbox-e2e-off', false);
    stub = await startUpstreamStub();
    proxy = await spawnProxy({ entry: realProxyEntry!, upstream: stub.baseUrl, env: sandbox.env });
    await new Promise(r => setTimeout(r, 200));
    expect(proxy.stdout()).not.toMatch(/capture is ON/);
  });
});
