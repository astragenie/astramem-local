import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { hashDatasetFile, writeRunParams, checkRunParams, evaluateResumeGuard, diffRunParams, evaluateMultiRunParamsGuard } from './run-params.js';

describe('run-params (FEAT-462 review fix — resume scope guard)', () => {
  let dir: string;
  let runParamsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-params-test-'));
    runParamsPath = join(dir, 'run-params.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('hashDatasetFile returns the sha256 of the file contents', () => {
    const datasetPath = join(dir, 'dataset.json');
    writeFileSync(datasetPath, '{"a":1}', 'utf8');
    const expected = createHash('sha256').update(readFileSync(datasetPath)).digest('hex');
    expect(hashDatasetFile(datasetPath)).toBe(expected);
  });

  it('checkRunParams reports missingFile when run-params.json does not exist', () => {
    const result = checkRunParams(runParamsPath, { seed: 42, n: 50 });
    expect(result.missingFile).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('writeRunParams then checkRunParams with identical params is ok', () => {
    const params = { datasetPath: 'a.json', datasetHash: 'abc', seed: 42, n: 50, shards: 2 };
    writeRunParams(runParamsPath, params);
    const result = checkRunParams(runParamsPath, params);
    expect(result.ok).toBe(true);
    expect(result.missingFile).toBe(false);
    expect(result.mismatches).toEqual([]);
  });

  it('detects a smaller --n as a mismatch (the exact silent-scope-narrowing scenario)', () => {
    writeRunParams(runParamsPath, { datasetPath: 'a.json', datasetHash: 'abc', seed: 42, n: 50, shards: 1 });
    const result = checkRunParams(runParamsPath, { datasetPath: 'a.json', datasetHash: 'abc', seed: 42, n: 30, shards: 1 });
    expect(result.ok).toBe(false);
    expect(result.missingFile).toBe(false);
    expect(result.mismatches).toEqual(['n: original=50, current=30']);
  });

  it('detects a seed mismatch', () => {
    writeRunParams(runParamsPath, { seed: 42, n: 50 });
    const result = checkRunParams(runParamsPath, { seed: 7, n: 50 });
    expect(result.mismatches).toEqual(['seed: original=42, current=7']);
  });

  it('detects a shards mismatch', () => {
    writeRunParams(runParamsPath, { shards: 1, seed: 42, n: 50 });
    const result = checkRunParams(runParamsPath, { shards: 2, seed: 42, n: 50 });
    expect(result.mismatches).toEqual(['shards: original=1, current=2']);
  });

  it('detects a dataset hash mismatch (same path, different content)', () => {
    writeRunParams(runParamsPath, { datasetPath: 'a.json', datasetHash: 'old-hash', seed: 42, n: 50 });
    const result = checkRunParams(runParamsPath, { datasetPath: 'a.json', datasetHash: 'new-hash', seed: 42, n: 50 });
    expect(result.mismatches).toEqual(['datasetHash: original="old-hash", current="new-hash"']);
  });

  it('reports every differing param, not just the first', () => {
    writeRunParams(runParamsPath, { seed: 42, n: 50, shards: 1 });
    const result = checkRunParams(runParamsPath, { seed: 7, n: 30, shards: 2 });
    expect(result.mismatches.sort()).toEqual([
      'n: original=50, current=30',
      'seed: original=42, current=7',
      'shards: original=1, current=2',
    ]);
  });

  it('treats null and a missing key as equivalent (LoCoMo qaPerSample is optional)', () => {
    writeRunParams(runParamsPath, { seed: 42, n: 50, qaPerSample: null });
    const result = checkRunParams(runParamsPath, { seed: 42, n: 50 });
    expect(result.ok).toBe(true);
  });

  describe('evaluateResumeGuard (the single decision point run-smoke.mts/run.mts call)', () => {
    it('resuming=false always writes run-params.json and returns proceed-fresh, even if a file already existed', () => {
      const first = evaluateResumeGuard(runParamsPath, false, { seed: 42, n: 50, shards: 1 });
      expect(first).toEqual({ action: 'proceed-fresh' });
      expect(existsSync(runParamsPath)).toBe(true);

      // A second non-resume invocation (e.g. re-running against the same
      // --run-dir without --resume, already-supported pre-462 behavior)
      // just overwrites it -- never refuses, matches AC-7.
      const second = evaluateResumeGuard(runParamsPath, false, { seed: 7, n: 10, shards: 4 });
      expect(second).toEqual({ action: 'proceed-fresh' });
      expect(JSON.parse(readFileSync(runParamsPath, 'utf8'))).toMatchObject({ seed: 7, n: 10, shards: 4 });
    });

    it('(test d) resuming=true against a run dir with no run-params.json refuses with a "predates" message', () => {
      const result = evaluateResumeGuard(runParamsPath, true, { seed: 42, n: 50, shards: 1 });
      expect(result.action).toBe('refuse');
      expect(result).toMatchObject({ action: 'refuse' });
      if (result.action === 'refuse') {
        expect(result.refuseMessage).toMatch(/predates FEAT-462's resume support/);
      }
    });

    it('(test c) resuming=true with matching params returns proceed-resume and does not rewrite the file', () => {
      const original = { datasetPath: 'a.json', datasetHash: 'abc', seed: 42, n: 50, shards: 2 };
      writeRunParams(runParamsPath, original);
      const before = readFileSync(runParamsPath, 'utf8');

      const result = evaluateResumeGuard(runParamsPath, true, { ...original });

      expect(result).toEqual({ action: 'proceed-resume' });
      expect(readFileSync(runParamsPath, 'utf8')).toBe(before); // untouched
    });

    it('(test a) resuming=true with a smaller --n refuses and names the differing param + original value', () => {
      writeRunParams(runParamsPath, { datasetPath: 'a.json', datasetHash: 'abc', seed: 42, n: 50, shards: 1 });
      const result = evaluateResumeGuard(runParamsPath, true, { datasetPath: 'a.json', datasetHash: 'abc', seed: 42, n: 30, shards: 1 });

      expect(result.action).toBe('refuse');
      if (result.action === 'refuse') {
        expect(result.refuseMessage).toContain('n: original=50, current=30');
        expect(result.refuseMessage).toMatch(/refusing to resume/);
      }
    });

    it('(test b) resuming=true with a different --seed refuses and names it', () => {
      writeRunParams(runParamsPath, { seed: 42, n: 50, shards: 1 });
      const result = evaluateResumeGuard(runParamsPath, true, { seed: 99, n: 50, shards: 1 });
      expect(result.action).toBe('refuse');
      if (result.action === 'refuse') expect(result.refuseMessage).toContain('seed: original=42, current=99');
    });

    it('(test b) resuming=true with a different --shards refuses and names it', () => {
      writeRunParams(runParamsPath, { seed: 42, n: 50, shards: 1 });
      const result = evaluateResumeGuard(runParamsPath, true, { seed: 42, n: 50, shards: 2 });
      expect(result.action).toBe('refuse');
      if (result.action === 'refuse') expect(result.refuseMessage).toContain('shards: original=1, current=2');
    });

    it('(test b) resuming=true with a different dataset (path unchanged, content changed) refuses and names the hash', () => {
      writeRunParams(runParamsPath, { datasetPath: 'a.json', datasetHash: 'old-hash', seed: 42, n: 50, shards: 1 });
      const result = evaluateResumeGuard(runParamsPath, true, { datasetPath: 'a.json', datasetHash: 'new-hash', seed: 42, n: 50, shards: 1 });
      expect(result.action).toBe('refuse');
      if (result.action === 'refuse') expect(result.refuseMessage).toContain('datasetHash: original="old-hash", current="new-hash"');
    });
  });

  describe('diffRunParams — pure key-by-key diff (extracted, FEAT-457 slice 1 review fix)', () => {
    it('returns no diffs for identical param sets', () => {
      expect(diffRunParams({ seed: 42, n: 50 }, { seed: 42, n: 50 })).toEqual([]);
    });

    it('reports every differing key with both values', () => {
      const diffs = diffRunParams({ seed: 42, n: 50, shards: 1 }, { seed: 7, n: 30, shards: 1 });
      expect(diffs.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
        { key: 'n', a: 50, b: 30 },
        { key: 'seed', a: 42, b: 7 },
      ]);
    });

    it('treats a missing key as null on either side (LoCoMo qaPerSample is optional)', () => {
      expect(diffRunParams({ seed: 42, qaPerSample: null }, { seed: 42 })).toEqual([]);
      expect(diffRunParams({ seed: 42 }, { seed: 42, qaPerSample: 10 })).toEqual([{ key: 'qaPerSample', a: null, b: 10 }]);
    });
  });

  describe('evaluateMultiRunParamsGuard — judge.mts --run-dir cross-run comparability guard (FEAT-457 slice 1 review fix)', () => {
    let dirs: string[];

    beforeEach(() => {
      dirs = [];
    });

    afterEach(() => {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    });

    function makeRunDir(params: Record<string, unknown> | null): string {
      const d = mkdtempSync(join(tmpdir(), 'multirun-guard-test-'));
      dirs.push(d);
      if (params !== null) writeFileSync(join(d, 'run-params.json'), JSON.stringify(params), 'utf8');
      return d;
    }

    it('(test) a single --run-dir needs no comparison and always proceeds, even with no run-params.json', () => {
      const solo = makeRunDir(null);
      expect(evaluateMultiRunParamsGuard([solo])).toEqual({ action: 'proceed' });
      expect(evaluateMultiRunParamsGuard([])).toEqual({ action: 'proceed' });
    });

    it('(test a) two run dirs with identical params proceed', () => {
      const a = makeRunDir({ datasetPath: 'x.json', datasetHash: 'abc', seed: 42, n: 10, shards: 1 });
      const b = makeRunDir({ datasetPath: 'x.json', datasetHash: 'abc', seed: 42, n: 10, shards: 1 });
      expect(evaluateMultiRunParamsGuard([a, b])).toEqual({ action: 'proceed' });
    });

    it('(test b) a mismatched --n refuses, naming the offending dir and the differing param', () => {
      const a = makeRunDir({ seed: 42, n: 10 });
      const b = makeRunDir({ seed: 42, n: 20 }); // smoke-test-sized dir mixed with a full run
      const result = evaluateMultiRunParamsGuard([a, b]);
      expect(result.action).toBe('refuse');
      if (result.action === 'refuse') {
        expect(result.refuseMessage).toContain(b);
        expect(result.refuseMessage).toContain('n differs');
        expect(result.refuseMessage).toContain('=10');
        expect(result.refuseMessage).toContain('=20');
      }
    });

    it('(test c) a mismatched --seed refuses', () => {
      const a = makeRunDir({ seed: 42, n: 10 });
      const b = makeRunDir({ seed: 7, n: 10 });
      const result = evaluateMultiRunParamsGuard([a, b]);
      expect(result.action).toBe('refuse');
      if (result.action === 'refuse') expect(result.refuseMessage).toContain('seed differs');
    });

    it('(test c) a mismatched dataset hash refuses', () => {
      const a = makeRunDir({ datasetHash: 'old-hash', seed: 42, n: 10 });
      const b = makeRunDir({ datasetHash: 'new-hash', seed: 42, n: 10 });
      const result = evaluateMultiRunParamsGuard([a, b]);
      expect(result.action).toBe('refuse');
      if (result.action === 'refuse') expect(result.refuseMessage).toContain('datasetHash differs');
    });

    it('(test d) any dir missing run-params.json refuses with a "predates" message, naming the dir', () => {
      const a = makeRunDir({ seed: 42, n: 10 });
      const b = makeRunDir(null); // predates FEAT-462
      const result = evaluateMultiRunParamsGuard([a, b]);
      expect(result.action).toBe('refuse');
      if (result.action === 'refuse') {
        expect(result.refuseMessage).toMatch(/predates FEAT-462's resume support/);
        expect(result.refuseMessage).toContain(b);
      }
    });

    it('flags every mismatching dir, not just the first, across 3+ run dirs', () => {
      const a = makeRunDir({ seed: 42, n: 10 });
      const b = makeRunDir({ seed: 42, n: 20 });
      const c = makeRunDir({ seed: 42, n: 30 });
      const result = evaluateMultiRunParamsGuard([a, b, c]);
      expect(result.action).toBe('refuse');
      if (result.action === 'refuse') {
        expect(result.refuseMessage).toContain(b);
        expect(result.refuseMessage).toContain(c);
      }
    });
  });
});
