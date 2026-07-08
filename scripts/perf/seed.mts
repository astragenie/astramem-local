/**
 * Perf corpus seeder — spins an isolated mock-provider daemon, seeds N
 * memories via POST /remember (concurrency ~16), plus a small fixed batch of
 * /ingest/transcript sessions (so /sessions/:id/digest, /agents/:agent/profile,
 * and entity-linked search have real data to hit). Persists the datadir under
 * .eval-data/perf/<N>/datadir + a manifest.json — reruns skip seeding when the
 * manifest says done, unless --force is passed.
 *
 * Usage: bun scripts/perf/seed.mts [--sizes 1000,10000,100000] [--concurrency 16] [--force]
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  spawnEvalDaemon, waitForHealthStatus, killDaemon, makeIsolatedEvalEnv, cleanupIsolatedEvalEnv,
} from '../eval/longmemeval/lib/spawn-daemon.js';
import { mapWithConcurrency } from '../eval/longmemeval/lib/concurrency.js';
import { generateCorpus, REPOS, AGENTS } from './lib/corpus.js';
import { remember, ingestTranscript, health, type PerfClientOpts } from './lib/perf-client.js';

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (flag: string): boolean => args.includes(flag);

const sizes = (get('--sizes') ?? '1000,10000,100000').split(',').map(Number);
const concurrency = Number(get('--concurrency') ?? '16');
const force = has('--force');
const SEED_TIME_BUDGET_MS = 20 * 60_000;

const PERF_DATA_ROOT = join('.eval-data', 'perf');

export interface PerfManifest {
  n: number;
  requestedN: number;
  seed: number;
  token: string;
  completed: boolean;
  wallClockMs: number;
  sampleMemoryId: string;
  sampleSessionId: string;
  sampleAgent: string;
  sampleRepo: string;
  seededAt: string;
}

async function waitForQueueDrained(client: PerfClientOpts, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await health(client) as { queue?: Record<string, number> };
    const pending = (h.queue?.pending ?? 0) + (h.queue?.running ?? 0);
    if (pending === 0) return;
    await new Promise(r => setTimeout(r, 500));
  }
  console.warn(`  WARNING: queue did not fully drain within ${timeoutMs}ms — enrichment sessions may still be distilling.`);
}

async function seedSize(requestedN: number): Promise<void> {
  const dir = join(PERF_DATA_ROOT, String(requestedN));
  const dataDir = join(dir, 'datadir');
  const manifestPath = join(dir, 'manifest.json');

  if (!force && existsSync(manifestPath)) {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf8')) as PerfManifest;
    if (existing.completed && existing.requestedN === requestedN) {
      console.log(`[${requestedN}] manifest already complete (n=${existing.n}) — skipping. Use --force to reseed.`);
      return;
    }
  }

  console.log(`\n=== Seeding corpus size ${requestedN} ===`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  const token = randomBytes(32).toString('hex');
  const isolated = makeIsolatedEvalEnv(`perf-seed-${requestedN}`);
  const daemon = await spawnEvalDaemon({
    dataDir,
    token,
    env: { ...isolated.env, ASTRA_MEMORY_MOCK_PROVIDERS: '1' },
  });
  const client: PerfClientOpts = { baseUrl: daemon.baseUrl, token };

  try {
    await waitForHealthStatus(daemon.baseUrl, ['ok'], 60_000);
    console.log(`  daemon up at ${daemon.baseUrl}`);

    const t0 = Date.now();
    const corpus = generateCorpus(requestedN);
    let actualN = requestedN;
    let firstMemoryId = '';
    let done = 0;

    // Time-budget guard for the largest tier: if the observed rate projects
    // past SEED_TIME_BUDGET_MS, stop early and keep whatever was seeded
    // rather than blowing past the ~20min ceiling (task instruction).
    let aborted = false;
    const CHECK_EVERY = 2000;

    await mapWithConcurrency(corpus, concurrency, async (item, idx) => {
      if (aborted) return;
      const res = await remember(client, item);
      if (idx === 0) firstMemoryId = res.id;
      done++;
      if (done % 5000 === 0 || done === corpus.length) {
        process.stdout.write(`\r  ${done}/${corpus.length} remembered`);
      }
      if (done % CHECK_EVERY === 0 && requestedN >= 50_000) {
        const elapsed = Date.now() - t0;
        const rate = done / elapsed; // items/ms
        const projectedTotal = corpus.length / rate;
        if (projectedTotal > SEED_TIME_BUDGET_MS && !aborted) {
          aborted = true;
          actualN = done;
          console.warn(
            `\n  WARNING: projected total seed time ${(projectedTotal / 60_000).toFixed(1)}min exceeds ` +
            `${SEED_TIME_BUDGET_MS / 60_000}min budget at ${done} items — stopping early at n=${actualN}.`,
          );
        }
      }
    });
    process.stdout.write('\n');

    // Small fixed enrichment batch — sessions + entities + digest-able data.
    // Independent of corpus size; gives /sessions/:id/digest, /agents/:agent/profile,
    // and entity-linked /search real, non-empty data to hit at every corpus size.
    const ENRICH_SESSIONS = 20;
    let sampleSessionId = '';
    const sampleAgent = AGENTS[0]!;
    const sampleRepo = REPOS[0]!;
    for (let i = 0; i < ENRICH_SESSIONS; i++) {
      const sessionId = `perf-session-${requestedN}-${i}`;
      if (i === 0) sampleSessionId = sessionId;
      await ingestTranscript(client, {
        sessionId,
        projectId: 'perf-harness',
        agentType: sampleAgent,
        turns: [
          { role: 'user', text: `Let's use sqlite-vec for v1 vector storage. Priya Nair will review. TODO: write a migration guide. This is astramemory-local, written in TypeScript.` },
          { role: 'assistant', text: `Sounds good — sqlite-vec it is. I'll loop in Priya Nair. Noted the TODO. User prefers markdown summaries.` },
        ],
      }, `perf-enrich-${requestedN}-${i}`);
    }
    console.log(`  enrichment: ${ENRICH_SESSIONS} sessions ingested, waiting for distill queue to drain...`);
    await waitForQueueDrained(client);

    const wallClockMs = Date.now() - t0;
    const manifest: PerfManifest = {
      n: actualN,
      requestedN,
      seed: 1337,
      token,
      completed: true,
      wallClockMs,
      sampleMemoryId: firstMemoryId,
      sampleSessionId,
      sampleAgent,
      sampleRepo,
      seededAt: new Date().toISOString(),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`  done: n=${actualN} in ${(wallClockMs / 1000).toFixed(1)}s -> ${manifestPath}`);
  } finally {
    await killDaemon(daemon, 'SIGTERM', 5_000);
    cleanupIsolatedEvalEnv(isolated);
  }
}

for (const size of sizes) {
  await seedSize(size);
}
console.log('\nAll requested corpus sizes seeded (or already present).');
