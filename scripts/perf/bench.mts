/**
 * Perf endpoint benchmarks — spins the persisted per-size datadir (seeded by
 * seed.mts) as a warm daemon, runs each endpoint for warmup+iterations
 * requests, reports p50/p95/max/mean (warmup excluded).
 *
 * Usage: bun scripts/perf/bench.mts [--sizes 1000,10000,100000] [--iterations 150] [--warmup 5]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  spawnEvalDaemon, waitForHealthStatus, killDaemon, makeIsolatedEvalEnv, cleanupIsolatedEvalEnv,
} from '../eval/longmemeval/lib/spawn-daemon.js';
import { search, recall, recallPack, agentProfile, sessionDigest, memoryWhy, health, type PerfClientOpts } from './lib/perf-client.js';
import { timeIterations, type LatencyStats } from './lib/stats.js';
import { BENCH_QUERIES } from './lib/corpus.js';
import type { PerfManifest } from './seed.mts';

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const sizes = (get('--sizes') ?? '1000,10000,100000').split(',').map(Number);
const iterations = Number(get('--iterations') ?? '150');
const warmup = Number(get('--warmup') ?? '5');

const PERF_DATA_ROOT = join('.eval-data', 'perf');

export interface EndpointResult {
  endpoint: string;
  stats: LatencyStats;
}

export interface BenchResult {
  n: number;
  iterations: number;
  warmup: number;
  endpoints: EndpointResult[];
  measuredAt: string;
}

let queryCounter = 0;
function nextQuery(): string {
  return BENCH_QUERIES[queryCounter++ % BENCH_QUERIES.length]!;
}

async function benchSize(n: number): Promise<BenchResult | null> {
  const dir = join(PERF_DATA_ROOT, String(n));
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.warn(`[${n}] no manifest at ${manifestPath} — run seed.mts first. Skipping.`);
    return null;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PerfManifest;
  const dataDir = join(dir, 'datadir');

  console.log(`\n=== Benchmarking corpus size ${manifest.n} (requested ${n}) ===`);
  const isolated = makeIsolatedEvalEnv(`perf-bench-${n}`);
  const daemon = await spawnEvalDaemon({
    dataDir,
    token: manifest.token,
    env: { ...isolated.env, ASTRA_MEMORY_MOCK_PROVIDERS: '1' },
  });
  const client: PerfClientOpts = { baseUrl: daemon.baseUrl, token: manifest.token };

  const endpoints: EndpointResult[] = [];
  try {
    await waitForHealthStatus(daemon.baseUrl, ['ok'], 60_000);
    console.log(`  daemon up at ${daemon.baseUrl}, running ${warmup}+${iterations} iterations per endpoint...`);

    endpoints.push({
      endpoint: 'GET /search',
      stats: await timeIterations(() => search(client, nextQuery(), 10), { iterations, warmup }),
    });
    endpoints.push({
      endpoint: 'POST /recall (k=5)',
      stats: await timeIterations(() => recall(client, nextQuery(), 5), { iterations, warmup }),
    });
    endpoints.push({
      endpoint: 'POST /recall/pack',
      stats: await timeIterations(() => recallPack(client, manifest.sampleRepo), { iterations, warmup }),
    });
    endpoints.push({
      endpoint: 'GET /agents/:agent/profile',
      stats: await timeIterations(() => agentProfile(client, manifest.sampleAgent), { iterations, warmup }),
    });
    endpoints.push({
      endpoint: 'GET /sessions/:id/digest',
      stats: await timeIterations(() => sessionDigest(client, manifest.sampleSessionId), { iterations, warmup }),
    });
    endpoints.push({
      endpoint: 'GET /memory/:id/why',
      stats: await timeIterations(() => memoryWhy(client, manifest.sampleMemoryId), { iterations, warmup }),
    });
    endpoints.push({
      endpoint: 'GET /health',
      stats: await timeIterations(() => health(client), { iterations, warmup }),
    });

    for (const e of endpoints) {
      console.log(`  ${e.endpoint.padEnd(28)} p50=${e.stats.p50.toFixed(2)}ms p95=${e.stats.p95.toFixed(2)}ms max=${e.stats.max.toFixed(2)}ms (n=${e.stats.n})`);
    }
  } finally {
    await killDaemon(daemon, 'SIGTERM', 5_000);
    cleanupIsolatedEvalEnv(isolated);
  }

  const result: BenchResult = { n: manifest.n, iterations, warmup, endpoints, measuredAt: new Date().toISOString() };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bench-results.json'), JSON.stringify(result, null, 2));
  return result;
}

const allResults: BenchResult[] = [];
for (const size of sizes) {
  const r = await benchSize(size);
  if (r) allResults.push(r);
}
console.log(`\nBenchmarked ${allResults.length} corpus size(s).`);
