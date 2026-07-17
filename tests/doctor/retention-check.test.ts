/**
 * tests/doctor/retention-check.test.ts
 *
 * FEAT-493 scaffolding: "Disk-artifact retention" doctor row. No DB
 * involved — the check scans `<dataDir>/artifacts/<kind>/` on disk (see
 * src/storage/retention.ts's doc comment for why this isn't the dropped
 * `artifacts` SQL table).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChecks } from '../../src/doctor/checks.js';
import { defaultConfig, type Config } from '../../src/config/config.js';
import { defaultArtifactsDir, writeSweepStats, type RetentionSweepResult } from '../../src/storage/retention.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

function retentionConfig(overrides: Partial<Config['retention']> = {}): Config['retention'] {
  const base = defaultConfig().retention;
  return {
    ...base,
    ...overrides,
    heavyArtifact: { ...base.heavyArtifact, ...overrides.heavyArtifact },
    tierScope: { ...base.tierScope, ...overrides.tierScope },
  };
}

function writeArtifact(dataDir: string, kind: string, name: string, sizeBytes: number, mtimeMs: number): void {
  const kindDir = join(defaultArtifactsDir(dataDir), kind);
  mkdirSync(kindDir, { recursive: true });
  const filePath = join(kindDir, name);
  writeFileSync(filePath, Buffer.alloc(sizeBytes));
  const mtimeSec = mtimeMs / 1000;
  utimesSync(filePath, mtimeSec, mtimeSec);
}

describe('doctor "Disk-artifact retention" check (FEAT-493)', () => {
  let dir: string;
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-retention-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor(retention: Config['retention']) {
    return findCheck(
      getChecks({ dataDir: dir, encryptionEnabled: false, retentionConfig: retention }),
      'Disk-artifact retention',
    );
  }

  it('defaults to mode "off" when no config is supplied — ok:true', async () => {
    const check = findCheck(getChecks({ dataDir: dir, encryptionEnabled: false }), 'Disk-artifact retention');
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('off');
    expect(result.message).toContain('default');
  });

  it("mode 'off' short-circuits even when matching artifacts exist on disk", async () => {
    writeArtifact(dir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, Date.now() - 120 * DAY_MS);

    const result = await checkFor(retentionConfig({ mode: 'off' })).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('off');
  });

  it('dry-run, no artifacts directory yet — ok:true, expected-empty message', async () => {
    const result = await checkFor(
      retentionConfig({ mode: 'dry-run', heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] } }),
    ).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('0 candidates');
    expect(result.message).toContain('FEAT-489');
  });

  it('dry-run, a matching heavy candidate exists — ok:true, reports count/bytes/kind breakdown', async () => {
    writeArtifact(dir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, Date.now() - 120 * DAY_MS);

    const result = await checkFor(
      retentionConfig({
        mode: 'dry-run',
        heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
        tierScope: { media: ['audio-raw'], lean: [] },
      }),
    ).run();

    expect(result.ok).toBe(true);
    expect(result.message).toContain('1 candidate(s)');
    expect(result.message).toContain('2.0MB');
    expect(result.message).toContain('audio-raw: 1');
  });

  // issue #408 (review gap): the readSweepStats/last-sweep-message logic
  // (checkRetention's `lastSweepMsg` branch) previously had zero coverage —
  // neither the "no sweep yet" nor the "populated" shape was exercised.
  describe('last-sweep message (readSweepStats + writeSweepStats wiring)', () => {
    it('appends "no sweep has run yet" when no sweep has ever been persisted', async () => {
      const result = await checkFor(
        retentionConfig({ mode: 'dry-run', heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] } }),
      ).run();

      expect(result.ok).toBe(true);
      expect(result.message).toContain('no sweep has run yet');
    });

    it('appends the last sweep summary (mode/tier, deleted count, MB freed) once one has been persisted', async () => {
      const deletedCandidate = { kind: 'audio-raw', path: '/some/deleted.wav', sizeBytes: 768 * 1024, mtimeMs: Date.now() };
      const sweep: RetentionSweepResult = {
        tier: 'media',
        mode: 'enabled',
        candidates: new Array(4).fill(deletedCandidate),
        totalBytes: 3 * 1024 * 1024,
        byKind: { 'audio-raw': { count: 4, bytes: 3 * 1024 * 1024 } },
        scannedAt: Date.now() - 3_600_000,
        deleted: new Array(4).fill(deletedCandidate),
        deletedBytes: 3 * 1024 * 1024,
        errors: [],
      };
      writeSweepStats(dir, sweep);

      const result = await checkFor(
        retentionConfig({ mode: 'dry-run', heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] } }),
      ).run();

      expect(result.ok).toBe(true);
      expect(result.message).toContain('last sweep (enabled/media)');
      expect(result.message).toContain('4 deleted');
      expect(result.message).toContain('3.0MB freed');
    });

    it('appends an error-count suffix when the persisted sweep recorded per-file unlink failures', async () => {
      const sweep: RetentionSweepResult = {
        tier: 'lean',
        mode: 'enabled',
        candidates: [],
        totalBytes: 0,
        byKind: {},
        scannedAt: Date.now(),
        deleted: [],
        deletedBytes: 0,
        errors: [{ path: '/some/path', message: 'EPERM' }],
      };
      writeSweepStats(dir, sweep);

      const result = await checkFor(
        retentionConfig({ mode: 'dry-run', heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] } }),
      ).run();

      expect(result.message).toContain('1 error(s)');
    });
  });
});
