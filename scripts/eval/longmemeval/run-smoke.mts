/**
 * Phase-1 smoke runbook orchestrator (plan doc section 5, phase 1):
 * sample -> spin one or more isolated throwaway daemons -> ingest ->
 * distill-wait -> answer -> write hypotheses + a run manifest, then tear the
 * daemon(s) down.
 *
 * Single-daemon (default, `--shards 1`) behavior and output file layout is
 * unchanged from before sharding was added. With `--shards N` (N > 1), the
 * sampled questions are round-robin-partitioned (plan doc section 4 lever 2)
 * across N isolated daemons — each its own port + fully sandboxed
 * APPDATA/HOME env (../shared/spawn-daemon.ts's makeIsolatedEvalEnv) — run
 * concurrently, then merged back into one hypotheses.jsonl / manifest. All
 * shards share the ONE local Ollama server (see ../shared/ollama-tuning.ts) — this
 * only buys real speedup if Ollama itself can serve requests concurrently.
 *
 * bun scripts/eval/longmemeval/run-smoke.mts [--dataset <path>] [--n 50]
 *   [--seed 42] [--k 10] [--concurrency 4] [--distill-timeout-ms 900000]
 *   [--shards 1] [--run-dir .eval-data/runs/<timestamp>] [--ollama-url <url>]
 *
 * Throughput dry run (ingest+distill only, no answer/judge step):
 * bun scripts/eval/longmemeval/run-smoke.mts --dry-run-throughput
 *   [--shards 2] [--dry-run-questions 2] [--seed 42]
 *   [--dry-run-compare-baseline] [--distill-timeout-ms <ms>]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadDataset, sampleStratified } from './lib/dataset.js';
import { QUESTION_TYPES, isAbstention, type LongMemEvalQuestion } from './lib/types.js';
import {
  spawnEvalDaemon, waitForHealthStatus, killDaemon, makeIsolatedEvalEnv, cleanupIsolatedEvalEnv,
  type DaemonHandle,
} from '../shared/spawn-daemon.js';
import { ingestQuestions, type IngestManifest } from './ingest.mts';
import { waitForQuestionsDistilled, type DistillWaitResult } from './distill-wait.mts';
import { answerQuestions, writeHypothesesJsonl, type AnswerOutcome } from './answer.mts';
import { resolveAzureConfig, type AzureConfig } from '../shared/config.js';
import { partitionRoundRobin } from '../shared/shard.js';
import { resolveOllamaBaseUrl, queryOllamaStatus, printOllamaTuningGuidance, detectPossibleReload } from '../shared/ollama-tuning.js';

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (flag: string): boolean => args.includes(flag);

const datasetPath = get('--dataset') ?? '.eval-data/longmemeval/longmemeval_s_cleaned.json';
const seed = Number(get('--seed') ?? '42');
const k = Number(get('--k') ?? '10');
const concurrency = Number(get('--concurrency') ?? '4');
const shards = Number(get('--shards') ?? '1');
const ollamaBaseUrl = resolveOllamaBaseUrl(get('--ollama-url'));
const dryRunThroughput = has('--dry-run-throughput');

// Sampled-dataset extrapolation constants (README "Throughput" section) —
// used only to print the 50q/500q projection table in dry-run mode, never to
// gate or skip real work.
const AVG_SESSIONS_PER_QUESTION = 49; // plan doc section 4 measured average
const SAMPLE_50_SESSIONS = Math.round(50 * AVG_SESSIONS_PER_QUESTION);
const FULL_500_SESSIONS = Math.round(500 * AVG_SESSIONS_PER_QUESTION);
const DOCUMENTED_BASELINE_SECS_PER_SESSION = 50; // README measured midpoint (45-60s/session), single daemon, no sharding

if (dryRunThroughput) {
  await runDryRunThroughput();
} else {
  await runSmoke();
}

// ── shared per-shard runner ─────────────────────────────────────────────────

interface ShardResult {
  shard: number;
  question_ids: string[];
  timings: Record<string, number>;
  ingestManifest: IngestManifest;
  distillResult: DistillWaitResult;
  outcomes: AnswerOutcome[] | null;
}

async function runShard(opts: {
  shardIndex: number;
  totalShards: number;
  questions: LongMemEvalQuestion[];
  runDir: string;
  concurrency: number;
  distillTimeoutMs: number;
  k: number;
  azureCfg: AzureConfig | null; // null => ingest+distill only, skip answer (dry-run-throughput mode)
}): Promise<ShardResult> {
  const { shardIndex, totalShards, questions, runDir, concurrency, distillTimeoutMs, k, azureCfg } = opts;
  const label = totalShards > 1 ? `shard-${shardIndex}` : undefined;
  const dataDir = label ? join(runDir, label, 'datadir') : join(runDir, 'datadir');
  const token = randomBytes(32).toString('hex');
  const isolated = makeIsolatedEvalEnv(label ? `lme-${label}` : 'lme-smoke');
  const timings: Record<string, number> = {};
  let daemon: DaemonHandle | undefined;
  const tag = label ? `[${label}] ` : '';
  let reportedDeath = false;

  // The daemon installs global uncaughtException/unhandledRejection handlers
  // that log "FATAL <kind>: <err>" to its OWN stdout and then process.exit(1)
  // — a clean exit, not a native fault, so it produces no OS-level crash
  // report and otherwise looks exactly like the connection just dropping.
  // spawnEvalDaemon buffers that stdout/stderr in-process (see
  // ../shared/spawn-daemon.ts); surface it the moment we notice the daemon is gone
  // instead of only reporting a bare ECONNREFUSED once a poll happens to hit
  // the dead port. Checked on every ingest/distill-wait progress tick so it
  // fires immediately (a fetch to a just-closed port is not always instant).
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
    const ingestManifest = await ingestQuestions(
      { baseUrl: daemon.baseUrl, token },
      questions,
      { concurrency, onProgress: (d, total) => { checkDaemonAlive(); if (d % 50 === 0 || d === total) process.stdout.write(`\r  ${tag}${d}/${total} sessions ingested`); } },
    );
    process.stdout.write('\n');
    timings.ingest_ms = Date.now() - t;
    if (label) writeFileSync(join(runDir, label, 'ingest-manifest.json'), JSON.stringify(ingestManifest, null, 2));
    console.log(`${tag}ingest done in ${timings.ingest_ms}ms: ${ingestManifest.ok_count} ok, ${ingestManifest.failed_count} failed.`);

    t = Date.now();
    const distillResult = await waitForQuestionsDistilled(
      { baseUrl: daemon.baseUrl, token },
      ingestManifest.by_question,
      { timeoutMs: distillTimeoutMs, onProgress: (r, total) => { checkDaemonAlive(); process.stdout.write(`\r  ${tag}${r}/${total} questions distilled`); } },
    );
    process.stdout.write('\n');
    timings.distill_wait_ms = Date.now() - t;
    if (label) writeFileSync(join(runDir, label, 'distill-wait-result.json'), JSON.stringify(distillResult, null, 2));
    console.log(`${tag}distill-wait done in ${timings.distill_wait_ms}ms: ${distillResult.ready_question_ids.length} ready, ${distillResult.timed_out_question_ids.length} timed out.`);

    let outcomes: AnswerOutcome[] | null = null;
    if (azureCfg) {
      t = Date.now();
      outcomes = await answerQuestions(
        { baseUrl: daemon.baseUrl, token },
        azureCfg,
        questions,
        { k, readyQuestionIds: new Set(distillResult.ready_question_ids) },
      );
      timings.answer_ms = Date.now() - t;
      console.log(`${tag}answered ${outcomes.length} questions in ${timings.answer_ms}ms`);
    }

    return { shard: shardIndex, question_ids: questions.map(q => q.question_id), timings, ingestManifest, distillResult, outcomes };
  } catch (err) {
    checkDaemonAlive();
    if (daemon && !reportedDeath) {
      // Threw for a reason other than the daemon dying (e.g. a real network
      // blip) — still surface whatever the daemon printed, it's cheap and
      // might explain a slow/hung state even without a hard exit.
      console.error(`${tag}shard failed while daemon process is still alive; captured stdout/stderr so far:\n--- stdout ---\n${daemon.stdout()}\n--- stderr ---\n${daemon.stderr()}`);
    }
    throw err;
  } finally {
    if (daemon) await killDaemon(daemon, 'SIGTERM', 5_000);
    cleanupIsolatedEvalEnv(isolated);
  }
}

function mergeIngestManifests(results: IngestManifest[]): IngestManifest {
  const by_question: IngestManifest['by_question'] = {};
  const outcomes = results.flatMap(r => r.outcomes);
  for (const r of results) Object.assign(by_question, r.by_question);
  return {
    total_sessions: results.reduce((s, r) => s + r.total_sessions, 0),
    ok_count: results.reduce((s, r) => s + r.ok_count, 0),
    failed_count: results.reduce((s, r) => s + r.failed_count, 0),
    ms: Math.max(0, ...results.map(r => r.ms)),
    by_question,
    outcomes,
  };
}

function mergeDistillResults(results: DistillWaitResult[]): DistillWaitResult {
  const per_question_ms: Record<string, number> = {};
  for (const r of results) Object.assign(per_question_ms, r.per_question_ms);
  return {
    ready_question_ids: results.flatMap(r => r.ready_question_ids),
    timed_out_question_ids: results.flatMap(r => r.timed_out_question_ids),
    per_question_ms,
  };
}

// ── normal smoke run (sharded or single) ───────────────────────────────────

async function runSmoke(): Promise<void> {
  const n = Number(get('--n') ?? '50');
  const distillTimeoutMs = Number(get('--distill-timeout-ms') ?? String(15 * 60_000));
  const runDir = get('--run-dir') ?? join('.eval-data', 'longmemeval', 'runs', new Date().toISOString().replace(/[:.]/g, '-'));

  mkdirSync(runDir, { recursive: true });
  console.log(`Run dir: ${runDir}`);

  const overallStart = Date.now();
  const timings: Record<string, number> = {};

  console.log(`Loading dataset from ${datasetPath}...`);
  let tStart = Date.now();
  const dataset = loadDataset(datasetPath);
  timings.load_dataset_ms = Date.now() - tStart;

  console.log(`Sampling n=${n} (seed=${seed})...`);
  const sample = sampleStratified(dataset, { n, seed });
  writeFileSync(join(runDir, 'sample.json'), JSON.stringify(sample, null, 2));
  {
    const counts: Record<string, number> = {};
    let absCount = 0;
    for (const q of sample) {
      counts[q.question_type] = (counts[q.question_type] ?? 0) + 1;
      if (isAbstention(q)) absCount++;
    }
    console.log(`Sample: ${sample.length} questions -> ${join(runDir, 'sample.json')}`);
    for (const t of QUESTION_TYPES) console.log(`  ${t}: ${counts[t] ?? 0}`);
    console.log(`  (of which _abs abstention: ${absCount})`);
  }

  const ollamaStatus = await queryOllamaStatus(ollamaBaseUrl);
  printOllamaTuningGuidance(ollamaStatus, ollamaBaseUrl);

  if (shards > 1) {
    console.log(`\nSharding into ${shards} isolated daemons (round-robin by question_id).`);
  }
  const shardBuckets = partitionRoundRobin(sample, Math.max(1, shards));
  console.log(`Shard sizes: ${shardBuckets.map(b => b.length).join(', ')} question(s).`);

  let exitCode = 0;
  const azureCfg = resolveAzureConfig();
  console.log(`Answering via Azure deployment "${azureCfg.answererDeployment}" (reasoning_effort=minimal, k=${k})...`);

  tStart = Date.now();
  const settled = await Promise.allSettled(
    shardBuckets.map((questions, i) => runShard({
      shardIndex: i,
      totalShards: shardBuckets.length,
      questions,
      runDir,
      concurrency,
      distillTimeoutMs,
      k,
      azureCfg,
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
      const failedQuestions = shardBuckets[i]!;
      ingestManifests.push({
        total_sessions: 0, ok_count: 0, failed_count: failedQuestions.reduce((s, q) => s + q.haystack_session_ids.length, 0),
        ms: 0, by_question: {}, outcomes: [],
      });
      distillResults.push({ ready_question_ids: [], timed_out_question_ids: failedQuestions.map(q => q.question_id), per_question_ms: {} });
      for (const q of failedQuestions) {
        allOutcomes.push({ question_id: q.question_id, hypothesis: `(skipped: shard-${i} failed — ${reason})`, hit_count: 0, used_as_of: false });
      }
    }
  });

  const manifest = mergeIngestManifests(ingestManifests);
  const distillResult = mergeDistillResults(distillResults);
  writeFileSync(join(runDir, 'ingest-manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(runDir, 'distill-wait-result.json'), JSON.stringify(distillResult, null, 2));

  const orderIndex = new Map(sample.map((q, i) => [q.question_id, i]));
  allOutcomes.sort((a, b) => orderIndex.get(a.question_id)! - orderIndex.get(b.question_id)!);

  const hypPath = join(runDir, 'hypotheses.jsonl');
  writeHypothesesJsonl(allOutcomes, hypPath);
  console.log(`Wrote ${allOutcomes.length} hypotheses -> ${hypPath}`);

  timings.total_ms = Date.now() - overallStart;
  const manifestOut = {
    run_dir: runDir,
    config: { datasetPath, n, seed, k, concurrency, distillTimeoutMs, shards: shardBuckets.length, answererDeployment: azureCfg.answererDeployment },
    counts: {
      sampled: sample.length,
      sessions_total: manifest.total_sessions,
      ingest_ok: manifest.ok_count,
      ingest_failed: manifest.failed_count,
      distill_ready: distillResult.ready_question_ids.length,
      distill_timed_out: distillResult.timed_out_question_ids.length,
    },
    timings,
    per_shard_timings: perShardTimings,
    failed_shards: failedShards,
    timed_out_question_ids: distillResult.timed_out_question_ids,
  };
  writeFileSync(join(runDir, 'run-manifest.json'), JSON.stringify(manifestOut, null, 2));
  console.log(`\nRun manifest -> ${join(runDir, 'run-manifest.json')}`);
  console.log(`Total wall clock: ${timings.total_ms}ms (shards ran for ${timings.shards_wall_clock_ms}ms)`);
  console.log(`\nNext: judge the hypotheses, e.g.\n  bun scripts/eval/longmemeval/judge.mts --hyp ${hypPath} --ref ${datasetPath} --judge gpt-5-mini`);

  if (manifest.failed_count > 0 || distillResult.timed_out_question_ids.length > 0 || failedShards.length > 0) exitCode = 1;
  process.exitCode = exitCode;
}

// ── --dry-run-throughput mode ───────────────────────────────────────────────

async function runDryRunThroughput(): Promise<void> {
  const dryRunQuestions = Number(get('--dry-run-questions') ?? '2');
  const compareBaseline = has('--dry-run-compare-baseline');
  const distillTimeoutMs = Number(get('--distill-timeout-ms') ?? String(2 * 60 * 60_000)); // 2h default — a real distill pass, not the 15min smoke default
  const effectiveShards = Math.max(2, shards); // a 1-vs-N comparison is meaningless below 2
  const runDir = get('--run-dir') ?? join('.eval-data', 'longmemeval', 'runs', `throughput-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(runDir, { recursive: true });
  console.log(`Throughput dry-run dir: ${runDir}`);
  console.log(`Sampling ${dryRunQuestions} real question(s) (seed=${seed}) — ingest+distill ONLY, no answer/judge step.`);

  const dataset = loadDataset(datasetPath);
  const sample = sampleStratified(dataset, { n: dryRunQuestions, seed });
  writeFileSync(join(runDir, 'sample.json'), JSON.stringify(sample, null, 2));
  const totalSessions = sample.reduce((s, q) => s + q.haystack_session_ids.length, 0);
  console.log(`Sample: ${sample.length} question(s), ${totalSessions} haystack sessions total.`);
  for (const q of sample) console.log(`  ${q.question_id} (${q.question_type}): ${q.haystack_session_ids.length} sessions`);

  const statusBefore = await queryOllamaStatus(ollamaBaseUrl);
  printOllamaTuningGuidance(statusBefore, ollamaBaseUrl);

  async function measureShardCount(label: string, shardCount: number): Promise<{ ms: number; sessions: number }> {
    console.log(`\n=== Measuring shards=${shardCount} (${label}) ===`);
    const buckets = partitionRoundRobin(sample, shardCount);
    console.log(`Shard sizes: ${buckets.map(b => b.length).join(', ')} question(s).`);
    const before = await queryOllamaStatus(ollamaBaseUrl);
    const t0 = Date.now();
    const results = await Promise.allSettled(
      buckets.map((questions, i) => runShard({
        shardIndex: i,
        totalShards: shardCount,
        questions,
        runDir: join(runDir, `${label}`),
        concurrency,
        distillTimeoutMs,
        k,
        azureCfg: null, // ingest+distill only
      })),
    );
    const ms = Date.now() - t0;
    const after = await queryOllamaStatus(ollamaBaseUrl);
    const reloaded = detectPossibleReload(before, after);
    if (reloaded.length > 0) {
      console.error(`WARNING: model(s) [${reloaded.join(', ')}] appear to have been unloaded between calls during this measurement — measured elapsed time includes reload latency not present in a steady-state run. Set OLLAMA_KEEP_ALIVE=-1 (see guidance above) and re-measure.`);
    }
    let sessionsDone = 0;
    const failures: string[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') sessionsDone += r.value.ingestManifest.ok_count;
      else failures.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
    if (failures.length > 0) console.error(`shards=${shardCount} had ${failures.length} failed shard(s): ${failures.join(' | ')}`);
    console.log(`shards=${shardCount}: ${sessionsDone}/${totalSessions} sessions distilled in ${ms}ms (${(ms / Math.max(1, sessionsDone) / 1000).toFixed(1)}s/session observed)`);
    return { ms, sessions: sessionsDone };
  }

  const measured = await measureShardCount(`shards-${effectiveShards}`, effectiveShards);
  const baseline = compareBaseline
    ? await measureShardCount('shards-1', 1)
    : null;

  const measuredSecsPerSession = measured.sessions > 0 ? measured.ms / 1000 / measured.sessions : null;
  const baselineSecsPerSession = baseline && baseline.sessions > 0
    ? baseline.ms / 1000 / baseline.sessions
    : DOCUMENTED_BASELINE_SECS_PER_SESSION;
  const baselineSource = baseline ? 'measured this run (--dry-run-compare-baseline)' : 'README documented midpoint (45-60s/session range, not re-measured this run)';

  console.log('\n=== Throughput summary ===');
  console.log(`Baseline (shards=1): ${baselineSecsPerSession.toFixed(1)}s/session — source: ${baselineSource}`);
  if (measuredSecsPerSession !== null) {
    console.log(`Measured (shards=${effectiveShards}): ${measuredSecsPerSession.toFixed(1)}s/session over ${measured.sessions} sessions in ${measured.ms}ms`);
    const speedup = baselineSecsPerSession / measuredSecsPerSession;
    console.log(`Speedup: ${speedup.toFixed(2)}x`);
  } else {
    console.log(`Measured (shards=${effectiveShards}): no sessions completed within the ${distillTimeoutMs}ms distill timeout — raise --distill-timeout-ms and retry.`);
  }

  function rateRow(label: string, secsPerSession: number): void {
    const perHour = 3600 / secsPerSession;
    const hrs50 = SAMPLE_50_SESSIONS / perHour;
    const hrs500 = FULL_500_SESSIONS / perHour;
    console.log(`  ${label.padEnd(28)} ${perHour.toFixed(1).padStart(8)} sessions/hr   50q(~${SAMPLE_50_SESSIONS} sessions): ${hrs50.toFixed(1)}h   500q(~${FULL_500_SESSIONS} sessions): ${hrs500.toFixed(1)}h`);
  }

  console.log('\nExtrapolation table:');
  rateRow(`baseline (shards=1)`, baselineSecsPerSession);
  if (measuredSecsPerSession !== null) rateRow(`measured (shards=${effectiveShards})`, measuredSecsPerSession);

  const out = {
    run_dir: runDir,
    config: { datasetPath, seed, dryRunQuestions, effectiveShards, compareBaseline, distillTimeoutMs },
    sample_question_ids: sample.map(q => q.question_id),
    total_sessions_sampled: totalSessions,
    ollama_status_before: statusBefore,
    measured: { shards: effectiveShards, ms: measured.ms, sessions: measured.sessions, secs_per_session: measuredSecsPerSession },
    baseline: { shards: 1, secs_per_session: baselineSecsPerSession, source: baselineSource, measured_this_run: Boolean(baseline) },
  };
  writeFileSync(join(runDir, 'throughput-dry-run.json'), JSON.stringify(out, null, 2));
  console.log(`\nThroughput dry-run result -> ${join(runDir, 'throughput-dry-run.json')}`);
}
