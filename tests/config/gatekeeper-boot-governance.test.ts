/**
 * FEAT-548: `distill.gatekeeper` governance must run on the REAL boot path
 * (`loadConfigFromDisk`), not just inside the standalone
 * `applyGatekeeperGovernance` unit tests (tests/config/config.test.ts). Mirrors
 * tests/config/atom-triage-boot-governance.test.ts exactly — same incident
 * class: a governance function that only ever ran inside `loadConfig()`
 * (zero production callers) let an out-of-union provider value reach
 * `buildLLMProvider`'s throwing Azure fall-through DURING BOOT.
 * `applyGatekeeperGovernance` is wired into BOTH `loadConfig` (config.ts) and
 * `loadConfigFromDisk` (src/config/loader.ts) — this test proves the loader
 * wiring against the real file-read + deep-merge path, not a hand-called unit.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig } from '../../src/config/config.js';
import { configToYaml } from '../../src/config/writer.js';
import { loadConfigFromDisk } from '../../src/config/loader.js';

describe('FEAT-548: distill.gatekeeper governance runs on the real loadConfigFromDisk boot path', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('an invalid distill.gatekeeper.mode on disk is dropped to "off", never reaches the running config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-gatekeeper-boot-'));
    tmpDirs.push(dir);

    const cfg = defaultConfig();
    (cfg.distill.gatekeeper as unknown as Record<string, unknown>).mode = 'enable'; // typo
    writeFileSync(join(dir, 'config.yaml'), configToYaml(cfg), 'utf8');

    const loaded = loadConfigFromDisk(dir);
    expect(loaded.distill.gatekeeper.mode).toBe('off');
  });

  it('an invalid distill.gatekeeper.provider on disk is dropped (not fatal) rather than reaching buildLLMProvider at boot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-gatekeeper-boot-provider-'));
    tmpDirs.push(dir);

    // Hand-written YAML, not round-tripped through configToYaml: the
    // provider/model override is a hand-edit-only field writer.ts never
    // emits (same convention distill.atomTriage's own provider/model
    // override already has — see writer.ts). This test is about what the
    // LOADER does with a hand-edited file, so it has to actually put
    // `provider`/`model` on disk itself.
    writeFileSync(
      join(dir, 'config.yaml'),
      'distill:\n' +
      '  gatekeeper:\n' +
      '    mode: dry-run\n' +
      "    provider: olama\n" + // typo — not in the closed union
      "    model: 'phi4-mini'\n" +
      '    batchSize: 20\n' +
      '    maxPerRun: 200\n' +
      '    maxWallClockMs: 300000\n',
      'utf8',
    );

    let loaded: ReturnType<typeof loadConfigFromDisk> | undefined;
    expect(() => { loaded = loadConfigFromDisk(dir); }).not.toThrow();
    expect(loaded!.distill.gatekeeper.mode).toBe('dry-run'); // valid mode survives
    expect(loaded!.distill.gatekeeper.provider).toBeUndefined(); // typo'd provider dropped
    expect(loaded!.distill.gatekeeper.model).toBe('phi4-mini'); // model half kept
  });

  it('a config.yaml with no gatekeeper block at all loads cleanly with the documented off default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-gatekeeper-boot-absent-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'config.yaml'), 'port: 7777\n', 'utf8');

    const loaded = loadConfigFromDisk(dir);
    expect(loaded.distill.gatekeeper.mode).toBe('off');
    expect(loaded.distill.gatekeeper.batchSize).toBe(20);
  });

  it('loadConfig() (config.ts) also applies gatekeeper governance — the 550/549 reviewers\' "both real paths" bar', () => {
    const cfg = loadConfig({ distill: { ...defaultConfig().distill, gatekeeper: { mode: 'bogus' as any, batchSize: 20, maxPerRun: 200, maxWallClockMs: 300_000 } } } as any);
    expect(cfg.distill.gatekeeper.mode).toBe('off');
  });
});
