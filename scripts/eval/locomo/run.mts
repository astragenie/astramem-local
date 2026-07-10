/**
 * Run orchestrator: sample (download + select) -> spin one or more isolated
 * throwaway daemons -> ingest -> distill-wait -> answer -> write hypotheses
 * + a run manifest, then tear the daemon(s) down. Mirrors
 * ../longmemeval/run-smoke.mts's shape and flag surface, adapted for
 * LoCoMo's conversation-centric data model (FEAT-457): shards partition
 * CONVERSATIONS (not questions), and every QA pair belonging to a
 * conversation is answered against that one conversation's project after
 * its sessions finish distilling.
 *
 * bun scripts/eval/locomo/run.mts [--dataset <path>] [--n <conversations>]
 *   [--qa-per-sample <cap>] [--seed 42] [--k 10] [--concurrency 4]
 *   [--distill-timeout-ms 900000] [--shards 1]
 *   [--run-dir .eval-data/locomo/runs/<timestamp>] [--ollama-url <url>]
 *
 * Resume a killed run (FEAT-462): re-attach to an existing --run-dir,
 * respawn shard daemons on their existing datadirs, and skip re-ingesting
 * every session each shard's ledger already shows completed ok. Pass the
 * SAME --dataset/--seed/--n/--qa-per-sample/--shards flags as the original
 * invocation (the sample and shard partitioning are deterministic given
 * those). Mirrors ../longmemeval/run-smoke.mts's --resume exactly (FEAT-462
 * AC-6 — same shared/resume-ledger.ts machinery, same flag surface):
 * bun scripts/eval/locomo/run.mts --resume <run-dir>
 *   [...same flags as the original invocation]
 *
 * Throughput dry run (ingest+distill only, no answer/judge step, no Azure):
 * bun scripts/eval/locomo/run.mts --dry-run-throughput
 *   [--shards 2] [--dry-run-conversations 1] [--distill-timeout-ms <ms>]
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadDataset, sampleLocomo, ensureDatasetDownloaded } from './lib/dataset.js';
import { LOCOMO_CATEGORIES, CATEGORY_NAMES, sessionNumbers, type LoCoMoSample } from './lib/types.js';
import {
  spawnEvalDaemon, waitForHealthStatus, killDaemon, makeIsolatedEvalEnv, cleanupIsolatedEvalEnv,
  type DaemonHandle,
} from '../shared/spawn-daemon.js';
import { ingestConversations, type IngestManifest } from './ingest.mts';
import { waitForSamplesDistilled, type DistillWaitResult } from './distill-wait.mts';
import { answerConversations, writeHypothesesJsonl, type AnswerOutcome } from './answer.mts';
import { resolveAzureConfig, type AzureConfig } from '../shared/config.js';
import { partitionRoundRobin } from '../shared/shard.js';
import { resolveOllamaBaseUrl, queryOllamaStatus, printOllamaTuningGuidance } from '../shared/ollama-tuning.js';
import { ledgerCompletedMap } from '../shared/resume-ledger.js';

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (flag: string): boolean => args.includes(flag);

const datasetPath = get('--dataset') ?? '.eval-data/locomo/locomo10.json';
const seed = Number(get('--seed') ?? '42');
const k = Number(get('--k') ?? '10');
const concurrency = Number(get('--concurrency') ?? '4');
const shards = Number(get('--shards') ?? '1');
const ollamaBaseUrl = resolveOllamaBaseUrl(get('--ollama-url'));
const dryRunThroughput = has('--dry-run-throughput');
// FEAT-462 AC-1/AC-6: see ../longmemeval/run-smoke.mts's identical comment.
const resumeDir = get('--resume');

if (dryRunThroughput) {
  await runDryRunThroughput();
} else {
  await runFull();
}

// ── shared per-shard runner ─────────────────────────────────────────────────

interface ShardResult {
  shard: number;
  sample_ids: string[];
  timings: Record<string, number>;
  ingestManifest: IngestManifest;
  distillResult: DistillWaitResult;
  outcomes: AnswerOutcome[] | null;
}

async function runShard(opts: {
  shardIndex: number;
  totalShards: number;
  samples: LoCoMoSample[];
  runDir: string;
  concurrency: number;
  distillTimeoutMs: number;
  k: number;
  azureCfg: AzureConfig | null; // null => ingest+distill only, skip answer (dry-run-throughput mode)
  /** FEAT-462 AC-1: see ../longmemeval/run-smoke.mts's identical option —
   *  defaults to false so every existing call site is unaffected (AC-7). */
  resume?: boolean;
}): Promise<ShardResult> {
  const { shardIndex, totalShards, samples, runDir, concurrency, distillTimeoutMs, k, azureCfg, resume = false } = opts;
  const label = totalShards > 1 ? `shard-${shardIndex}` : undefined;
  const shardDir = label ? join(runDir, label) : runDir;
  const dataDir = join(shardDir, 'datadir');
  // Crash-safe ledger (FEAT-462 AC-1/AC-4) — see run-smoke.mts's identical
  // comment for the always-write / conditional-read rationale.
  const ledgerPath = join(shardDir, 'ingest-ledger.jsonl');
  const resumeCompleted = resume ? ledgerCompletedMap(ledgerPath) : undefined;
  const token = randomBytes(32).toString('hex');
  const isolated = makeIsolatedEvalEnv(label ? `locomo-${label}` : 'locomo-run');
  const timings: Record<string, number> = {};
  let daemon: DaemonHandle | undefined;
  const tag = label ? `[${label}] ` : '';
  let reportedDeath = false;

  // Same daemon-death visibility fix as ../longmemeval/run-smoke.mts -- see
  // that file's header comment for the full incident writeup.
  function checkDaemonAlive(): void {
    if (reportedDeath || !daemon) return;
    const { code, signal } = daemon.exitInfo();
    if (code === null && signal === null) return;
    reportedDeath = true;
    console.error(`\n${tag}DAEMON DIED (exit code=${code} signal=${signal}) — this shard's remaining polls will fail. Captured daemon stdout/stderr:`);
    console.error(`${tag}--- daemon stdout ---\n${daemon.stdout()}`);
    console.error(`${tag}--- daemon stderr ---\n${daemon.stderr()}`);
  }

  try {
    let t = Date.now();
    daemon = await spawnEvalDaemon({ dataDir, token, env: isolated.env });
    await waitForHealthStatus(daemon.baseUrl, ['ok'], 60_000);
    timings.daemon_boot_ms = Date.now() - t;
    console.log(`${tag}daemon up at ${daemon.baseUrl} (${timings.daemon_boot_ms}ms)`);

    t = Date.now();
    const ingestManifest = await ingestConversations(
      { baseUrl: daemon.baseUrl, token },
      samples,
      {
        concurrency,
        ledgerPath,
        resumeCompleted,
        onProgress: (d, total) => { checkDaemonAlive(); if (d % 50 === 0 || d === total) process.stdout.write(`\r  ${tag}${d}/${total} sessions ingested`); },
      },
    );
    process.stdout.write('\n');
    timings.ingest_ms = Date.now() - t;
    if (label) writeFileSync(join(runDir, label, 'ingest-manifest.json'), JSON.stringify(ingestManifest, null, 2));
    console.log(`${tag}ingest done in ${timings.ingest_ms}ms: ${ingestManifest.ok_count} ok, ${ingestManifest.failed_count} failed.`);

    t = Date.now();
    const distillResult = await waitForSamplesDistilled(
      { baseUrl: daemon.baseUrl, token },
      ingestManifest.by_sample,
      { timeoutMs: distillTimeoutMs, onProgress: (r, total) => { checkDaemonAlive(); process.stdout.write(`\r  ${tag}${r}/${total} conversations distilled`); } },
    );
    process.stdout.write('\n');
    timings.distill_wait_ms = Date.now() - t;
    if (label) writeFileSync(join(runDir, label, 'distill-wait-result.json'), JSON.stringify(distillResult, null, 2));
    console.log(`${tag}distill-wait done in ${timings.distill_wait_ms}ms: ${distillResult.ready_sample_ids.length} ready, ${distillResult.timed_out_sample_ids.length} timed out.`);

    let outcomes: AnswerOutcome[] | null = null;
    if (azureCfg) {
      t = Date.now();
      outcomes = await answerConversations(
        { baseUrl: daemon.baseUrl, token },
        azureCfg,
        samples,
        { k, readySampleIds: new Set(distillResult.ready_sample_ids) },
      );
      timings.answer_ms = Date.now() - t;
      console.log(`${tag}answered ${outcomes.length} QA pairs in ${timings.answer_ms}ms`);
    }

    return { shard: shardIndex, sample_ids: samples.map(s => s.sample_id), timings, ingestManifest, distillResult, outcomes };
  } catch (err) {
    checkDaemonAlive();
    if (daemon && !reportedDeath) {
      console.error(`${tag}shard failed while daemon process is still alive; captured stdout/stderr so far:\n--- stdout ---\n${daemon.stdout()}\n--- stderr ---\n${daemon.stderr()}`);
    }
    throw err;
  } finally {
    if (daemon) await killDaemon(daemon, 'SIGTERM', 5_000);
    cleanupIsolatedEvalEnv(isolated);
  }
}

function mergeIngestManifests(results: IngestManifest[]): IngestManifest {
  const by_sample: IngestManifest['by_sample'] = {};
  const outcomes = results.flatMap(r => r.outcomes);
  for (const r of results) Object.assign(by_sample, r.by_sample);
  return {
    total_sessions: results.reduce((s, r) => s + r.total_sessions, 0),
    ok_count: results.reduce((s, r) => s + r.ok_count, 0),
    failed_count: results.reduce((s, r) => s + r.failed_count, 0),
    ms: Math.max(0, ...results.map(r => r.ms)),
    by_sample,
    outcomes,
  };
}

function mergeDistillResults(results: DistillWaitResult[]): DistillWaitResult {
  const per_sample_ms: Record<string, number> = {};
  for (const r of results) Object.assign(per_sample_ms, r.per_sample_ms);
  return {
    ready_sample_ids: results.flatMap(r => r.ready_sample_ids),
    timed_out_sample_ids: results.flatMap(r => r.timed_out_sample_ids),
    per_sample_ms,
  };
}

// ── normal run (sharded or single) ─────────────────────────────────────────

async function runFull(): Promise<void> {
  const nRaw = get('--n');
  const qaPerSampleRaw = get('--qa-per-sample');
  const distillTimeoutMs = Number(get('--distill-timeout-ms') ?? String(15 * 60_000));
  const runDir = resumeDir ?? get('--run-dir') ?? join('.eval-data', 'locomo', 'runs', new Date().toISOString().replace(/[:.]/g, '-'));

  if (resumeDir && !existsSync(resumeDir)) {
    console.error(`--resume ${resumeDir}: run dir does not exist — nothing to resume.`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(runDir, { recursive: true });
  console.log(resumeDir ? `Resuming run dir: ${runDir} (ledger-driven skip of already-ingested sessions)` : `Run dir: ${runDir}`);

  const overallStart = Date.now();
  const timings: Record<string, number> = {};

  const { downloaded } = await ensureDatasetDownloaded(datasetPath);
  console.log(downloaded ? `Downloaded LoCoMo dataset -> ${datasetPath}` : `Using existing dataset at ${datasetPath}`);

  let tStart = Date.now();
  const dataset = loadDataset(datasetPath);
  timings.load_dataset_ms = Date.now() - tStart;

  const sample = sampleLocomo(dataset, {
    n: nRaw !== undefined ? Number(nRaw) : undefined,
    seed,
    qaPerSample: qaPerSampleRaw !== undefined ? Number(qaPerSampleRaw) : undefined,
  });
  writeFileSync(join(runDir, 'sample.json'), JSON.stringify(sample, null, 2));
  {
    const totalQa = sample.reduce((s, c) => s + c.qa.length, 0);
    const counts: Record<number, number> = {};
    for (const c of sample) for (const q of c.qa) counts[q.category] = (counts[q.category] ?? 0) + 1;
    console.log(`Sample: ${sample.length} conversation(s), ${totalQa} QA pair(s) -> ${join(runDir, 'sample.json')}`);
    for (const cat of LOCOMO_CATEGORIES) console.log(`  ${cat} (${CATEGORY_NAMES[cat]}): ${counts[cat] ?? 0}`);
  }

  const ollamaStatus = await queryOllamaStatus(ollamaBaseUrl);
  printOllamaTuningGuidance(ollamaStatus, ollamaBaseUrl);

  if (shards > 1) console.log(`\nSharding into ${shards} isolated daemons (round-robin by sample_id).`);
  const shardBuckets = partitionRoundRobin(sample, Math.max(1, shards));
  console.log(`Shard sizes: ${shardBuckets.map(b => b.length).join(', ')} conversation(s).`);

  let exitCode = 0;
  const azureCfg = resolveAzureConfig();
  console.log(`Answering via Azure deployment "${azureCfg.answererDeployment}" (reasoning_effort=minimal, k=${k})...`);

  tStart = Date.now();
  const settled = await Promise.allSettled(
    shardBuckets.map((samples, i) => runShard({
      shardIndex: i, totalShards: shardBuckets.length, samples, runDir, concurrency, distillTimeoutMs, k, azureCfg,
      resume: Boolean(resumeDir),
    })),
  );
  timings.shards_wall_clock_ms = Date.now() - tStart;

  const perShardTimings: Record<string, Record<string, number>> = {};
  const ingestManifests: IngestManifest[] = [];
  const distillResults: DistillWaitResult[] = [];
  let allOutcomes: AnswerOutcome[] = [];
  const failedShards: number[] = [];

  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      perShardTimings[`shard_${i}`] = r.value.timings;
      ingestManifests.push(r.value.ingestManifest);
      distillResults.push(r.value.distillResult);
      if (r.value.outcomes) allOutcomes.push(...r.value.outcomes);
    } else {
      failedShards.push(i);
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`shard-${i} FAILED: ${reason}`);
      const failedSamples = shardBuckets[i]!;
      ingestManifests.push({
        total_sessions: 0, ok_count: 0,
        failed_count: failedSamples.reduce((s, c) => s + sessionNumbers(c.conversation).length, 0),
        ms: 0, by_sample: {}, outcomes: [],
      });
      distillResults.push({ ready_sample_ids: [], timed_out_sample_ids: failedSamples.map(c => c.sample_id), per_sample_ms: {} });
      for (const sample of failedSamples) {
        sample.qa.forEach((qa, qi) => {
          allOutcomes.push({ qa_id: `${sample.sample_id}#${qi}`, sample_id: sample.sample_id, category: qa.category, hypothesis: `(skipped: shard-${i} failed — ${reason})`, hit_count: 0 });
        });
      }
    }
  });

  const manifest = mergeIngestManifests(ingestManifests);
  const distillResult = mergeDistillResults(distillResults);
  writeFileSync(join(runDir, 'ingest-manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(runDir, 'distill-wait-result.json'), JSON.stringify(distillResult, null, 2));

  const orderIndex = new Map(sample.map((c, i) => [c.sample_id, i]));
  allOutcomes.sort((a, b) => (orderIndex.get(a.sample_id)! - orderIndex.get(b.sample_id)!) || (a.qa_id < b.qa_id ? -1 : 1));

  const hypPath = join(runDir, 'hypotheses.jsonl');
  writeHypothesesJsonl(allOutcomes, hypPath);
  console.log(`Wrote ${allOutcomes.length} hypotheses -> ${hypPath}`);

  timings.total_ms = Date.now() - overallStart;
  const manifestOut = {
    run_dir: runDir,
    config: { datasetPath, n: sample.length, seed, k, concurrency, distillTimeoutMs, shards: shardBuckets.length, answererDeployment: azureCfg.answererDeployment },
    counts: {
      sampled_conversations: sample.length,
      sampled_qa: sample.reduce((s, c) => s + c.qa.length, 0),
      sessions_total: manifest.total_sessions,
      ingest_ok: manifest.ok_count,
      ingest_failed: manifest.failed_count,
      distill_ready: distillResult.ready_sample_ids.length,
      distill_timed_out: distillResult.timed_out_sample_ids.length,
    },
    timings,
    per_shard_timings: perShardTimings,
    failed_shards: failedShards,
    timed_out_sample_ids: distillResult.timed_out_sample_ids,
  };
  writeFileSync(join(runDir, 'run-manifest.json'), JSON.stringify(manifestOut, null, 2));
  console.log(`\nRun manifest -> ${join(runDir, 'run-manifest.json')}`);
  console.log(`Total wall clock: ${timings.total_ms}ms (shards ran for ${timings.shards_wall_clock_ms}ms)`);
  console.log(`\nNext: judge the hypotheses, e.g.\n  bun scripts/eval/locomo/judge.mts --hyp ${hypPath} --ref ${join(runDir, 'sample.json')}`);

  if (manifest.failed_count > 0 || distillResult.timed_out_sample_ids.length > 0 || failedShards.length > 0) exitCode = 1;
  process.exitCode = exitCode;
}

// ── --dry-run-throughput mode ───────────────────────────────────────────────

async function runDryRunThroughput(): Promise<void> {
  const dryRunConversations = Number(get('--dry-run-conversations') ?? '1');
  const distillTimeoutMs = Number(get('--distill-timeout-ms') ?? String(2 * 60 * 60_000)); // 2h -- a real distill pass
  const effectiveShards = Math.max(1, shards);
  const runDir = get('--run-dir') ?? join('.eval-data', 'locomo', 'runs', `throughput-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(runDir, { recursive: true });
  console.log(`Throughput dry-run dir: ${runDir}`);
  console.log(`Sampling ${dryRunConversations} real conversation(s) (seed=${seed}) — ingest+distill ONLY, no answer/judge step, no Azure.`);

  const { downloaded } = await ensureDatasetDownloaded(datasetPath);
  console.log(downloaded ? `Downloaded LoCoMo dataset -> ${datasetPath}` : `Using existing dataset at ${datasetPath}`);
  const dataset = loadDataset(datasetPath);
  const sample = sampleLocomo(dataset, { n: dryRunConversations, seed });
  writeFileSync(join(runDir, 'sample.json'), JSON.stringify(sample, null, 2));
  const totalSessions = sample.reduce((s, c) => s + sessionNumbers(c.conversation).length, 0);
  console.log(`Sample: ${sample.length} conversation(s), ${totalSessions} sessions total.`);
  for (const c of sample) console.log(`  ${c.sample_id}: ${sessionNumbers(c.conversation).length} sessions, ${c.qa.length} QA pairs`);

  const statusBefore = await queryOllamaStatus(ollamaBaseUrl);
  printOllamaTuningGuidance(statusBefore, ollamaBaseUrl);

  const buckets = partitionRoundRobin(sample, effectiveShards);
  console.log(`Shard sizes: ${buckets.map(b => b.length).join(', ')} conversation(s).`);
  const t0 = Date.now();
  const results = await Promise.allSettled(
    buckets.map((samples, i) => runShard({
      shardIndex: i, totalShards: effectiveShards, samples, runDir: join(runDir, `shards-${effectiveShards}`), concurrency, distillTimeoutMs, k,
      azureCfg: null, // ingest+distill only
    })),
  );
  const ms = Date.now() - t0;

  let sessionsDone = 0;
  const failures: string[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') sessionsDone += r.value.ingestManifest.ok_count;
    else failures.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
  }
  if (failures.length > 0) console.error(`shards=${effectiveShards} had ${failures.length} failed shard(s): ${failures.join(' | ')}`);

  const secsPerSession = sessionsDone > 0 ? ms / 1000 / sessionsDone : null;
  console.log(`\n=== Throughput summary ===`);
  if (secsPerSession !== null) {
    console.log(`shards=${effectiveShards}: ${sessionsDone}/${totalSessions} sessions distilled in ${ms}ms (${secsPerSession.toFixed(1)}s/session)`);
    const fullDatasetSessions = dataset.reduce((s, c) => s + sessionNumbers(c.conversation).length, 0);
    const fullDatasetQa = dataset.reduce((s, c) => s + c.qa.length, 0);
    const estHours = (fullDatasetSessions * secsPerSession) / 3600;
    console.log(`Extrapolated full dataset (10 conversations, ${fullDatasetSessions} sessions, ${fullDatasetQa} QA pairs): ~${estHours.toFixed(1)}h ingest+distill at this rate, single-threaded-equivalent per shard.`);
  } else {
    console.log(`No sessions completed within the ${distillTimeoutMs}ms distill timeout — raise --distill-timeout-ms and retry.`);
  }

  const out = {
    run_dir: runDir,
    config: { datasetPath, seed, dryRunConversations, effectiveShards, distillTimeoutMs },
    sample_ids: sample.map(c => c.sample_id),
    total_sessions_sampled: totalSessions,
    ollama_status_before: statusBefore,
    measured: { shards: effectiveShards, ms, sessions: sessionsDone, secs_per_session: secsPerSession },
  };
  writeFileSync(join(runDir, 'throughput-dry-run.json'), JSON.stringify(out, null, 2));
  console.log(`\nThroughput dry-run result -> ${join(runDir, 'throughput-dry-run.json')}`);
}
