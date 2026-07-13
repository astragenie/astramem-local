/**
 * FEAT-458 S2 — config downgrade compatibility (S1 design doc §2.2, DEC-008
 * lesson): `proxy` is a wholly new NESTED OBJECT (not a new scalar under an
 * existing key), so a `reinstall --rollback` to a pre-FEAT-458 build must
 * not crash when its loader encounters a `proxy:` block in an otherwise-
 * untouched config.yaml.
 *
 * `git diff v0.13.0 HEAD -- src/config/loader.ts` is empty — the merge
 * algorithm (parseConfigYaml + deepMerge) is byte-identical to the last
 * tagged release, so the only thing that changed is `defaultConfig()`
 * gaining a `proxy` key. Mocking just `defaultConfig()` back to its
 * pre-FEAT-458 shape (no `proxy` key at all) therefore reconstructs exactly
 * what the OLD loader saw, while still exercising the REAL, unmodified
 * `loadConfigFromDisk`/`parseConfigYaml`/deepMerge code path — not a copy of
 * it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/config.js';
import { configToYaml } from '../../src/config/writer.js';

describe('FEAT-458 S2: proxy config block does not break a pre-FEAT-458 loader', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.doUnmock('../../src/config/config.js');
    vi.resetModules();
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('a config.yaml with a proxy: block loads without throwing against a defaultConfig() that has no proxy key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-proxy-downgrade-'));
    tmpDirs.push(dir);

    const cfgWithProxy = defaultConfig();
    cfgWithProxy.proxy = {
      enabled: true,
      port: 7778,
      upstream: 'https://api.openai.com/v1',
      upstreamTimeoutMs: 30_000,
      capture: { enabled: false },
    };
    const yaml = configToYaml(cfgWithProxy);
    expect(yaml).toContain('proxy:');
    writeFileSync(join(dir, 'config.yaml'), yaml, 'utf8');

    vi.resetModules();
    vi.doMock('../../src/config/config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config/config.js')>('../../src/config/config.js');
      const oldStyleDefault = actual.defaultConfig() as unknown as Record<string, unknown>;
      delete oldStyleDefault.proxy; // simulate the pre-FEAT-458 Config shape
      return { ...actual, defaultConfig: () => oldStyleDefault };
    });

    const { loadConfigFromDisk } = await import('../../src/config/loader.js');

    let loaded: Record<string, unknown> | undefined;
    expect(() => { loaded = loadConfigFromDisk(dir) as unknown as Record<string, unknown>; }).not.toThrow();

    // The rest of the config survives intact — the unrecognized top-level
    // key doesn't corrupt sibling fields.
    expect(loaded?.port).toBe(cfgWithProxy.port);
    expect((loaded?.capture as { autoCapture: { enabled: boolean } }).autoCapture.enabled).toBe(false);

    // The old loader's deepMerge adds an unrecognized top-level key as an
    // opaque extra property rather than dropping it (see loader.ts's own
    // "Unknown keys are ignored" — true in effect, since nothing in a
    // pre-FEAT-458 binary ever reads `.proxy`, even though it lands on the
    // object). Confirms the mechanism, not just the absence of a crash.
    expect(loaded?.proxy).toEqual({
      enabled: true,
      port: 7778,
      upstream: 'https://api.openai.com/v1',
      upstreamTimeoutMs: 30_000,
      capture: { enabled: false },
    });
  });

  it('a config.yaml with NO proxy block still loads cleanly against the OLD defaultConfig() shape (baseline, no regression)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-proxy-downgrade-baseline-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'config.yaml'), 'port: 7777\n', 'utf8');

    vi.resetModules();
    vi.doMock('../../src/config/config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config/config.js')>('../../src/config/config.js');
      const oldStyleDefault = actual.defaultConfig() as unknown as Record<string, unknown>;
      delete oldStyleDefault.proxy;
      return { ...actual, defaultConfig: () => oldStyleDefault };
    });

    const { loadConfigFromDisk } = await import('../../src/config/loader.js');
    let loaded: Record<string, unknown> | undefined;
    expect(() => { loaded = loadConfigFromDisk(dir) as unknown as Record<string, unknown>; }).not.toThrow();
    expect(loaded?.port).toBe(7777);
    expect(loaded?.proxy).toBeUndefined();
  });
});
