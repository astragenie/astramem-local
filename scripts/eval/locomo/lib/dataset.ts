/**
 * Loader + downloader + deterministic sampler for locomo10.json (10
 * conversations, ~1986 QA pairs total, ~2.8MB -- see README for the license
 * note). Unlike LongMemEval's 500-question stratified sub-sample
 * (../../longmemeval/lib/dataset.ts), LoCoMo's own dataset is small enough
 * to load whole (FEAT-457 architecture note: "LoCoMo is 10 conversations
 * total -- load-all, not LongMemEval's stratified sample"). `sampleLocomo`
 * still exists for smoke/dry-run purposes: pick a subset of conversations
 * and/or cap QA pairs per conversation, both deterministically seeded so a
 * pinned sample file is reproducible.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOCOMO_CATEGORIES, type LoCoMoSample, type LoCoMoQA, type LoCoMoCategory } from './types.js';

export const LOCOMO_DOWNLOAD_URL = 'https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json';

export function loadDataset(path: string): LoCoMoSample[] {
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw) as LoCoMoSample[];
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`dataset at ${path} did not parse to a non-empty array`);
  }
  for (const sample of data) {
    if (typeof sample.sample_id !== 'string' || !sample.conversation || !Array.isArray(sample.qa)) {
      throw new Error(`dataset at ${path}: malformed sample (missing sample_id/conversation/qa) -- got keys ${Object.keys(sample).join(', ')}`);
    }
  }
  return data;
}

/** Downloads locomo10.json from the upstream repo if `path` doesn't already
 *  exist. Never overwrites an existing file (re-run is a no-op) -- callers
 *  that want a fresh copy should delete the file first. */
export async function ensureDatasetDownloaded(path: string, url = LOCOMO_DOWNLOAD_URL): Promise<{ downloaded: boolean }> {
  if (existsSync(path)) return { downloaded: false };
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download LoCoMo dataset from ${url}: HTTP ${res.status}`);
  const body = await res.text();
  const parsed = JSON.parse(body) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`downloaded content from ${url} did not parse to a non-empty array -- refusing to write ${path}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return { downloaded: true };
}

/** Deterministic mulberry32 PRNG -- same seed always produces the same
 *  sample (mirrors ../../longmemeval/lib/dataset.ts's sampler, duplicated
 *  here rather than shared since it's dataset-shaped sampling logic, not
 *  daemon plumbing -- see FEAT-457's "copy-and-adapt" vs "extract-share"
 *  split). */
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

/** Largest-remainder apportionment of `total` across `weights` (same
 *  algorithm as ../../longmemeval/lib/dataset.ts's `apportion`). */
function apportion(weights: number[], total: number): number[] {
  const sumWeights = weights.reduce((a, b) => a + b, 0);
  if (sumWeights === 0) return weights.map(() => 0);
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

/** Category-stratified deterministic sub-sample of one sample's QA list --
 *  used by `sampleLocomo`'s `qaPerSample` cap so a small smoke sample still
 *  exercises all 5 categories rather than whichever happen to sort first. */
function stratifiedQaSubset(qa: LoCoMoQA[], cap: number, rand: () => number): LoCoMoQA[] {
  if (cap >= qa.length) return qa.slice();
  const byCategory = new Map<LoCoMoCategory, LoCoMoQA[]>();
  for (const c of LOCOMO_CATEGORIES) byCategory.set(c, []);
  for (const q of qa) byCategory.get(q.category)!.push(q);

  const categories = LOCOMO_CATEGORIES.filter(c => (byCategory.get(c)?.length ?? 0) > 0);
  const weights = categories.map(c => byCategory.get(c)!.length);
  const quotas = apportion(weights, Math.min(cap, qa.length));

  const picked: LoCoMoQA[] = [];
  categories.forEach((c, i) => {
    const pool = byCategory.get(c)!;
    const quota = Math.min(quotas[i] ?? 0, pool.length);
    picked.push(...seededShuffle(pool, rand).slice(0, quota));
  });
  return picked;
}

export interface SampleOptions {
  /** Number of conversations to keep, deterministically shuffled by `seed`.
   *  Default: all 10 (LoCoMo's full dataset is small -- FEAT-457's
   *  "load-all" architecture note). */
  n?: number;
  seed: number;
  /** Cap on QA pairs kept per conversation (category-stratified). Default:
   *  no cap (keep every QA pair). Intended for a fast smoke/dry-run sample,
   *  not the published-number run. */
  qaPerSample?: number;
}

/** Deterministic subset of the LoCoMo dataset given the same (dataset,
 *  options) -- reruns produce byte-identical sample files. Samples are
 *  returned sorted by `sample_id` (not shuffle order) so diffs across
 *  seeds/reruns are easy to eyeball, matching the LongMemEval sampler's
 *  convention. */
export function sampleLocomo(dataset: LoCoMoSample[], opts: SampleOptions): LoCoMoSample[] {
  const { seed, qaPerSample } = opts;
  const n = Math.min(opts.n ?? dataset.length, dataset.length);
  const rand = mulberry32(seed);

  const chosen = seededShuffle(dataset, rand).slice(0, n);
  const withQaCap = qaPerSample === undefined
    ? chosen
    : chosen.map(sample => ({ ...sample, qa: stratifiedQaSubset(sample.qa, qaPerSample, rand) }));

  return withQaCap.slice().sort((a, b) => a.sample_id.localeCompare(b.sample_id));
}
