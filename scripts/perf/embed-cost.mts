/**
 * Measures the real Ollama mxbai-embed-large embed call latency in
 * isolation (single call + a few repeats), separate from the mock-provider
 * benchmarks in bench.mts — so the report can state "add ~Xms real-world
 * embed cost to /search//recall rows" instead of pretending the mock
 * provider's ~0ms embed step is representative of production latency.
 *
 * Usage: bun scripts/perf/embed-cost.mts [--iterations 5] [--ollama-url http://127.0.0.1:11434]
 */
import { OllamaEmbedProvider } from '../../src/providers/embed/ollama.js';
import { summarize } from './lib/stats.ts';
import { BENCH_QUERIES } from './lib/corpus.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const iterations = Number(get('--iterations') ?? '5');
const baseUrl = get('--ollama-url') ?? 'http://127.0.0.1:11434';

const provider = new OllamaEmbedProvider({ baseUrl, model: 'mxbai-embed-large', dim: 1024 });

console.log(`Checking Ollama health at ${baseUrl}...`);
const h = await provider.health();
if (!h.ok) {
  console.error(`Ollama not healthy: ${h.error ?? 'unknown error'}. Skipping embed-cost measurement — report will note embed cost as unmeasured.`);
  writeFileSync(join('.eval-data', 'perf', 'embed-cost.json'), JSON.stringify({ measured: false, error: h.error ?? 'unknown' }, null, 2));
  process.exit(0);
}
console.log(`Ollama healthy (model=${provider.model}, dim=${provider.dim}). Running ${iterations} single-text embed calls...`);

const samples: number[] = [];
for (let i = 0; i < iterations; i++) {
  const text = BENCH_QUERIES[i % BENCH_QUERIES.length]!;
  const t0 = performance.now();
  await provider.embed([text]);
  const ms = performance.now() - t0;
  samples.push(ms);
  console.log(`  call ${i + 1}/${iterations}: ${ms.toFixed(1)}ms`);
}

const stats = summarize(samples);
console.log(`\nReal Ollama embed (mxbai-embed-large, single query): p50=${stats.p50.toFixed(1)}ms p95=${stats.p95.toFixed(1)}ms max=${stats.max.toFixed(1)}ms mean=${stats.mean.toFixed(1)}ms`);

writeFileSync(join('.eval-data', 'perf', 'embed-cost.json'), JSON.stringify({ measured: true, model: provider.model, dim: provider.dim, stats, measuredAt: new Date().toISOString() }, null, 2));
