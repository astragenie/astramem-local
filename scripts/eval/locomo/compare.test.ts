import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_REPEATS, ANSWERER_PRESETS, expectedRunDirs, rawRepeatRunDirs, repeatRunArgsFor, slugify, buildComparisonReport,
  parseCompareArgs, compare, type CompareConfig,
} from './compare.mts';
import type { SignificanceResult } from './judge/paired-significance.js';
import type { MultiRunMetricsReport } from './judge/metrics.mts';
import type { MultiRunRobustReport } from './judge/robust-stats.js';
import { LOCOMO_CATEGORIES } from './lib/types.js';

describe('rawRepeatRunDirs', () => {
  it('delegates to repeat-run.mts\'s reingestRunDirs for mode "reingest"', () => {
    const config: CompareConfig = { label: 'a', mode: 'reingest', runDirBase: '.eval-data/locomo/runs/x' };
    expect(rawRepeatRunDirs(config, 3)).toEqual([
      '.eval-data/locomo/runs/x-rep1',
      '.eval-data/locomo/runs/x-rep2',
      '.eval-data/locomo/runs/x-rep3',
    ]);
  });

  it('delegates to repeat-run.mts\'s reanswerSnapshotDirs for mode "reanswer"', () => {
    const config: CompareConfig = { label: 'b', mode: 'reanswer', baseRunDir: '.eval-data/locomo/runs/base' };
    expect(rawRepeatRunDirs(config, 2)).toEqual([
      '.eval-data/locomo/runs/base-reanswer1',
      '.eval-data/locomo/runs/base-reanswer2',
    ]);
  });

  it('throws when the required dir field for the mode is missing', () => {
    expect(() => rawRepeatRunDirs({ label: 'a', mode: 'reingest' }, 3)).toThrow(/requires "runDirBase"/);
    expect(() => rawRepeatRunDirs({ label: 'a', mode: 'reanswer' }, 3)).toThrow(/requires "baseRunDir"/);
  });
});

describe('expectedRunDirs', () => {
  it('appends a config-label-scoped -cmp-<slug> suffix to the raw repeat-run.mts dirs', () => {
    const config: CompareConfig = { label: 'Cross Encoder', mode: 'reanswer', baseRunDir: '.eval-data/locomo/runs/base' };
    expect(expectedRunDirs(config, 2)).toEqual([
      '.eval-data/locomo/runs/base-reanswer1-cmp-cross-encoder',
      '.eval-data/locomo/runs/base-reanswer2-cmp-cross-encoder',
    ]);
  });

  it('two configs sharing the same baseRunDir + mode never collide on a final dir name', () => {
    const a: CompareConfig = { label: 'baseline', mode: 'reanswer', baseRunDir: '.eval-data/locomo/runs/base' };
    const b: CompareConfig = { label: 'cross-encoder', mode: 'reanswer', baseRunDir: '.eval-data/locomo/runs/base' };
    const dirsA = expectedRunDirs(a, 3);
    const dirsB = expectedRunDirs(b, 3);
    expect(rawRepeatRunDirs(a, 3)).toEqual(rawRepeatRunDirs(b, 3)); // same raw dirs (the collision this fixes)
    expect(dirsA.some(d => dirsB.includes(d))).toBe(false); // scoped final dirs never overlap
  });
});

describe('repeatRunArgsFor', () => {
  it('builds a reanswer invocation with passthrough flags forwarded', () => {
    const config: CompareConfig = { label: 'x', mode: 'reanswer', baseRunDir: '.eval-data/locomo/runs/base', passthrough: ['--k', '15', '--cross-encoder'] };
    expect(repeatRunArgsFor(config, 5)).toEqual([
      '--mode', 'reanswer', '--base-run-dir', '.eval-data/locomo/runs/base', '--runs', '5', '--k', '15', '--cross-encoder',
    ]);
  });

  it('builds a reingest invocation', () => {
    const config: CompareConfig = { label: 'x', mode: 'reingest', runDirBase: '.eval-data/locomo/runs/y' };
    expect(repeatRunArgsFor(config, 3)).toEqual(['--mode', 'reingest', '--run-dir-base', '.eval-data/locomo/runs/y', '--runs', '3']);
  });
});

describe('slugify', () => {
  it('kebab-cases a label', () => {
    expect(slugify('Cross-Encoder A/B')).toBe('cross-encoder-a-b');
  });
  it('falls back to "config" for a label with nothing kebab-able', () => {
    expect(slugify('!!!')).toBe('config');
  });
});

describe('ANSWERER_PRESETS', () => {
  it('cheap is the empty override', () => {
    expect(ANSWERER_PRESETS.cheap).toEqual({});
  });
  it('gpt-5.4 and zep-match both point AZURE_OPENAI_ANSWERER_DEPLOYMENT at gpt-5.4', () => {
    expect(ANSWERER_PRESETS['gpt-5.4']!.AZURE_OPENAI_ANSWERER_DEPLOYMENT).toBe('gpt-5.4');
    expect(ANSWERER_PRESETS['zep-match']!.AZURE_OPENAI_ANSWERER_DEPLOYMENT).toBe('gpt-5.4');
    expect(ANSWERER_PRESETS['zep-match']!.ASTRA_LOCOMO_ANSWER_EFFORT).toBe('medium');
  });
});

describe('buildComparisonReport', () => {
  function fakeF1(n: number): MultiRunMetricsReport {
    return { per_category: {} as never, category_averaged_accuracy: 0.5, overall_accuracy: 0.5, n_total: n };
  }
  function fakeRobust(): MultiRunRobustReport {
    return { runs: 3, category_robust_stats: {} as never, category_averaged_accuracy_robust: { median: 0.5, min: 0.4, max: 0.6, range: 0.2, n: 3, sorted: [0.4, 0.5, 0.6] }, overall_accuracy_robust: { median: 0.5, min: 0.4, max: 0.6, range: 0.2, n: 3, sorted: [0.4, 0.5, 0.6] } };
  }
  function fakeVerdict(): SignificanceResult {
    return { verdict: 'NOT_SIGNIFICANT', delta: 0.01, n: 40, ci: { mean: 0.01, ciLow: -0.02, ciHigh: 0.04, n: 40, iterations: 2000, alpha: 0.05 } };
  }

  it('assembles every field, omitting llmJudge keys when not supplied', () => {
    const byCategory = Object.fromEntries(LOCOMO_CATEGORIES.map(c => [c, fakeVerdict()])) as never;
    const report = buildComparisonReport({
      configA: { label: 'baseline', mode: 'reanswer', baseRunDir: 'x' },
      configB: { label: 'lever', mode: 'reanswer', baseRunDir: 'x' },
      repeats: 3, dirsA: ['a1', 'a2', 'a3'], dirsB: ['b1', 'b2', 'b3'],
      f1A: fakeF1(100), robustA: fakeRobust(), f1B: fakeF1(100), robustB: fakeRobust(),
      pairedQuestions: 40, onlyInA: 0, onlyInB: 0, overall: fakeVerdict(), byCategory,
    });
    expect(report.configA).toEqual({ label: 'baseline', mode: 'reanswer', env: {} });
    expect(report.dirsA).toEqual(['a1', 'a2', 'a3']);
    expect(report.pairedQuestions).toBe(40);
    expect(report.llmJudgeA).toBeUndefined();
    expect(report.llmJudgeB).toBeUndefined();
    expect(typeof report.generated_at).toBe('string');
  });

  it('includes llmJudge keys when supplied', () => {
    const byCategory = Object.fromEntries(LOCOMO_CATEGORIES.map(c => [c, fakeVerdict()])) as never;
    const report = buildComparisonReport({
      configA: { label: 'a', mode: 'reanswer', baseRunDir: 'x' }, configB: { label: 'b', mode: 'reanswer', baseRunDir: 'x' },
      repeats: 3, dirsA: ['a1'], dirsB: ['b1'], f1A: fakeF1(1), robustA: fakeRobust(), f1B: fakeF1(1), robustB: fakeRobust(),
      pairedQuestions: 1, onlyInA: 0, onlyInB: 0, overall: fakeVerdict(), byCategory,
      llmJudgeA: fakeF1(1), llmJudgeB: fakeF1(1),
    });
    expect(report.llmJudgeA).toBeDefined();
    expect(report.llmJudgeB).toBeDefined();
  });
});

describe('parseCompareArgs', () => {
  const cfgA = JSON.stringify({ label: 'baseline', mode: 'reanswer', baseRunDir: '.eval-data/locomo/runs/base' });
  const cfgB = JSON.stringify({ label: 'lever', mode: 'reanswer', baseRunDir: '.eval-data/locomo/runs/base', passthrough: ['--cross-encoder'] });

  it('parses two inline JSON configs and defaults repeats to MIN_REPEATS', () => {
    const parsed = parseCompareArgs(['--config-a', cfgA, '--config-b', cfgB]);
    expect(parsed.configA).toMatchObject({ label: 'baseline', mode: 'reanswer', baseRunDir: '.eval-data/locomo/runs/base' });
    expect(parsed.configB.passthrough).toEqual(['--cross-encoder']);
    expect(parsed.options.repeats).toBe(MIN_REPEATS);
    expect(parsed.options.printOnly).toBe(false);
    expect(parsed.options.llmJudge).toBe(false);
  });

  it('rejects --repeats below MIN_REPEATS', () => {
    expect(() => parseCompareArgs(['--config-a', cfgA, '--config-b', cfgB, '--repeats', '2'])).toThrow(/--repeats must be an integer >= 3/);
  });

  it('rejects an invalid --alpha', () => {
    expect(() => parseCompareArgs(['--config-a', cfgA, '--config-b', cfgB, '--alpha', '1.5'])).toThrow(/--alpha must be a number in \(0, 1\)/);
  });

  it('recognizes --print-only and --llm-judge', () => {
    const parsed = parseCompareArgs(['--config-a', cfgA, '--config-b', cfgB, '--print-only', '--llm-judge']);
    expect(parsed.options.printOnly).toBe(true);
    expect(parsed.options.llmJudge).toBe(true);
  });

  it('rejects passing both --config-a and --config-a-file', () => {
    expect(() => parseCompareArgs(['--config-a', cfgA, '--config-a-file', 'x.json', '--config-b', cfgB])).toThrow(/mutually exclusive/);
  });

  it('rejects missing mode-specific required field', () => {
    const badCfg = JSON.stringify({ label: 'bad', mode: 'reanswer' });
    expect(() => parseCompareArgs(['--config-a', badCfg, '--config-b', cfgB])).toThrow(/requires "baseRunDir"/);
  });

  it('rejects an unknown answerer preset', () => {
    expect(() => parseCompareArgs(['--config-a', cfgA, '--config-a-answerer-preset', 'gpt-6', '--config-b', cfgB])).toThrow(/unknown preset/);
  });

  it('merges a known answerer preset into config.env, explicit env wins on conflict', () => {
    const cfgWithEnv = JSON.stringify({ label: 'strong', mode: 'reanswer', baseRunDir: 'x', env: { AZURE_OPENAI_ANSWERER_DEPLOYMENT: 'explicit-override' } });
    const parsed = parseCompareArgs(['--config-a', cfgWithEnv, '--config-a-answerer-preset', 'zep-match', '--config-b', cfgB]);
    expect(parsed.configA.env).toEqual({ AZURE_OPENAI_ANSWERER_DEPLOYMENT: 'explicit-override', ASTRA_LOCOMO_ANSWER_EFFORT: 'medium' });
  });

  it('loads a config from --config-a-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compare-cfg-'));
    const path = join(dir, 'config-a.json');
    writeFileSync(path, cfgA, 'utf8');
    try {
      const parsed = parseCompareArgs(['--config-a-file', path, '--config-b', cfgB]);
      expect(parsed.configA.label).toBe('baseline');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('compare() --print-only (side-effect-free: no spawn, no file I/O beyond console output)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('rejects repeats below MIN_REPEATS before doing anything', async () => {
    const configA: CompareConfig = { label: 'a', mode: 'reanswer', baseRunDir: 'x' };
    const configB: CompareConfig = { label: 'b', mode: 'reanswer', baseRunDir: 'x' };
    await expect(compare(configA, configB, { repeats: 1 })).rejects.toThrow(/options.repeats must be an integer >= 3/);
  });

  it('prints both planned commands and returns the expected dirs without executing or writing anything', async () => {
    const configA: CompareConfig = { label: 'baseline', mode: 'reanswer', baseRunDir: '.eval-data/locomo/runs/base', passthrough: ['--k', '15'] };
    const configB: CompareConfig = { label: 'cross-encoder', mode: 'reanswer', baseRunDir: '.eval-data/locomo/runs/base', passthrough: ['--k', '15', '--cross-encoder'] };
    const result = await compare(configA, configB, { repeats: 3, printOnly: true });
    expect(result).toEqual({
      printOnly: true,
      dirsA: [
        '.eval-data/locomo/runs/base-reanswer1-cmp-baseline',
        '.eval-data/locomo/runs/base-reanswer2-cmp-baseline',
        '.eval-data/locomo/runs/base-reanswer3-cmp-baseline',
      ],
      dirsB: [
        '.eval-data/locomo/runs/base-reanswer1-cmp-cross-encoder',
        '.eval-data/locomo/runs/base-reanswer2-cmp-cross-encoder',
        '.eval-data/locomo/runs/base-reanswer3-cmp-cross-encoder',
      ],
    });
    const printed = logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(printed).toContain('repeat-run.mts');
    expect(printed).toContain('--cross-encoder');
    expect(printed).toContain('print-only: nothing executed, no report generated');
    expect(existsSync('.eval-data/locomo/runs/base-reanswer1-cmp-baseline.compare-vs-cross-encoder.json')).toBe(false);
  });
});
