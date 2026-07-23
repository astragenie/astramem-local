import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  reingestRunDirs, reanswerSnapshotDirs, deriveResumeSamplingArgs, deriveResumeAnswererArgs, snapshotAnswerOutputs,
  aggregateRunDirs, parseArgs, RESERVED_REINGEST_FLAGS, RESERVED_REANSWER_FLAGS,
} from './repeat-run.mts';

describe('reingestRunDirs', () => {
  it('generates N sequentially-suffixed dirs from a base path', () => {
    expect(reingestRunDirs('.eval-data/locomo/runs/noise', 3)).toEqual([
      '.eval-data/locomo/runs/noise-rep1',
      '.eval-data/locomo/runs/noise-rep2',
      '.eval-data/locomo/runs/noise-rep3',
    ]);
  });
  it('throws on a non-positive-integer runs count', () => {
    expect(() => reingestRunDirs('base', 0)).toThrow(/positive integer/);
    expect(() => reingestRunDirs('base', -1)).toThrow(/positive integer/);
    expect(() => reingestRunDirs('base', 1.5)).toThrow(/positive integer/);
  });
});

describe('reanswerSnapshotDirs', () => {
  it('generates N sequentially-suffixed snapshot dirs from the base run dir', () => {
    expect(reanswerSnapshotDirs('.eval-data/locomo/runs/base-run', 2)).toEqual([
      '.eval-data/locomo/runs/base-run-reanswer1',
      '.eval-data/locomo/runs/base-run-reanswer2',
    ]);
  });
  it('throws on a non-positive-integer runs count', () => {
    expect(() => reanswerSnapshotDirs('base', 0)).toThrow(/positive integer/);
  });
});

describe('deriveResumeSamplingArgs', () => {
  it('includes datasetPath/seed/n/qaPerSample/shards when present, excludes datasetHash', () => {
    const args = deriveResumeSamplingArgs({
      datasetPath: 'a.json', datasetHash: 'deadbeef', seed: 42, n: 1, qaPerSample: 50, shards: 2,
    });
    expect(args).toEqual(['--dataset', 'a.json', '--seed', '42', '--n', '1', '--qa-per-sample', '50', '--shards', '2']);
    expect(args.join(' ')).not.toContain('deadbeef');
  });

  it('omits n/qaPerSample when null (the "whole dataset, no cap" case)', () => {
    const args = deriveResumeSamplingArgs({ datasetPath: 'a.json', datasetHash: 'x', seed: 42, n: null, qaPerSample: null, shards: 1 });
    expect(args).toEqual(['--dataset', 'a.json', '--seed', '42', '--shards', '1']);
  });
});

describe('deriveResumeAnswererArgs (rev-e MEDIUM fix: --k must never silently fall through to run.mts\'s default)', () => {
  it('the exact mismatch scenario the review flagged: base manifest k=15, no --k in passthrough -> derives --k 15, not a silent 10', () => {
    const manifest = { config: { k: 15 } };
    const result = deriveResumeAnswererArgs(manifest, false);
    expect(result).toEqual({ args: ['--k', '15'], warning: null });
  });

  it('an explicit --k already in passthrough is left untouched (deliberate k A/B, not overridden)', () => {
    const manifest = { config: { k: 15 } };
    const result = deriveResumeAnswererArgs(manifest, true);
    expect(result).toEqual({ args: [], warning: null });
  });

  it('warns loudly (does not silently proceed) when run-manifest.json is null/missing', () => {
    const result = deriveResumeAnswererArgs(null, false);
    expect(result.args).toEqual([]);
    expect(result.warning).toMatch(/WARNING/);
    expect(result.warning).toMatch(/run.mts's own --k default \(10\)/);
  });

  it('warns loudly when config.k is missing from an otherwise-valid manifest', () => {
    const result = deriveResumeAnswererArgs({ config: {} }, false);
    expect(result.warning).toMatch(/WARNING/);
  });

  it('warns loudly when config.k is malformed (non-numeric)', () => {
    const result = deriveResumeAnswererArgs({ config: { k: 'fifteen' } }, false);
    expect(result.args).toEqual([]);
    expect(result.warning).toMatch(/WARNING/);
  });

  it('warns loudly when config.k is NaN/Infinity (finite-number guard)', () => {
    expect(deriveResumeAnswererArgs({ config: { k: NaN } }, false).warning).toMatch(/WARNING/);
    expect(deriveResumeAnswererArgs({ config: { k: Infinity } }, false).warning).toMatch(/WARNING/);
  });

  it('does not warn when passthrough already has --k, even with a missing/malformed manifest (nothing to derive, nothing at risk)', () => {
    expect(deriveResumeAnswererArgs(null, true)).toEqual({ args: [], warning: null });
    expect(deriveResumeAnswererArgs({ config: { k: 'nope' } }, true)).toEqual({ args: [], warning: null });
  });
});

describe('snapshotAnswerOutputs', () => {
  let src: string;
  let dest: string;

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'repeat-run-src-'));
    dest = join(mkdtempSync(join(tmpdir(), 'repeat-run-dest-')), 'snapshot');
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
  });

  it('copies hypotheses.jsonl/sample.json/run-params.json and run-manifest.json (if present) into a fresh dest dir', () => {
    writeFileSync(join(src, 'hypotheses.jsonl'), '{"qa_id":"s1#0"}\n', 'utf8');
    writeFileSync(join(src, 'sample.json'), '[]', 'utf8');
    writeFileSync(join(src, 'run-params.json'), '{"seed":42}', 'utf8');
    writeFileSync(join(src, 'run-manifest.json'), '{"run_dir":"x"}', 'utf8');

    snapshotAnswerOutputs(src, dest);

    expect(readFileSync(join(dest, 'hypotheses.jsonl'), 'utf8')).toContain('s1#0');
    expect(readFileSync(join(dest, 'sample.json'), 'utf8')).toBe('[]');
    expect(readFileSync(join(dest, 'run-params.json'), 'utf8')).toContain('42');
    expect(readFileSync(join(dest, 'run-manifest.json'), 'utf8')).toContain('run_dir');
  });

  it('skips run-manifest.json silently when absent (best-effort, not required)', () => {
    writeFileSync(join(src, 'hypotheses.jsonl'), '{}\n', 'utf8');
    writeFileSync(join(src, 'sample.json'), '[]', 'utf8');
    writeFileSync(join(src, 'run-params.json'), '{}', 'utf8');

    expect(() => snapshotAnswerOutputs(src, dest)).not.toThrow();
    expect(existsSync(join(dest, 'run-manifest.json'))).toBe(false);
  });

  it('throws (does not partially snapshot) when a required file is missing', () => {
    writeFileSync(join(src, 'hypotheses.jsonl'), '{}\n', 'utf8');
    // sample.json and run-params.json deliberately absent.
    expect(() => snapshotAnswerOutputs(src, dest)).toThrow(/sample\.json missing/);
  });
});

describe('aggregateRunDirs', () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function makeRunDir(opts: { hyps: Array<{ qa_id: string; sample_id: string; category: number; hypothesis: string }>; answer: string; runParams: Record<string, unknown> }): string {
    const dir = mkdtempSync(join(tmpdir(), 'repeat-run-agg-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'hypotheses.jsonl'), opts.hyps.map(h => JSON.stringify(h)).join('\n') + '\n', 'utf8');
    const sample = [{ sample_id: 's1', conversation: { speaker_a: 'A', speaker_b: 'B' }, qa: [{ question: 'q', answer: opts.answer, evidence: [], category: 4 }] }];
    writeFileSync(join(dir, 'sample.json'), JSON.stringify(sample), 'utf8');
    writeFileSync(join(dir, 'run-params.json'), JSON.stringify(opts.runParams), 'utf8');
    return dir;
  }

  it('scores and combines N comparable run dirs, returning both f1 (mean/stdev) and robust (median/range)', () => {
    const a = makeRunDir({ hyps: [{ qa_id: 's1#0', sample_id: 's1', category: 4, hypothesis: 'paris' }], answer: 'paris', runParams: { seed: 42, n: 1 } });
    const b = makeRunDir({ hyps: [{ qa_id: 's1#0', sample_id: 's1', category: 4, hypothesis: 'not paris at all' }], answer: 'paris', runParams: { seed: 42, n: 1 } });

    const result = aggregateRunDirs([a, b]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.f1.runs).toHaveLength(2);
      expect(result.robust.runs).toBe(2);
      expect(result.f1.overall_accuracy_stats?.n).toBe(2);
      expect(result.robust.overall_accuracy_robust.n).toBe(2);
    }
  });

  it('refuses (mirrors judge.mts) when run dirs were not sampled comparably', () => {
    const a = makeRunDir({ hyps: [{ qa_id: 's1#0', sample_id: 's1', category: 4, hypothesis: 'paris' }], answer: 'paris', runParams: { seed: 42, n: 1 } });
    const b = makeRunDir({ hyps: [{ qa_id: 's1#0', sample_id: 's1', category: 4, hypothesis: 'paris' }], answer: 'paris', runParams: { seed: 7, n: 1 } });

    const result = aggregateRunDirs([a, b]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refuseMessage).toMatch(/seed differs/);
  });

  it('a single run dir needs no comparison and still aggregates (n=1, no spread)', () => {
    const a = makeRunDir({ hyps: [{ qa_id: 's1#0', sample_id: 's1', category: 4, hypothesis: 'paris' }], answer: 'paris', runParams: { seed: 42, n: 1 } });
    const result = aggregateRunDirs([a]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.robust.overall_accuracy_robust.range).toBeNull();
  });
});

describe('parseArgs', () => {
  it('parses --mode reingest with --run-dir-base and defaults --runs to 3', () => {
    const parsed = parseArgs(['--mode', 'reingest', '--run-dir-base', '.eval-data/x']);
    expect(parsed).toMatchObject({ mode: 'reingest', runs: 3, runDirBase: '.eval-data/x', printOnly: false });
    expect(parsed.passthrough).toEqual([]);
  });

  it('parses --mode reanswer with --base-run-dir and an explicit --runs', () => {
    const parsed = parseArgs(['--mode', 'reanswer', '--base-run-dir', '.eval-data/y', '--runs', '5']);
    expect(parsed).toMatchObject({ mode: 'reanswer', runs: 5, baseRunDir: '.eval-data/y' });
  });

  it('forwards unrecognized flags verbatim as passthrough, preserving order', () => {
    const parsed = parseArgs(['--mode', 'reingest', '--run-dir-base', 'b', '--k', '15', '--cross-encoder']);
    expect(parsed.passthrough).toEqual(['--k', '15', '--cross-encoder']);
  });

  it('recognizes --print-only and excludes it from passthrough', () => {
    const parsed = parseArgs(['--mode', 'reingest', '--run-dir-base', 'b', '--print-only', '--k', '15']);
    expect(parsed.printOnly).toBe(true);
    expect(parsed.passthrough).toEqual(['--k', '15']);
  });

  it('rejects an invalid --mode', () => {
    expect(() => parseArgs(['--mode', 'bogus'])).toThrow(/--mode must be/);
    expect(() => parseArgs([])).toThrow(/--mode must be/);
  });

  it('requires --run-dir-base for reingest and --base-run-dir for reanswer', () => {
    expect(() => parseArgs(['--mode', 'reingest'])).toThrow(/requires --run-dir-base/);
    expect(() => parseArgs(['--mode', 'reanswer'])).toThrow(/requires --base-run-dir/);
  });

  it('rejects --runs below 2 (need at least 2 repeats for a spread)', () => {
    expect(() => parseArgs(['--mode', 'reingest', '--run-dir-base', 'b', '--runs', '1'])).toThrow(/must be an integer >= 2/);
    expect(() => parseArgs(['--mode', 'reingest', '--run-dir-base', 'b', '--runs', 'nope'])).toThrow(/must be an integer >= 2/);
  });

  it('reingest mode refuses --run-dir/--resume in passthrough (wrapper owns them)', () => {
    for (const flag of RESERVED_REINGEST_FLAGS) {
      expect(() => parseArgs(['--mode', 'reingest', '--run-dir-base', 'b', flag, 'x'])).toThrow(/manages --run-dir\/--resume itself/);
    }
  });

  it('reanswer mode refuses --resume/--dataset/--seed/--n/--qa-per-sample/--shards in passthrough (derived automatically)', () => {
    for (const flag of RESERVED_REANSWER_FLAGS) {
      expect(() => parseArgs(['--mode', 'reanswer', '--base-run-dir', 'b', flag, 'x'])).toThrow(/derives these from --base-run-dir/);
    }
  });
});
