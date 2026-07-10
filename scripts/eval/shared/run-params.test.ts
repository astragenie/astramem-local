import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { hashDatasetFile, writeRunParams, checkRunParams, evaluateResumeGuard } from './run-params.js';

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

    // FEAT-470 AC-4 (462a re-review nit): a moved-but-identical dataset
    // (same sha256, different path) still refuses --resume, because
    // datasetPath is compared verbatim alongside datasetHash — this is
    // intentional strictness (README's "Resume behavior" section), not a
    // bug: the guard was never meant to be "only the hash matters."
    it('refuses on a moved-but-identical dataset (same sha256, different path) -- intentional strictness, not a hash-only check', () => {
      writeRunParams(runParamsPath, { datasetPath: 'a.json', datasetHash: 'same-hash', seed: 42, n: 50, shards: 1 });
      const result = evaluateResumeGuard(runParamsPath, true, { datasetPath: 'moved/a.json', datasetHash: 'same-hash', seed: 42, n: 50, shards: 1 });
      expect(result.action).toBe('refuse');
      if (result.action === 'refuse') {
        expect(result.refuseMessage).toContain('datasetPath: original="a.json", current="moved/a.json"');
        expect(result.refuseMessage).not.toContain('datasetHash:'); // hash matched -- only path differs
      }
    });
  });
});
