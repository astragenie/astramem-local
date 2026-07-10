/**
 * LoCoMo sampler CLI. Downloads locomo10.json if it isn't already present,
 * then writes a deterministic (dataset, n, seed, qa-per-sample) sample file
 * -- mirrors ../longmemeval/sample.mts's CLI shape, but the default is the
 * WHOLE dataset (LoCoMo is only 10 conversations total -- FEAT-457's
 * "load-all, not LongMemEval's stratified sample" architecture note).
 * `--n`/`--qa-per-sample` exist only for a fast smoke/dry-run subset.
 *
 * bun scripts/eval/locomo/sample.mts [--dataset <path>] [--n 10] [--seed 42]
 *   [--qa-per-sample <cap>] [--out <path>]
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadDataset, sampleLocomo, ensureDatasetDownloaded, LOCOMO_DOWNLOAD_URL } from './lib/dataset.js';
import { LOCOMO_CATEGORIES, CATEGORY_NAMES } from './lib/types.js';

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

export async function runSample(opts: {
  datasetPath: string;
  n?: number;
  seed: number;
  qaPerSample?: number;
  outPath: string;
  log?: (msg: string) => void;
}): Promise<void> {
  const log = opts.log ?? console.log;
  const { downloaded } = await ensureDatasetDownloaded(opts.datasetPath);
  log(downloaded
    ? `Downloaded LoCoMo dataset -> ${opts.datasetPath} (source: ${LOCOMO_DOWNLOAD_URL}; CC BY-NC 4.0 -- see README)`
    : `Using existing dataset at ${opts.datasetPath} (not re-downloaded)`);

  const dataset = loadDataset(opts.datasetPath);
  log(`Loaded ${dataset.length} conversation(s). Sampling n=${opts.n ?? dataset.length} (seed=${opts.seed}${opts.qaPerSample !== undefined ? `, qa-per-sample<=${opts.qaPerSample}` : ''})...`);

  const sample = sampleLocomo(dataset, { n: opts.n, seed: opts.seed, qaPerSample: opts.qaPerSample });
  writeFileSync(opts.outPath, JSON.stringify(sample, null, 2));

  const totalQa = sample.reduce((s, c) => s + c.qa.length, 0);
  const counts: Record<number, number> = {};
  for (const c of sample) for (const q of c.qa) counts[q.category] = (counts[q.category] ?? 0) + 1;
  log(`Sampled ${sample.length} conversation(s), ${totalQa} QA pair(s) -> ${opts.outPath}`);
  for (const cat of LOCOMO_CATEGORIES) log(`  ${cat} (${CATEGORY_NAMES[cat]}): ${counts[cat] ?? 0}`);
}

if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const datasetPath = get('--dataset') ?? '.eval-data/locomo/locomo10.json';
  const nRaw = get('--n');
  const seed = Number(get('--seed') ?? '42');
  const qaPerSampleRaw = get('--qa-per-sample');
  const outPath = get('--out') ?? '.eval-data/locomo/sample.json';

  await runSample({
    datasetPath,
    n: nRaw !== undefined ? Number(nRaw) : undefined,
    seed,
    qaPerSample: qaPerSampleRaw !== undefined ? Number(qaPerSampleRaw) : undefined,
    outPath,
  });
}
