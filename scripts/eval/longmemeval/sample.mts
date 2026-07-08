/**
 * Stratified sampler CLI (plan doc section 5, phase 1).
 *
 * bun scripts/eval/longmemeval/sample.mts --dataset <path> --n 50 --seed 42 --out <path>
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadDataset, sampleStratified } from './lib/dataset.js';
import { QUESTION_TYPES, isAbstention } from './lib/types.js';

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const datasetPath = get('--dataset');
  const n = Number(get('--n') ?? '50');
  const seed = Number(get('--seed') ?? '42');
  const outPath = get('--out') ?? 'longmemeval-sample.json';

  if (!datasetPath) {
    console.error('Usage: bun sample.mts --dataset <path> [--n 50] [--seed 42] [--out <path>]');
    process.exit(1);
  }

  console.log(`Loading dataset from ${datasetPath}...`);
  const dataset = loadDataset(datasetPath);
  console.log(`Loaded ${dataset.length} questions. Sampling n=${n} (seed=${seed})...`);

  const sample = sampleStratified(dataset, { n, seed });
  writeFileSync(outPath, JSON.stringify(sample, null, 2));

  const counts: Record<string, number> = {};
  let absCount = 0;
  for (const q of sample) {
    counts[q.question_type] = (counts[q.question_type] ?? 0) + 1;
    if (isAbstention(q)) absCount++;
  }
  console.log(`Sampled ${sample.length} questions -> ${outPath}`);
  for (const t of QUESTION_TYPES) console.log(`  ${t}: ${counts[t] ?? 0}`);
  console.log(`  (of which _abs abstention: ${absCount})`);
}
