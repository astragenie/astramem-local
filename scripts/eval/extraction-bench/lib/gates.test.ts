import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadGatesConfig,
  evaluateTier,
  evaluateGates,
  staleCalibrationWarning,
  renderGatesSection,
  type GatesConfig,
  type GateTierDef,
} from './gates.js';
import type { ModelReport, RunAggregate, MultiRunStats } from './report.js';

/** Synthetic RunAggregate — every field defaulted to a "clean pass" shape;
 *  override only the fields a given test cares about (mirrors report.test.ts's
 *  `score()`/`fixtureRow()` override-object convention). */
function aggregate(overrides: Partial<RunAggregate> = {}): RunAggregate {
  return {
    avgRecall: 0.9,
    avgPrecision: 0.9,
    f1: 0.9,
    avgJunkRate: 0.05,
    avgTypeAccuracy: 0.9,
    overExtractionOnNothingFixture: 0,
    failedFixtures: 0,
    avgWallMsPerSession: 1000,
    totalWallMs: 1000,
    azureUsd: 0,
    avgPassAAtomCount: null,
    avgPassBAtomCount: null,
    forbiddenItemHitsTotal: 0,
    evidenceAcc: 0.95,
    evidenceAccNumerator: 19,
    evidenceAccDenominator: 20,
    ...overrides,
  };
}

function report(model: string, aggOverrides: Partial<RunAggregate> = {}, stats?: MultiRunStats): ModelReport {
  const agg = aggregate(aggOverrides);
  const base: ModelReport = { model, daemonBootMs: 500, fixtures: [], aggregate: agg };
  return stats ? { ...base, runs: [agg], stats } : base;
}

const LOCAL_VIABLE: GateTierDef = {
  f1: { min: 0.80 },
  typeAcc: { min: 0.60 },
  junk: { max: 0.20 },
  overExtract: { max: 0 },
  evidenceAcc: { min: 0.90 },
};

const PRODUCTION_PREFERRED: GateTierDef = {
  f1: { min: 0.88 },
  typeAcc: { min: 0.75 },
  junk: { max: 0.10 },
  evidenceAcc: { min: 0.95 },
};

const GATES: GatesConfig = {
  calibration: { fixtureCount: 55, fixtureCorpusDate: '2026-07-18' },
  tiers: { 'local-viable': LOCAL_VIABLE, 'production-preferred': PRODUCTION_PREFERRED },
};

describe('loadGatesConfig (AC-1)', () => {
  it('returns null when the file does not exist — missing gates.json is not an error', () => {
    expect(loadGatesConfig('/definitely/does/not/exist/gates.json')).toBeNull();
  });

  describe('shape validation of a PRESENT file (a real misconfiguration, not an opt-out)', () => {
    let dir: string;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    function writeGates(obj: unknown): string {
      dir = mkdtempSync(join(tmpdir(), 'gates-test-'));
      const path = join(dir, 'gates.json');
      writeFileSync(path, JSON.stringify(obj));
      return path;
    }

    it('loads a well-formed file successfully', () => {
      const path = writeGates(GATES);
      expect(loadGatesConfig(path)).toEqual(GATES);
    });

    it('throws when calibration.fixtureCount is not a positive integer', () => {
      const path = writeGates({ calibration: { fixtureCount: 0, fixtureCorpusDate: '2026-07-18' }, tiers: { t: { f1: { min: 0.5 } } } });
      expect(() => loadGatesConfig(path)).toThrow(/fixtureCount/);
    });

    it('throws when calibration.fixtureCorpusDate is missing', () => {
      const path = writeGates({ calibration: { fixtureCount: 55 }, tiers: { t: { f1: { min: 0.5 } } } });
      expect(() => loadGatesConfig(path)).toThrow(/fixtureCorpusDate/);
    });

    it('throws when tiers is empty', () => {
      const path = writeGates({ calibration: { fixtureCount: 55, fixtureCorpusDate: '2026-07-18' }, tiers: {} });
      expect(() => loadGatesConfig(path)).toThrow(/tiers/);
    });

    it('throws when a metric floor has neither min nor max', () => {
      const path = writeGates({ calibration: { fixtureCount: 55, fixtureCorpusDate: '2026-07-18' }, tiers: { t: { f1: {} } } });
      expect(() => loadGatesConfig(path)).toThrow(/min\/max/);
    });
  });
});

describe('evaluateTier — clean PASS / clean FAIL / n/a (AC-3, AC-4)', () => {
  it('clean PASS: every gated metric clears its floor, tier verdict PASS, no metric details', () => {
    const r = report('qwen2.5:7b'); // defaults are a clean pass against both tiers
    const local = evaluateTier('local-viable', LOCAL_VIABLE, r);
    expect(local.verdict).toBe('PASS');
    expect(local.metrics.every(m => m.verdict === 'pass')).toBe(true);
  });

  it('clean FAIL: names the concrete failing metrics, not a bare PASS/FAIL (AC-4)', () => {
    // Mirrors AC-4's own example: qwen2.5:7b F1=84%, typeAcc=48%, junk=22%.
    const r = report('qwen2.5:7b', { f1: 0.84, avgTypeAccuracy: 0.48, avgJunkRate: 0.22 });
    const local = evaluateTier('local-viable', LOCAL_VIABLE, r);
    expect(local.verdict).toBe('FAIL');
    const detailText = local.metrics.map(m => m.detail).join(' ');
    expect(detailText).toContain('typeAcc 48% < 60%');
    expect(detailText).toContain('junk 22% > 20%');
    // f1 (84%) and evidenceAcc (95%, default) both clear local-viable's floor — not named.
    expect(local.metrics.find(m => m.metric === 'f1')!.verdict).toBe('pass');

    const prod = evaluateTier('production-preferred', PRODUCTION_PREFERRED, r);
    expect(prod.verdict).toBe('FAIL');
    const prodDetail = prod.metrics.map(m => m.detail).join(' ');
    expect(prodDetail).toContain('F1 84% < 88%');
    expect(prodDetail).toContain('typeAcc 48% < 75%');
    expect(prodDetail).toContain('junk 22% > 10%');
  });

  it('AC-3: a metric with a null live value renders n/a, never a hard error and never a false FAIL', () => {
    const r = report('qwen3.5:9b', { evidenceAcc: null }); // e.g. zero evidence-bearing atoms this run
    const local = evaluateTier('local-viable', LOCAL_VIABLE, r);
    const evidenceResult = local.metrics.find(m => m.metric === 'evidenceAcc')!;
    expect(evidenceResult.verdict).toBe('n/a');
    // n/a must not flip the overall tier verdict to FAIL when every other metric passes.
    expect(local.verdict).toBe('PASS');
  });

  it('a tier with no floor for a given metric simply omits it (undefined floor -> not evaluated)', () => {
    const r = report('m', { overExtractionOnNothingFixture: 5 }); // would fail local-viable's overExtract=0
    const prod = evaluateTier('production-preferred', PRODUCTION_PREFERRED, r); // no overExtract floor
    expect(prod.metrics.find(m => m.metric === 'overExtract')).toBeUndefined();
    expect(prod.verdict).toBe('PASS');
  });
});

describe('evaluateTier — multi-run noise floor (AC-5)', () => {
  function multiRunReport(f1Mean: number, f1Stdev: number): ModelReport {
    const stats: MultiRunStats = {
      recall: { mean: f1Mean, stdev: f1Stdev, n: 3, raw: [] },
      precision: { mean: f1Mean, stdev: f1Stdev, n: 3, raw: [] },
      f1: { mean: f1Mean, stdev: f1Stdev, n: 3, raw: [] },
      typeAccuracy: { mean: 0.9, stdev: 0, n: 3, raw: [] },
    };
    return report('m', { f1: f1Mean }, stats);
  }

  it('AC-5: mean=0.82, stdev=0.05 against floor 0.80 -> mean-stdev (0.77) < floor but mean (0.82) clears it => inconclusive, not FAIL', () => {
    const r = multiRunReport(0.82, 0.05);
    const local = evaluateTier('local-viable', LOCAL_VIABLE, r);
    const f1Result = local.metrics.find(m => m.metric === 'f1')!;
    expect(f1Result.verdict).toBe('inconclusive');
    expect(local.verdict).toBe('INCONCLUSIVE');
  });

  it('AC-5: a case where mean-minus-stdev clears the floor renders a hard PASS', () => {
    const r = multiRunReport(0.90, 0.03); // mean-stdev = 0.87 >= 0.80
    const local = evaluateTier('local-viable', LOCAL_VIABLE, r);
    expect(local.metrics.find(m => m.metric === 'f1')!.verdict).toBe('pass');
    expect(local.verdict).toBe('PASS');
  });

  it('a mean itself below the floor is a hard FAIL regardless of stdev (not merely inconclusive)', () => {
    const r = multiRunReport(0.70, 0.05); // mean itself (0.70) already below the 0.80 floor
    const local = evaluateTier('local-viable', LOCAL_VIABLE, r);
    expect(local.metrics.find(m => m.metric === 'f1')!.verdict).toBe('fail');
    expect(local.verdict).toBe('FAIL');
  });
});

describe('staleCalibrationWarning (AC-2)', () => {
  it('is null when the stamped fixtureCount matches the actual loaded count', () => {
    expect(staleCalibrationWarning(GATES, 55)).toBeNull();
  });

  it('names both counts when the corpus has grown past the stamped calibration', () => {
    const msg = staleCalibrationWarning(GATES, 68);
    expect(msg).toContain('55 fixtures');
    expect(msg).toContain('68 present');
  });
});

describe('renderGatesSection (AC-2, AC-4)', () => {
  it('renders a stale-calibration warning above the per-model verdicts when counts differ', () => {
    const results = evaluateGates(GATES, [report('m')]);
    const lines = renderGatesSection(GATES, results, 68).join('\n');
    const warningIdx = lines.indexOf('55 fixtures; 68 present');
    const verdictIdx = lines.indexOf('- m —');
    expect(warningIdx).toBeGreaterThan(-1);
    expect(verdictIdx).toBeGreaterThan(warningIdx);
  });

  it('omits the warning line entirely when the stamped count matches', () => {
    const results = evaluateGates(GATES, [report('m')]);
    const lines = renderGatesSection(GATES, results, 55).join('\n');
    expect(lines).not.toContain('present — floors may not reflect');
  });

  it('renders a per-model, per-tier PASS/FAIL line with named failing metrics', () => {
    const r = report('qwen2.5:7b', { f1: 0.84, avgTypeAccuracy: 0.48, avgJunkRate: 0.22 });
    const results = evaluateGates(GATES, [r]);
    const lines = renderGatesSection(GATES, results, 55).join('\n');
    expect(lines).toContain('qwen2.5:7b — local-viable: FAIL (');
    expect(lines).toContain('typeAcc 48% < 60%');
    expect(lines).toContain('production-preferred: FAIL (');
  });
});
