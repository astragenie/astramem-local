/**
 * tests/storage/retention.test.ts
 *
 * FEAT-493 scaffolding: mode enum + dry-run scan of `<dataDir>/artifacts/
 * <kind>/` on disk. NOT a DB-backed scan — the day-one `artifacts` SQL table
 * (migrations/001-init.sql) was DROPPED in migrations/040-drop-dead-tables.sql
 * (zero writers ever, irreversible), so this scans a plain directory layout
 * instead. See src/storage/retention.ts's doc comment for the full
 * rationale.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type Config } from '../../src/config/config.js';
import { scanRetentionCandidates, runRetentionPass, defaultArtifactsDir } from '../../src/storage/retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function retentionConfig(overrides: Partial<Config['retention']> = {}): Config['retention'] {
  const base = defaultConfig().retention;
  return {
    ...base,
    ...overrides,
    heavyArtifact: { ...base.heavyArtifact, ...overrides.heavyArtifact },
    tierScope: { ...base.tierScope, ...overrides.tierScope },
  };
}

/** Writes `<dataDir>/artifacts/<kind>/<name>` with the given size and mtime. */
function writeArtifact(dataDir: string, kind: string, name: string, sizeBytes: number, mtimeMs: number): string {
  const kindDir = join(defaultArtifactsDir(dataDir), kind);
  mkdirSync(kindDir, { recursive: true });
  const filePath = join(kindDir, name);
  writeFileSync(filePath, Buffer.alloc(sizeBytes));
  const mtimeSec = mtimeMs / 1000;
  utimesSync(filePath, mtimeSec, mtimeSec);
  return filePath;
}

describe('FEAT-493 retention — config defaults', () => {
  it('ships off by default, empty heavy-artifact predicate, empty tier scope', () => {
    const cfg = defaultConfig();
    expect(cfg.retention).toEqual({
      mode: 'off',
      ageThresholdDays: 90,
      heavyArtifact: { minSizeBytes: 1_048_576, types: [] },
      tierScope: { media: [], lean: [] },
    });
  });
});

describe('FEAT-493 retention — scanRetentionCandidates / runRetentionPass', () => {
  let dataDir: string;
  const now = Date.now();
  const OLD = now - 120 * DAY_MS; // older than a 90-day threshold
  const RECENT = now - 5 * DAY_MS; // well under the threshold

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'astramem-retention-test-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('never deletes files, regardless of mode (dry-run reports only)', () => {
    const filePath = writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'dry-run',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
      tierScope: { media: ['audio-raw'], lean: [] },
    });

    const result = runRetentionPass(dataDir, cfg, 'media', now);

    expect(result.candidates).toHaveLength(1);
    expect(result.totalBytes).toBe(2 * 1024 * 1024);
    expect(existsSync(filePath)).toBe(true);
  });

  it("mode 'off' is a hard no-op — returns empty result without touching disk", () => {
    writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'off',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
      tierScope: { media: ['audio-raw'], lean: [] },
    });

    const result = runRetentionPass(dataDir, cfg, 'media', now);

    expect(result).toEqual({ tier: 'media', mode: 'off', candidates: [], totalBytes: 0, byKind: {}, scannedAt: now });
  });

  it('handles a missing artifacts directory (the expected state before any producer exists)', () => {
    const cfg = retentionConfig({
      mode: 'dry-run',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
      tierScope: { media: ['audio-raw'], lean: [] },
    });

    const result = scanRetentionCandidates(dataDir, cfg, 'media', now);

    expect(result.candidates).toHaveLength(0);
  });

  it('excludes files younger than ageThresholdDays', () => {
    writeArtifact(dataDir, 'audio-raw', 'recent.wav', 2 * 1024 * 1024, RECENT);
    const cfg = retentionConfig({
      mode: 'dry-run',
      ageThresholdDays: 90,
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
      tierScope: { media: ['audio-raw'], lean: [] },
    });

    const result = scanRetentionCandidates(dataDir, cfg, 'media', now);

    expect(result.candidates).toHaveLength(0);
  });

  it('excludes files below minSizeBytes even when old and kind-matched', () => {
    writeArtifact(dataDir, 'audio-raw', 'small-old.wav', 100, OLD);
    const cfg = retentionConfig({
      mode: 'dry-run',
      heavyArtifact: { minSizeBytes: 1_048_576, types: ['audio-raw'] }, // 1 MiB floor, file is 100 bytes
      tierScope: { media: ['audio-raw'], lean: [] },
    });

    const result = scanRetentionCandidates(dataDir, cfg, 'media', now);

    expect(result.candidates).toHaveLength(0);
  });

  it('excludes kinds not in the tier scope', () => {
    writeArtifact(dataDir, 'screenshot', 'a1.png', 2 * 1024 * 1024, OLD); // not in media's scope below
    const cfg = retentionConfig({
      mode: 'dry-run',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw', 'screenshot'] },
      tierScope: { media: ['audio-raw'], lean: ['screenshot'] }, // 'screenshot' only enters at 'lean'/'all'
    });

    expect(scanRetentionCandidates(dataDir, cfg, 'media', now).candidates).toHaveLength(0);
    expect(scanRetentionCandidates(dataDir, cfg, 'lean', now).candidates).toHaveLength(1);
  });

  it("'all' tier reclaims every kind in heavyArtifact.types, independent of tierScope", () => {
    writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'dry-run',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
      tierScope: { media: [], lean: [] }, // deliberately empty — 'all' must not depend on this
    });

    expect(scanRetentionCandidates(dataDir, cfg, 'all', now).candidates).toHaveLength(1);
  });

  it('respects an artifactsDir override', () => {
    const altRoot = join(dataDir, 'alt-artifacts');
    const kindDir = join(altRoot, 'audio-raw');
    mkdirSync(kindDir, { recursive: true });
    const filePath = join(kindDir, 'a1.wav');
    writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024));
    const oldSec = OLD / 1000;
    utimesSync(filePath, oldSec, oldSec);

    const cfg = retentionConfig({
      mode: 'dry-run',
      artifactsDir: altRoot,
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
      tierScope: { media: ['audio-raw'], lean: [] },
    });

    expect(scanRetentionCandidates(dataDir, cfg, 'media', now).candidates).toHaveLength(1);
  });

  it('aggregates totalBytes and byKind across multiple kinds', () => {
    writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    writeArtifact(dataDir, 'audio-raw', 'a2.wav', 3 * 1024 * 1024, OLD);
    writeArtifact(dataDir, 'transcript-raw', 't1.json', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'dry-run',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw', 'transcript-raw'] },
      tierScope: { media: [], lean: ['audio-raw', 'transcript-raw'] },
    });

    const result = scanRetentionCandidates(dataDir, cfg, 'lean', now);

    expect(result.candidates).toHaveLength(3);
    expect(result.totalBytes).toBe(2 * 1024 * 1024 + 3 * 1024 * 1024 + 2 * 1024 * 1024);
    expect(result.byKind['audio-raw']).toEqual({ count: 2, bytes: 5 * 1024 * 1024 });
    expect(result.byKind['transcript-raw']).toEqual({ count: 1, bytes: 2 * 1024 * 1024 });
  });
});
