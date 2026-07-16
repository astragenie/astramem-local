/**
 * FEAT-533: `distill.atomTriage` governance must run on the REAL boot path
 * (`loadConfigFromDisk`), not just inside the standalone
 * `applyAtomTriageGovernance` unit tests (tests/config/config.test.ts). The
 * loader.ts doc comment for `applyContradictionDetectionGovernance`/
 * `applyExtractionPassBGovernance` records a real incident class this test
 * guards against: a governance function that only ever ran inside
 * `loadConfig()` (zero production callers) let an out-of-union provider
 * value reach `buildLLMProvider`'s throwing Azure fall-through DURING BOOT.
 * `applyAtomTriageGovernance` is wired into `loadConfigFromDisk`'s chain
 * from the start (src/config/loader.ts) — this test proves that wiring
 * against the real file-read + deep-merge path, not a hand-called unit.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/config.js';
import { configToYaml } from '../../src/config/writer.js';
import { loadConfigFromDisk } from '../../src/config/loader.js';

describe('FEAT-533: distill.atomTriage governance runs on the real loadConfigFromDisk boot path', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('an invalid distill.atomTriage.mode on disk is dropped to "off", never reaches the running config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-atom-triage-boot-'));
    tmpDirs.push(dir);

    const cfg = defaultConfig();
    (cfg.distill.atomTriage as unknown as Record<string, unknown>).mode = 'enable'; // typo
    writeFileSync(join(dir, 'config.yaml'), configToYaml(cfg), 'utf8');

    const loaded = loadConfigFromDisk(dir);
    expect(loaded.distill.atomTriage.mode).toBe('off');
  });

  it('an invalid distill.atomTriage.provider on disk is dropped (not fatal) rather than reaching buildLLMProvider at boot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-atom-triage-boot-provider-'));
    tmpDirs.push(dir);

    // Hand-written YAML, not round-tripped through configToYaml: the
    // provider/model override is a hand-edit-only field writer.ts never
    // emits (same convention consolidation.contradictionDetection's own
    // provider/model override already has — see writer.ts). This test is
    // about what the LOADER does with a hand-edited file, so it has to
    // actually put `provider`/`model` on disk itself.
    writeFileSync(
      join(dir, 'config.yaml'),
      'distill:\n' +
      '  atomTriage:\n' +
      '    mode: dry-run\n' +
      "    provider: olama\n" + // typo — not in the closed union
      "    model: 'qwen2.5:7b'\n" +
      '    batchSize: 20\n' +
      '    maxPerRun: 200\n' +
      '    maxWallClockMs: 300000\n',
      'utf8',
    );

    let loaded: ReturnType<typeof loadConfigFromDisk> | undefined;
    expect(() => { loaded = loadConfigFromDisk(dir); }).not.toThrow();
    expect(loaded!.distill.atomTriage.mode).toBe('dry-run'); // valid mode survives
    expect(loaded!.distill.atomTriage.provider).toBeUndefined(); // typo'd provider dropped
    expect(loaded!.distill.atomTriage.model).toBe('qwen2.5:7b'); // model half kept
  });

  it('a config.yaml with no atomTriage block at all loads cleanly with the documented off default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-atom-triage-boot-absent-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'config.yaml'), 'port: 7777\n', 'utf8');

    const loaded = loadConfigFromDisk(dir);
    expect(loaded.distill.atomTriage.mode).toBe('off');
    expect(loaded.distill.atomTriage.batchSize).toBe(20);
  });
});
