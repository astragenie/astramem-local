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
import { join, relative } from 'node:path';
import { defaultConfig, type Config } from '../../src/config/config.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import {
  scanRetentionCandidates,
  runRetentionPass,
  defaultArtifactsDir,
  defaultSweepStatsPath,
  readSweepStats,
  writeSweepStats,
} from '../../src/storage/retention.js';

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
  it('ships off by default, media tier, empty heavy-artifact predicate, empty tier scope', () => {
    const cfg = defaultConfig();
    expect(cfg.retention).toEqual({
      mode: 'off',
      tier: 'media',
      ageThresholdDays: 90,
      heavyArtifact: { minSizeBytes: 1_048_576, types: [] },
      tierScope: { media: [], lean: [] },
    });
  });
});

/** Mirrors tests/storage/archival.test.ts's insertMemory helper — a raw
 *  distilled-memory insert with a caller-controlled created_at, so these
 *  boundary tests don't depend on any distill pipeline machinery. */
function insertMemory(db: DB, id: string, createdAt: number, text = `text-${id}`): void {
  db.prepare(`
    INSERT INTO memories
      (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at,
       valid_from, scope)
    VALUES (?, 'fact', ?, ?, 0.5, 0.5, ?, ?, ?, ?, 'private')
  `).run(id, text, text, `hash-${id}`, createdAt, createdAt, createdAt);
}

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

    expect(result).toEqual({
      tier: 'media', mode: 'off', candidates: [], totalBytes: 0, byKind: {}, scannedAt: now,
      deleted: [], deletedBytes: 0, errors: [],
    });
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

describe('FEAT-493 retention — mode "enabled" actually reclaims disk (un-clamped deletion)', () => {
  let dataDir: string;
  const now = Date.now();
  const OLD = now - 120 * DAY_MS;
  const RECENT = now - 5 * DAY_MS;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'astramem-retention-enabled-test-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("mode 'enabled' unlinks every candidate and reports deleted/deletedBytes", () => {
    const filePath = writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'enabled',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
      tierScope: { media: ['audio-raw'], lean: [] },
    });

    const result = runRetentionPass(dataDir, cfg, 'media', now);

    expect(result.candidates).toHaveLength(1);
    expect(result.deleted).toHaveLength(1);
    expect(result.deletedBytes).toBe(2 * 1024 * 1024);
    expect(result.errors).toHaveLength(0);
    expect(existsSync(filePath)).toBe(false);
  });

  it("mode 'enabled' never touches a candidate outside age/size/kind scope", () => {
    const recentPath = writeArtifact(dataDir, 'audio-raw', 'recent.wav', 2 * 1024 * 1024, RECENT);
    const smallPath = writeArtifact(dataDir, 'audio-raw', 'small-old.wav', 100, OLD);
    const oldPath = writeArtifact(dataDir, 'audio-raw', 'old.wav', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'enabled',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
      tierScope: { media: ['audio-raw'], lean: [] },
    });

    const result = runRetentionPass(dataDir, cfg, 'media', now);

    expect(result.deleted.map(d => d.path)).toEqual([oldPath]);
    expect(existsSync(recentPath)).toBe(true); // too young — survives
    expect(existsSync(smallPath)).toBe(true); // below size floor — survives
    expect(existsSync(oldPath)).toBe(false); // clears every bar — reclaimed
  });

  it('media tier deletes only media-scoped kinds; lean-only kinds survive a media-tier sweep', () => {
    const mediaPath = writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    const leanOnlyPath = writeArtifact(dataDir, 'transcript-derived', 't1.json', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'enabled',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw', 'transcript-derived'] },
      tierScope: { media: ['audio-raw'], lean: ['transcript-derived'] },
    });

    const result = runRetentionPass(dataDir, cfg, 'media', now);

    expect(result.deleted.map(d => d.path)).toEqual([mediaPath]);
    expect(existsSync(mediaPath)).toBe(false);
    expect(existsSync(leanOnlyPath)).toBe(true); // out of the media tier's scope
  });

  it("lean tier deletes media's kinds PLUS lean's own extra kinds", () => {
    const mediaPath = writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    const leanExtraPath = writeArtifact(dataDir, 'transcript-derived', 't1.json', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'enabled',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw', 'transcript-derived'] },
      tierScope: { media: ['audio-raw'], lean: ['transcript-derived'] },
    });

    const result = runRetentionPass(dataDir, cfg, 'lean', now);

    expect(result.deleted.map(d => d.path).sort()).toEqual([leanExtraPath, mediaPath].sort());
    expect(existsSync(mediaPath)).toBe(false);
    expect(existsSync(leanExtraPath)).toBe(false);
  });

  it("'all' tier reclaims every kind in heavyArtifact.types regardless of tierScope", () => {
    const audioPath = writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    const screenshotPath = writeArtifact(dataDir, 'screenshot', 's1.png', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'enabled',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw', 'screenshot'] },
      tierScope: { media: [], lean: [] }, // deliberately empty — 'all' must not depend on this
    });

    const result = runRetentionPass(dataDir, cfg, 'all', now);

    expect(result.deleted.map(d => d.path).sort()).toEqual([audioPath, screenshotPath].sort());
    expect(existsSync(audioPath)).toBe(false);
    expect(existsSync(screenshotPath)).toBe(false);
  });

  it("mode 'dry-run' computes the exact same candidate set 'enabled' would delete, but deletes nothing", () => {
    writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    writeArtifact(dataDir, 'audio-raw', 'a2.wav', 3 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'dry-run',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
      tierScope: { media: ['audio-raw'], lean: [] },
    });

    const dryRun = runRetentionPass(dataDir, cfg, 'media', now);
    expect(dryRun.deleted).toHaveLength(0);
    expect(dryRun.deletedBytes).toBe(0);
    expect(dryRun.totalBytes).toBe(5 * 1024 * 1024); // what WOULD be reclaimed

    const enabled = runRetentionPass(dataDir, { ...cfg, mode: 'enabled' }, 'media', now);
    expect(enabled.deleted).toHaveLength(2);
    expect(enabled.deletedBytes).toBe(dryRun.totalBytes); // dry-run's forecast matches the real reclaim
  });
});

describe('FEAT-493 retention — sweep-stats persistence (doctor "last sweep" stat)', () => {
  let dataDir: string;
  const now = Date.now();
  const OLD = now - 120 * DAY_MS;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'astramem-retention-stats-test-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('readSweepStats returns null before any sweep has ever run', () => {
    expect(readSweepStats(dataDir)).toBeNull();
  });

  it('writeSweepStats persists a real sweep result, readable back via readSweepStats', () => {
    writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'enabled',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
      tierScope: { media: ['audio-raw'], lean: [] },
    });

    const result = runRetentionPass(dataDir, cfg, 'media', now);
    writeSweepStats(dataDir, result);

    const stats = readSweepStats(dataDir);
    expect(stats).not.toBeNull();
    expect(stats).toMatchObject({
      tier: 'media',
      mode: 'enabled',
      candidateCount: 1,
      deletedCount: 1,
      deletedBytes: 2 * 1024 * 1024,
      errorCount: 0,
    });
    expect(existsSync(defaultSweepStatsPath(dataDir))).toBe(true);
  });
});

describe('FEAT-493 retention — path-traversal guard (issue #408)', () => {
  let dataDir: string;
  let outsideDir: string;
  let outsideFile: string;
  const now = Date.now();
  const OLD = now - 120 * DAY_MS;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'astramem-retention-traversal-test-'));
    // A sibling directory OUTSIDE `<dataDir>/artifacts/` — the thing a
    // `..`-bearing `kind` value could otherwise reach via `join(root, kind)`.
    outsideDir = mkdtempSync(join(tmpdir(), 'astramem-retention-outside-'));
    outsideFile = join(outsideDir, 'secret.bin');
    writeFileSync(outsideFile, Buffer.alloc(2 * 1024 * 1024));
    const mtimeSec = OLD / 1000;
    utimesSync(outsideFile, mtimeSec, mtimeSec);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('refuses a ..-bearing kind: scan reports zero candidates and never unlinks the outside file', () => {
    const artifactsRoot = defaultArtifactsDir(dataDir);
    mkdirSync(artifactsRoot, { recursive: true });
    // A relative `..` path from the artifacts root straight to `outsideDir` —
    // exactly the shape a config typo or malicious value would take.
    const traversalKind = relative(artifactsRoot, outsideDir);
    expect(traversalKind.startsWith('..')).toBe(true); // sanity: this really is outside the root

    const cfg = retentionConfig({
      mode: 'enabled',
      heavyArtifact: { minSizeBytes: 1024, types: [traversalKind] },
      tierScope: { media: [traversalKind], lean: [] },
    });

    const scan = scanRetentionCandidates(dataDir, cfg, 'media', now);
    expect(scan.candidates).toHaveLength(0);

    const result = runRetentionPass(dataDir, cfg, 'media', now);
    expect(result.candidates).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(existsSync(outsideFile)).toBe(true); // the outside file survives, untouched
  });

  it('still scans/deletes a legitimately nested kind after refusing a traversal sibling', () => {
    const legitPath = writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    const artifactsRoot = defaultArtifactsDir(dataDir);
    const traversalKind = relative(artifactsRoot, outsideDir);

    const cfg = retentionConfig({
      mode: 'enabled',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw', traversalKind] },
      tierScope: { media: ['audio-raw', traversalKind], lean: [] },
    });

    const result = runRetentionPass(dataDir, cfg, 'media', now);

    expect(result.deleted.map(d => d.path)).toEqual([legitPath]);
    expect(existsSync(legitPath)).toBe(false); // legitimate kind: reclaimed as normal
    expect(existsSync(outsideFile)).toBe(true); // traversal kind: refused, untouched
  });
});

describe('FEAT-493 retention — boundary: memory rows are NEVER touched (arch-review 2026-07-14)', () => {
  let dataDir: string;
  let db: DB;
  const now = Date.now();
  const OLD = now - 120 * DAY_MS;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'astramem-retention-boundary-test-'));
    db = openDb(':memory:');
    migrate(db);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function memoryRowCount(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
  }

  it("a 'media' tier real sweep leaves every distilled memory row byte-identical", () => {
    insertMemory(db, 'distilled-1', OLD, 'a distilled memory that must survive retention');
    const before = db.prepare('SELECT * FROM memories WHERE id = ?').get('distilled-1');

    writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'enabled',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
      tierScope: { media: ['audio-raw'], lean: [] },
    });

    // Note: runRetentionPass takes no `db` argument at all — structurally it
    // cannot reach the memories table. This test proves that in practice too.
    const result = runRetentionPass(dataDir, cfg, 'media', now);

    expect(result.deleted).toHaveLength(1); // the disk artifact WAS reclaimed
    expect(memoryRowCount()).toBe(1); // but the memory row count is untouched
    expect(db.prepare('SELECT * FROM memories WHERE id = ?').get('distilled-1')).toEqual(before);
  });

  it("a 'lean' tier real sweep (stripping derived payloads) also leaves distilled memories untouched", () => {
    insertMemory(db, 'distilled-1', OLD, 'a distilled memory that must survive a lean sweep');
    insertMemory(db, 'distilled-2', OLD, 'a second distilled memory');
    const beforeCount = memoryRowCount();

    writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    writeArtifact(dataDir, 'transcript-derived', 't1.json', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'enabled',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw', 'transcript-derived'] },
      tierScope: { media: ['audio-raw'], lean: ['transcript-derived'] },
    });

    const result = runRetentionPass(dataDir, cfg, 'lean', now);

    expect(result.deleted).toHaveLength(2); // both disk artifacts reclaimed
    expect(memoryRowCount()).toBe(beforeCount); // distilled memories: zero rows touched
  });

  it("even the 'all' tier — the widest disk-artifact scope — never deletes a memory row", () => {
    insertMemory(db, 'distilled-1', OLD);
    const before = db.prepare('SELECT * FROM memories WHERE id = ?').get('distilled-1');

    writeArtifact(dataDir, 'audio-raw', 'a1.wav', 2 * 1024 * 1024, OLD);
    const cfg = retentionConfig({
      mode: 'enabled',
      heavyArtifact: { minSizeBytes: 1024, types: ['audio-raw'] },
      tierScope: { media: [], lean: [] },
    });

    runRetentionPass(dataDir, cfg, 'all', now);

    expect(memoryRowCount()).toBe(1);
    expect(db.prepare('SELECT * FROM memories WHERE id = ?').get('distilled-1')).toEqual(before);
  });
});
