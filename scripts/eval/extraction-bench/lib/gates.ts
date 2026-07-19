/**
 * Numeric quality-gate tiers for extraction-bench (FEAT-544).
 *
 * Encodes the "is this model good enough" judgment call — today made by a
 * human eyeballing report.md's raw percentages — as data
 * (`../gates.json`) plus a pure evaluator, so every run self-classifies a
 * per-model PASS/FAIL/INCONCLUSIVE verdict against named tiers instead of
 * living only in chat transcripts and issue bodies (e.g. #434's phi4-mini
 * gates).
 *
 * Design decisions:
 * - gates.json floors are stored on the SAME 0..1 fraction scale as
 *   RunAggregate's own fields (`aggregate.f1`, `aggregate.avgJunkRate`, ...)
 *   — no percent-scale (0..100) conversion either direction, avoiding an
 *   easy-to-miss *100 bug at the one place floors and live values meet.
 *   `overExtract` is the one exception: it is a raw atom COUNT (matches
 *   `RunAggregate.overExtractionOnNothingFixture`), not a fraction.
 * - Missing `gates.json` is NOT an error (`loadGatesConfig` returns `null`)
 *   — the bench must remain runnable with zero gate config; only a
 *   *present but malformed* file throws (ADR-015: loud failure on real
 *   misconfiguration, silent skip on "feature not opted into").
 * - Multi-run noise-floor rule (AC-5, FEAT-450 discipline): a min-floor
 *   metric only hard-FAILs when the mean itself is below the floor;
 *   when mean-minus-stdev dips below the floor but the mean itself still
 *   clears it, the verdict is `inconclusive` (straddling), never a hard
 *   FAIL. Symmetric for max-floor metrics (mean+stdev). Only `f1` and
 *   `typeAcc` currently carry a multi-run stdev (`ModelReport.stats`) —
 *   `junk`/`overExtract`/`evidenceAcc` have no per-run stats today, so
 *   they always use the plain point comparison; the same evaluator handles
 *   both without a special case, so a future stats addition for those
 *   metrics needs no evaluator change.
 * - A metric whose live value is `null` (e.g. `evidenceAcc` when a run
 *   produced zero evidence-bearing atoms, or an older digest column that
 *   predates a metric's existence) renders `n/a`, never a false FAIL and
 *   never a loader/evaluator crash (AC-3).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelReport } from './report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GATES_PATH = join(HERE, '..', 'gates.json');

export type GateMetricKey = 'f1' | 'typeAcc' | 'junk' | 'overExtract' | 'evidenceAcc';

const METRIC_ORDER: GateMetricKey[] = ['f1', 'typeAcc', 'junk', 'overExtract', 'evidenceAcc'];

/** All fraction-scale (0..1, rendered as a percentage) metrics except `overExtract`, a raw count. */
const PERCENT_METRICS = new Set<GateMetricKey>(['f1', 'typeAcc', 'junk', 'evidenceAcc']);

const METRIC_LABELS: Record<GateMetricKey, string> = {
  f1: 'F1',
  typeAcc: 'typeAcc',
  junk: 'junk',
  overExtract: 'overExtract',
  evidenceAcc: 'evidenceAcc',
};

export interface MetricFloor {
  min?: number;
  max?: number;
}

export type GateTierDef = Partial<Record<GateMetricKey, MetricFloor>>;

export interface GatesCalibration {
  fixtureCount: number;
  fixtureCorpusDate: string;
  /** Optional provenance notes — not required by the loader's shape check. */
  provisional?: boolean;
  note?: string;
}

export interface GatesConfig {
  calibration: GatesCalibration;
  tiers: Record<string, GateTierDef>;
}

// ---------------------------------------------------------------------------
// Loader (AC-1)
// ---------------------------------------------------------------------------

/**
 * Loads + shape-validates `gates.json`. Returns `null` when the file does
 * not exist at all — "no gates configured" is a valid, silent, non-error
 * state (AC: "missing file = gates section silently omitted"). Throws when
 * the file exists but fails shape validation (both `calibration` fields
 * present with the right types, `tiers` a non-empty object of well-formed
 * floors) — a present-but-broken config is a real misconfiguration, not an
 * opt-out.
 */
export function loadGatesConfig(path: string = DEFAULT_GATES_PATH): GatesConfig | null {
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  validateGatesShape(raw, path);
  return raw;
}

function validateGatesShape(raw: unknown, path: string): asserts raw is GatesConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`gates config ${path}: root must be an object`);
  }
  const obj = raw as Record<string, unknown>;

  const calibration = obj.calibration;
  if (typeof calibration !== 'object' || calibration === null) {
    throw new Error(`gates config ${path}: missing "calibration" block`);
  }
  const cal = calibration as Record<string, unknown>;
  if (!Number.isInteger(cal.fixtureCount) || (cal.fixtureCount as number) <= 0) {
    throw new Error(`gates config ${path}: calibration.fixtureCount must be a positive integer`);
  }
  if (typeof cal.fixtureCorpusDate !== 'string' || cal.fixtureCorpusDate.length === 0) {
    throw new Error(`gates config ${path}: calibration.fixtureCorpusDate must be a non-empty string`);
  }

  const tiers = obj.tiers;
  if (typeof tiers !== 'object' || tiers === null || Array.isArray(tiers) || Object.keys(tiers).length === 0) {
    throw new Error(`gates config ${path}: "tiers" must be a non-empty object`);
  }
  for (const [tierName, tierDef] of Object.entries(tiers as Record<string, unknown>)) {
    if (typeof tierDef !== 'object' || tierDef === null || Array.isArray(tierDef)) {
      throw new Error(`gates config ${path}: tier "${tierName}" must be an object`);
    }
    for (const [metric, floor] of Object.entries(tierDef as Record<string, unknown>)) {
      if (typeof floor !== 'object' || floor === null || Array.isArray(floor)) {
        throw new Error(`gates config ${path}: tier "${tierName}".${metric} must be an object with min and/or max`);
      }
      const f = floor as Record<string, unknown>;
      if (f.min === undefined && f.max === undefined) {
        throw new Error(`gates config ${path}: tier "${tierName}".${metric} must specify at least one of min/max`);
      }
      if (f.min !== undefined && typeof f.min !== 'number') {
        throw new Error(`gates config ${path}: tier "${tierName}".${metric}.min must be a number`);
      }
      if (f.max !== undefined && typeof f.max !== 'number') {
        throw new Error(`gates config ${path}: tier "${tierName}".${metric}.max must be a number`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluation (AC-4, AC-5)
// ---------------------------------------------------------------------------

export type MetricVerdict = 'pass' | 'fail' | 'inconclusive' | 'n/a';

export interface MetricGateResult {
  metric: GateMetricKey;
  verdict: MetricVerdict;
  /** Empty string for a clean pass/n/a — nothing to name. Populated for fail/inconclusive. */
  detail: string;
}

export type TierVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface TierGateResult {
  tier: string;
  verdict: TierVerdict;
  metrics: MetricGateResult[];
}

export interface ModelGateResult {
  model: string;
  tiers: TierGateResult[];
}

interface MetricSample {
  value: number | null;
  /** Sample stdev across `--runs N` runs, when available (only f1/typeAcc today). */
  stdev?: number | null;
}

function metricSamples(report: ModelReport): Record<GateMetricKey, MetricSample> {
  const a = report.aggregate;
  return {
    f1: { value: a.f1, stdev: report.stats?.f1.stdev ?? null },
    typeAcc: { value: a.avgTypeAccuracy, stdev: report.stats?.typeAccuracy.stdev ?? null },
    junk: { value: a.avgJunkRate, stdev: null },
    overExtract: { value: a.overExtractionOnNothingFixture, stdev: null },
    evidenceAcc: { value: a.evidenceAcc, stdev: null },
  };
}

function fmtMetricValue(key: GateMetricKey, value: number): string {
  const rendered = PERCENT_METRICS.has(key) ? `${Math.round(value * 100)}%` : `${value}`;
  return rendered;
}

/**
 * Evaluates one metric against its floor. `floor` undefined means this tier
 * doesn't gate this metric at all — returns `null` (not rendered).
 */
function evaluateMetric(key: GateMetricKey, floor: MetricFloor | undefined, sample: MetricSample): MetricGateResult | null {
  if (!floor) return null;
  if (sample.value === null) {
    return { metric: key, verdict: 'n/a', detail: '' };
  }
  const value = sample.value;
  const stdev = sample.stdev ?? null;
  const label = METRIC_LABELS[key];
  const hasNoise = stdev != null && stdev > 0;

  if (floor.min !== undefined) {
    const floorVal = floor.min;
    if (hasNoise) {
      const lower = value - (stdev as number);
      if (lower >= floorVal) return { metric: key, verdict: 'pass', detail: '' };
      if (value >= floorVal) {
        return {
          metric: key,
          verdict: 'inconclusive',
          detail: `${label} ${fmtMetricValue(key, value)} straddles floor ${fmtMetricValue(key, floorVal)} (mean-stdev ${fmtMetricValue(key, lower)})`,
        };
      }
      return { metric: key, verdict: 'fail', detail: `${label} ${fmtMetricValue(key, value)} < ${fmtMetricValue(key, floorVal)}` };
    }
    if (value >= floorVal) return { metric: key, verdict: 'pass', detail: '' };
    return { metric: key, verdict: 'fail', detail: `${label} ${fmtMetricValue(key, value)} < ${fmtMetricValue(key, floorVal)}` };
  }

  if (floor.max !== undefined) {
    const floorVal = floor.max;
    if (hasNoise) {
      const upper = value + (stdev as number);
      if (upper <= floorVal) return { metric: key, verdict: 'pass', detail: '' };
      if (value <= floorVal) {
        return {
          metric: key,
          verdict: 'inconclusive',
          detail: `${label} ${fmtMetricValue(key, value)} straddles floor ${fmtMetricValue(key, floorVal)} (mean+stdev ${fmtMetricValue(key, upper)})`,
        };
      }
      return { metric: key, verdict: 'fail', detail: `${label} ${fmtMetricValue(key, value)} > ${fmtMetricValue(key, floorVal)}` };
    }
    if (value <= floorVal) return { metric: key, verdict: 'pass', detail: '' };
    return { metric: key, verdict: 'fail', detail: `${label} ${fmtMetricValue(key, value)} > ${fmtMetricValue(key, floorVal)}` };
  }

  // Unreachable given loadGatesConfig's shape validation (every floor has min or max).
  throw new Error(`gate floor for metric "${key}" has neither min nor max`);
}

/** Evaluates every gated metric in one tier against one model's report. */
export function evaluateTier(tierName: string, tierDef: GateTierDef, report: ModelReport): TierGateResult {
  const samples = metricSamples(report);
  const metrics: MetricGateResult[] = [];
  for (const key of METRIC_ORDER) {
    const result = evaluateMetric(key, tierDef[key], samples[key]);
    if (result) metrics.push(result);
  }
  const hasFail = metrics.some(m => m.verdict === 'fail');
  const hasInconclusive = metrics.some(m => m.verdict === 'inconclusive');
  const verdict: TierVerdict = hasFail ? 'FAIL' : hasInconclusive ? 'INCONCLUSIVE' : 'PASS';
  return { tier: tierName, verdict, metrics };
}

/** Evaluates every tier in `gates` against every model in `reports`. */
export function evaluateGates(gates: GatesConfig, reports: ModelReport[]): ModelGateResult[] {
  return reports.map(r => ({
    model: r.model,
    tiers: Object.entries(gates.tiers).map(([tierName, tierDef]) => evaluateTier(tierName, tierDef, r)),
  }));
}

// ---------------------------------------------------------------------------
// Stale-calibration warning (AC-2)
// ---------------------------------------------------------------------------

/** `null` when the stamped fixture count matches what actually loaded. */
export function staleCalibrationWarning(gates: GatesConfig, actualFixtureCount: number): string | null {
  if (gates.calibration.fixtureCount === actualFixtureCount) return null;
  return `gates calibrated against ${gates.calibration.fixtureCount} fixtures; ${actualFixtureCount} present — floors may not reflect current corpus difficulty.`;
}

// ---------------------------------------------------------------------------
// Rendering (AC-4)
// ---------------------------------------------------------------------------

/**
 * Renders the "## Gates" report.md section: an optional stale-calibration
 * warning line, then one line per model naming every tier's verdict and,
 * for FAIL/INCONCLUSIVE tiers, the concrete failing/straddling metrics
 * (never a bare PASS/FAIL with no detail on a non-passing tier).
 */
export function renderGatesSection(gates: GatesConfig, results: ModelGateResult[], actualFixtureCount: number): string[] {
  const lines: string[] = ['', '## Gates', ''];
  const warning = staleCalibrationWarning(gates, actualFixtureCount);
  if (warning) lines.push(`_${warning}_`, '');

  for (const modelResult of results) {
    const tierParts = modelResult.tiers.map(t => {
      if (t.verdict === 'PASS') return `${t.tier}: PASS`;
      const namedFailing = t.metrics.filter(m => m.verdict === 'fail' || m.verdict === 'inconclusive');
      const verdictLabel = t.verdict === 'INCONCLUSIVE' ? 'inconclusive' : t.verdict;
      const detail = namedFailing.map(m => m.detail).join(', ');
      return `${t.tier}: ${verdictLabel} (${detail})`;
    });
    lines.push(`- ${modelResult.model} — ${tierParts.join('; ')}`);
  }
  return lines;
}
