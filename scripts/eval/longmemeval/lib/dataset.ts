/**
 * Loader + stratified sampler for longmemeval_s_cleaned.json (277MB, 500
 * questions). Loading is a single readFileSync + JSON.parse — no streaming —
 * see README for the memory/time cost; this is a one-shot eval harness, not
 * a hot path.
 */
import { readFileSync } from 'node:fs';
import { QUESTION_TYPES, isAbstention, type LongMemEvalQuestion, type QuestionType } from './types.js';

export function loadDataset(path: string): LongMemEvalQuestion[] {
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw) as LongMemEvalQuestion[];
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`dataset at ${path} did not parse to a non-empty array`);
  }
  return data;
}

/** Deterministic mulberry32 PRNG — same seed always produces the same
 *  sample, so smoke runs are diffable across iterations (design doc goal). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: T[], rand: () => number): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
  }
  return arr;
}

/** Largest-remainder apportionment of `total` across `weights` (proportional
 *  counts that sum exactly to `total`, rather than independently-rounded
 *  counts that can over/undershoot). */
function apportion(weights: number[], total: number): number[] {
  const sumWeights = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map(w => (w / sumWeights) * total);
  const floors = raw.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const result = floors.slice();
  for (let k = 0; k < remainder; k++) {
    const idx = order[k % order.length]!.i;
    result[idx] = (result[idx] ?? 0) + 1;
  }
  return result;
}

export interface SampleOptions {
  n: number;
  seed: number;
  /** Minimum fraction of a single-session-user quota that must be `_abs`
   *  abstention ids, when the type has any (design doc: "include some _abs
   *  abstention ids"). Default 0.3, matching the full dataset's ~43% ratio
   *  (30 of 70) rounded down conservatively. */
  minAbstentionFraction?: number;
}

/**
 * Stratified sample proportional across the 6 question_type values (plan doc
 * section 1.2 breakdown), forcing a minimum share of `_abs` abstention ids
 * within the single-session-user stratum. Fully deterministic given the same
 * (dataset, n, seed).
 */
export function sampleStratified(dataset: LongMemEvalQuestion[], opts: SampleOptions): LongMemEvalQuestion[] {
  const { n, seed, minAbstentionFraction = 0.3 } = opts;
  const byType = new Map<QuestionType, LongMemEvalQuestion[]>();
  for (const t of QUESTION_TYPES) byType.set(t, []);
  for (const q of dataset) {
    const bucket = byType.get(q.question_type);
    if (!bucket) throw new Error(`unknown question_type ${q.question_type} on ${q.question_id}`);
    bucket.push(q);
  }

  const types = QUESTION_TYPES.filter(t => (byType.get(t)?.length ?? 0) > 0);
  const weights = types.map(t => byType.get(t)!.length);
  const quotas = apportion(weights, Math.min(n, dataset.length));

  const rand = mulberry32(seed);
  const picked: LongMemEvalQuestion[] = [];

  types.forEach((type, i) => {
    const pool = byType.get(type)!;
    const quota = Math.min(quotas[i] ?? 0, pool.length);
    if (type === 'single-session-user') {
      const abs = pool.filter(isAbstention);
      const nonAbs = pool.filter(q => !isAbstention(q));
      const wantAbs = abs.length > 0 ? Math.max(1, Math.min(abs.length, Math.round(quota * minAbstentionFraction))) : 0;
      // `quota - wantAbs` can go negative for small n (quota rounds to 0 while
      // wantAbs is still force-bumped to >=1 to guarantee an abstention
      // example) — clamp to 0. Array#slice(0, negative) counts back from the
      // END of the array, so an unclamped negative here silently pulled in
      // almost the entire single-session-user pool instead of zero items
      // (verified live: n=2 returned 66 questions before this clamp).
      const wantNonAbs = Math.max(0, Math.min(nonAbs.length, quota - wantAbs));
      const shuffledAbs = seededShuffle(abs, rand).slice(0, wantAbs);
      const shuffledNonAbs = seededShuffle(nonAbs, rand).slice(0, wantNonAbs);
      picked.push(...shuffledAbs, ...shuffledNonAbs);
    } else {
      picked.push(...seededShuffle(pool, rand).slice(0, quota));
    }
  });

  // Stable, deterministic final order (not sample order) so diffs across
  // seeds/reruns are easy to eyeball.
  return picked.sort((a, b) => a.question_id.localeCompare(b.question_id));
}
