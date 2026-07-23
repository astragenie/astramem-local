/**
 * Wave-3 config track: `loadConfig()` (config.ts) and `loadConfigFromDisk()`
 * (src/config/loader.ts) each used to hand-maintain their OWN copy of the
 * governance-composition chain, and the two had drifted apart twice, silently:
 *
 *  - `loadConfig()`'s chain never called `applyAtomTriageGovernance` — see
 *    the old inline comment this slice removed from config.ts's `loadConfig`.
 *  - `loadConfigFromDisk()`'s chain never called
 *    `applyExtractionPassesGovernance` — see the old inline comment this
 *    slice removed from loader.ts.
 *  - `loadConfigFromDisk()`'s chain never called `applyAudioModeGovernance`
 *    AT ALL — the real boot path had ZERO audio governance; a hand-edited
 *    out-of-union `audio.mode` reached the audio add-on's dispatch fully
 *    unvalidated. The biggest of the three, and the one existing tests
 *    (tests/config/atom-triage-boot-governance.test.ts,
 *    tests/config/gatekeeper-boot-governance.test.ts) didn't already cover.
 *
 * Both paths now call one shared `applyAllGovernance` (config.ts). This file
 * locks in the two concrete fixes on the REAL boot path
 * (`loadConfigFromDisk`, mirroring the atom-triage/gatekeeper boot-governance
 * test pattern exactly) plus a parity sweep proving `loadConfig()` and
 * `loadConfigFromDisk()` can no longer silently diverge on which fields get
 * governed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig } from '../../src/config/config.js';
import { configToYaml } from '../../src/config/writer.js';
import { loadConfigFromDisk } from '../../src/config/loader.js';

describe('governance chain parity between loadConfig() and loadConfigFromDisk()', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('an invalid distill.extractionPasses on disk is dropped to 2, never reaches the running config (previously NOT governed on the real boot path)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-extraction-passes-boot-'));
    tmpDirs.push(dir);

    const cfg = defaultConfig();
    (cfg.distill as unknown as Record<string, unknown>).extractionPasses = 3; // out of {1, 2}
    writeFileSync(join(dir, 'config.yaml'), configToYaml(cfg), 'utf8');

    const loaded = loadConfigFromDisk(dir);
    expect(loaded.distill.extractionPasses).toBe(2);
  });

  it('an invalid audio.mode on disk is dropped to "off", never reaches the running config (previously the real boot path had NO audio governance at all)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-audio-mode-boot-'));
    tmpDirs.push(dir);

    const cfg = defaultConfig();
    (cfg.audio as unknown as Record<string, unknown>).mode = 'enable'; // typo, not in the closed union
    writeFileSync(join(dir, 'config.yaml'), configToYaml(cfg), 'utf8');

    const loaded = loadConfigFromDisk(dir);
    expect(loaded.audio.mode).toBe('off');
  });

  it('loadConfig() also applies atomTriage governance (previously the in-process path never called applyAtomTriageGovernance)', () => {
    const cfg = loadConfig({
      distill: {
        ...defaultConfig().distill,
        atomTriage: { mode: 'bogus' as any, batchSize: 20, maxPerRun: 200, maxWallClockMs: 300_000 },
      },
    } as any);
    expect(cfg.distill.atomTriage.mode).toBe('off');
  });

  // Parity sweep: feed the same invalid value for a representative field per
  // governed top-level key through BOTH real paths and assert they land on
  // the identical governed result. Not exhaustive over all ~17 functions —
  // the individual `applyXGovernance` unit tests (tests/config/config.test.ts)
  // already cover each function's own clamp/drop logic in isolation. This is
  // the structural guarantee: since both paths now call the same
  // `applyAllGovernance`, they cannot re-diverge per-field the way they did
  // before this slice.
  it('loadConfig() and loadConfigFromDisk() govern the same fields identically', () => {
    const dirty = defaultConfig();
    (dirty.distill as unknown as Record<string, unknown>).extractionPasses = 3;
    (dirty.distill.atomTriage as unknown as Record<string, unknown>).mode = 'bogus';
    (dirty.audio as unknown as Record<string, unknown>).mode = 'bogus';
    (dirty.consolidation.contradictionDetection as unknown as Record<string, unknown>).mode = 'bogus';

    const dir = mkdtempSync(join(tmpdir(), 'astramem-governance-parity-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'config.yaml'), configToYaml(dirty), 'utf8');

    const viaDisk = loadConfigFromDisk(dir);
    const viaInProcess = loadConfig(dirty);

    expect(viaDisk.distill.extractionPasses).toBe(viaInProcess.distill.extractionPasses);
    expect(viaDisk.distill.atomTriage.mode).toBe(viaInProcess.distill.atomTriage.mode);
    expect(viaDisk.audio.mode).toBe(viaInProcess.audio.mode);
    expect(viaDisk.consolidation.contradictionDetection.mode).toBe(viaInProcess.consolidation.contradictionDetection.mode);
  });
});
