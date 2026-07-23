/**
 * Paired significance test for A/B comparisons on the SAME question set
 * (`../compare.mts`, Wave-4 measurement-trust track directive, 2026-07-23).
 * `../../shared/stats.ts`'s `compareMeans` already answers "do two
 * INDEPENDENT samples' means differ beyond noise" -- but a compare.mts A/B
 * always answers the identical questions on both sides (same dataset/seed/n,
 * enforced by `evaluateMultiRunParamsGuard`), so treating the two sides as
 * independent throws away the strongest signal available: question
 * DIFFICULTY is shared. Some LoCoMo questions are just hard for every config
 * (ambiguous phrasing, borderline gold answer) and some are easy for every
 * config -- that per-question variance swamps a small config effect if it
 * isn't first removed by pairing.
 *
 * Method: for each qa_id, average that question's score across a config's N
 * repeats (isolates the per-question SIGNAL from repeat-to-repeat answerer
 * noise), take delta = meanA(qa) - meanB(qa) for every question both sides
 * answered, then run a **paired bootstrap resampling test** (Koehn 2004,
 * the standard significance test for comparing two systems on one shared
 * test set in NLP evaluation): resample the per-question deltas with
 * replacement B times, take the mean each time, and read off a percentile CI
 * on the resampling distribution. No normality assumption (LoCoMo's
 * per-question F1 is neither normal nor binary once averaged over repeats),
 * honest at the small paired-N a single conversation sample can produce, and
 * simple enough to implement with no new dependency.
 *
 * Pure functions only -- no I/O beyond the two loader helpers, which take
 * already-resolved run dirs the same way `../repeat-run.mts`'s
 * `aggregateRunDirs` does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mean } from '../../shared/stats.js';
import { LOCOMO_CATEGORIES, qaId, type HypothesisRecord, type LoCoMoCategory, type LoCoMoSample } from '../lib/types.js';
import { scoreHypothesis } from './metrics.mts';

function parseJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}

export interface PerQuestionScore {
  qaId: string;
  category: LoCoMoCategory;
  /** One score per run dir that answered this question, in run-dir order.
   *  Lengths can differ across questions (e.g. a distill timeout skipped one
   *  repeat's worth of one question) -- see scorePerQuestionAcrossRuns. */
  scores: number[];
}

/**
 * Scores every run dir's hypotheses against its own sample.json (same
 * loading pattern as `../repeat-run.mts`'s `aggregateRunDirs` and
 * `./metrics.mts`'s `scoreRun`), but keeps the per-question breakdown
 * instead of collapsing straight into a `MetricsReport` -- the granularity
 * the paired test needs that the existing aggregators intentionally throw
 * away. `"(skipped...)"` placeholder hypotheses (distill timeout) are
 * excluded, mirroring `scoreRun`.
 */
export function scorePerQuestionAcrossRuns(runDirs: string[]): Map<string, PerQuestionScore> {
  const byQaId = new Map<string, PerQuestionScore>();
  for (const dir of runDirs) {
    const hypotheses = parseJsonl<HypothesisRecord>(join(dir, 'hypotheses.jsonl'));
    const references = JSON.parse(readFileSync(join(dir, 'sample.json'), 'utf8')) as LoCoMoSample[];
    const answerByQaId = new Map<string, string | number | undefined>();
    for (const sample of references) {
      sample.qa.forEach((qa, i) => answerByQaId.set(qaId(sample.sample_id, i), qa.answer));
    }
    for (const h of hypotheses) {
      if (h.hypothesis.startsWith('(skipped')) continue;
      if (!answerByQaId.has(h.qa_id)) {
        console.warn(`scorePerQuestionAcrossRuns: ${h.qa_id} not found in ${join(dir, 'sample.json')} -- skipping.`);
        continue;
      }
      const score = scoreHypothesis(h.category, h.hypothesis, answerByQaId.get(h.qa_id));
      const entry = byQaId.get(h.qa_id);
      if (entry) entry.scores.push(score);
      else byQaId.set(h.qa_id, { qaId: h.qa_id, category: h.category, scores: [score] });
    }
  }
  return byQaId;
}

export interface PairedDelta {
  qaId: string;
  category: LoCoMoCategory;
  /** Mean score across config A's repeats for this question. */
  meanA: number;
  /** Mean score across config B's repeats for this question. */
  meanB: number;
  /** meanA - meanB (signed; positive means A scored higher on this question). */
  delta: number;
}

export interface PairedDeltaResult {
  paired: PairedDelta[];
  /** Count of qa_ids only config A answered -- excluded from the pairing. */
  onlyInA: number;
  /** Count of qa_ids only config B answered -- excluded from the pairing. */
  onlyInB: number;
}

/**
 * Pairs two configs' per-question score maps on qa_id (the intersection --
 * a qa_id only one side answered contributes no information to a PAIRED
 * comparison and is dropped, counted rather than silently ignored).
 */
export function pairDeltas(a: Map<string, PerQuestionScore>, b: Map<string, PerQuestionScore>): PairedDeltaResult {
  const paired: PairedDelta[] = [];
  let onlyInA = 0;
  for (const [id, scoreA] of a) {
    const scoreB = b.get(id);
    if (!scoreB) { onlyInA++; continue; }
    const meanA = mean(scoreA.scores);
    const meanB = mean(scoreB.scores);
    if (meanA === null || meanB === null) continue;
    paired.push({ qaId: id, category: scoreA.category, meanA, meanB, delta: meanA - meanB });
  }
  let onlyInB = 0;
  for (const id of b.keys()) if (!a.has(id)) onlyInB++;
  return { paired, onlyInA, onlyInB };
}

/** Deterministic mulberry32 PRNG -- same copy-and-adapt precedent as
 *  ../lib/dataset.ts's own module-private copy (see that file's header):
 *  a tiny seeded RNG is dataset/stats-shaped utility duplication, not
 *  daemon plumbing worth extracting into a shared module. Needed here (not
 *  Math.random) so a bootstrap CI is exactly reproducible across a
 *  --seed-pinned CLI invocation and in tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapCI {
  /** Observed mean of `values` (not a resample -- the point estimate). */
  mean: number;
  ciLow: number;
  ciHigh: number;
  n: number;
  iterations: number;
  alpha: number;
}

export interface BootstrapOptions {
  /** Resamples to draw. Default 10,000 -- enough for a stable 95% percentile
   *  CI without a noticeable runtime cost at LoCoMo's paired-N scale. */
  iterations?: number;
  /** Two-tailed significance level. Default 0.05 (95% CI). */
  alpha?: number;
  /** PRNG seed for reproducibility. Default 42 (this repo's usual sampler
   *  seed default, ../lib/dataset.ts). */
  seed?: number;
}

/**
 * Percentile bootstrap CI on the mean of `values` (Efron's bootstrap,
 * paired-delta case: `values` is one signed delta per shared question).
 * Null on an empty input -- nothing to resample.
 */
export function bootstrapMeanCI(values: number[], opts: BootstrapOptions = {}): BootstrapCI | null {
  const finite = values.filter(v => Number.isFinite(v));
  if (finite.length === 0) return null;
  const iterations = opts.iterations ?? 10_000;
  const alpha = opts.alpha ?? 0.05;
  const rand = mulberry32(opts.seed ?? 42);
  const n = finite.length;
  const observedMean = finite.reduce((s, v) => s + v, 0) / n;

  const bootMeans = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += finite[Math.floor(rand() * n)]!;
    bootMeans[i] = sum / n;
  }
  bootMeans.sort((x, y) => x - y);
  const lowIdx = Math.max(0, Math.floor((alpha / 2) * iterations));
  const highIdx = Math.min(iterations - 1, Math.ceil((1 - alpha / 2) * iterations) - 1);

  return { mean: observedMean, ciLow: bootMeans[lowIdx]!, ciHigh: bootMeans[highIdx]!, n, iterations, alpha };
}

export type Verdict = 'SIGNIFICANT' | 'NOT_SIGNIFICANT' | 'INCONCLUSIVE';

export interface SignificanceResult {
  verdict: Verdict;
  /** Mean paired delta (A - B). NaN when there was nothing to compute over. */
  delta: number;
  ci: BootstrapCI | null;
  /** Number of paired questions the verdict was computed from. */
  n: number;
  /** Set only for INCONCLUSIVE -- why no verdict could be reached. */
  reason?: string;
}

export interface SignificanceOptions extends BootstrapOptions {
  repeatsA: number;
  repeatsB: number;
  /** Floor below which the verdict is always INCONCLUSIVE, regardless of
   *  the data -- too few repeats means the per-question means themselves
   *  are unstable, so any CI computed from them would be dishonest. Default
   *  3, matching compare.mts's own MIN_REPEATS. */
  minRepeats?: number;
}

/**
 * Decides SIGNIFICANT / NOT_SIGNIFICANT / INCONCLUSIVE for one set of paired
 * per-question deltas (either the whole set, for the overall verdict, or a
 * single category's subset -- see decidePairedSignificanceByCategory).
 * SIGNIFICANT iff the bootstrap CI excludes zero.
 */
export function decidePairedSignificance(deltas: PairedDelta[], opts: SignificanceOptions): SignificanceResult {
  const minRepeats = opts.minRepeats ?? 3;
  if (opts.repeatsA < minRepeats || opts.repeatsB < minRepeats) {
    return {
      verdict: 'INCONCLUSIVE',
      delta: deltas.length > 0 ? (mean(deltas.map(d => d.delta)) ?? NaN) : NaN,
      ci: null,
      n: deltas.length,
      reason: `too few repeats for a trustworthy per-question mean (need >= ${minRepeats} per config; got A=${opts.repeatsA}, B=${opts.repeatsB})`,
    };
  }
  if (deltas.length === 0) {
    return { verdict: 'INCONCLUSIVE', delta: NaN, ci: null, n: 0, reason: 'no paired questions between the two configs' };
  }
  const ci = bootstrapMeanCI(deltas.map(d => d.delta), opts);
  if (!ci) return { verdict: 'INCONCLUSIVE', delta: NaN, ci: null, n: deltas.length, reason: 'bootstrap produced no result' };
  const significant = ci.ciLow > 0 || ci.ciHigh < 0;
  return { verdict: significant ? 'SIGNIFICANT' : 'NOT_SIGNIFICANT', delta: ci.mean, ci, n: deltas.length };
}

/** Per-category breakdown (mh/tmp/od/sh/adv) -- same decision function, one
 *  category's subset of paired deltas at a time. A category with too few
 *  (or zero) paired questions naturally falls out as INCONCLUSIVE via the
 *  `deltas.length === 0` branch above -- no separate empty-category case
 *  needed here. */
export function decidePairedSignificanceByCategory(
  deltas: PairedDelta[],
  opts: SignificanceOptions,
): Record<LoCoMoCategory, SignificanceResult> {
  const out = {} as Record<LoCoMoCategory, SignificanceResult>;
  for (const c of LOCOMO_CATEGORIES) {
    out[c] = decidePairedSignificance(deltas.filter(d => d.category === c), opts);
  }
  return out;
}

/** Renders one SignificanceResult as the exact three-way verdict line
 *  compare.mts prints and archives: `SIGNIFICANT (Δ=…, CI …)` /
 *  `NOT SIGNIFICANT (Δ within noise)` / `INCONCLUSIVE (too few repeats)`. */
export function formatVerdict(result: SignificanceResult): string {
  const pct = (n: number) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(2)}%`;
  if (result.verdict === 'INCONCLUSIVE') return `INCONCLUSIVE (${result.reason ?? 'insufficient data'})`;
  const ci = result.ci!;
  const ciStr = `CI [${pct(ci.ciLow)}, ${pct(ci.ciHigh)}], n=${result.n}`;
  if (result.verdict === 'SIGNIFICANT') return `SIGNIFICANT (Δ=${pct(result.delta)}, ${ciStr})`;
  return `NOT SIGNIFICANT (Δ=${pct(result.delta)} within noise, ${ciStr})`;
}
