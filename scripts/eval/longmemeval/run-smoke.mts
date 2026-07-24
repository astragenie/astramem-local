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
 *   [--extraction-model <model>] [--extraction-provider <provider>]
 *   [--compaction-model <model>] [--compaction-provider <provider>]
 *   [--extract-profile engineering|conversational]
 *
 * The --extraction / --compaction model+provider flags and --extract-profile
 * (additive, 2026-07-24) mirror locomo/run.mts — omit to inherit the default
 * exactly as before these flags existed; pass e.g. `--extraction-provider
 * codex-subscription --extraction-model gpt-5.4-mini --extract-profile
 * conversational` for the champion-grade codex extraction path (LongMemEval
 * haystacks are ~50 sessions/question, so this materially raises both speed
 * and extraction quality vs the ollama default).
 *
 * Resume a killed run (FEAT-462): re-attach to an existing --run-dir,
 * respawn shard daemons on their existing datadirs, and skip re-ingesting
 * every session each shard's ledger already shows completed ok. Pass the
 * SAME --dataset/--seed/--n/--shards flags as the original invocation
 * (the sample and shard partitioning are deterministic given those, so
 * they don't need to be persisted separately):
 * bun scripts/eval/longmemeval/run-smoke.mts --resume <run-dir>
 *   [...same flags as the original invocation]
 *
 * Throughput dry run (ingest+distill only, no answer/judge step):
 * bun scripts/eval/longmemeval/run-smoke.mts --dry-run-throughput
 *   [--shards 2] [--dry-run-questions 2] [--seed 42]
 *   [--dry-run-compare-baseline] [--distill-timeout-ms <ms>]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDataset, sampleStratified } from './lib/dataset.js';
import { QUESTION_TYPES, isAbstention, type LongMemEvalQuestion } from './lib/types.js';
import {
  spawnEvalDaemon, waitForHealthStatus, killDaemon, makeIsolatedEvalEnv, cleanupIsolatedEvalEnv,
  type DaemonHandle, type EvalModelOverrides,
} from '../shared/spawn-daemon.js';
import { ingestQuestions, type IngestManifest } from './ingest.mts';
import { waitForQuestionsDistilled, type DistillWaitResult } from './distill-wait.mts';
import { answerQuestions, writeHypothesesJsonl, type AnswerOutcome } from './answer.mts';
import { resolveAzureConfig, type AzureConfig } from '../shared/config.js';
import { partitionRoundRobin } from '../shared/shard.js';
import { resolveOllamaBaseUrl, queryOllamaStatus, printOllamaTuningGuidance, detectPossibleReload } from '../shared/ollama-tuning.js';
import { ledgerCompletedMap } from '../shared/resume-ledger.js';
import { hashDatasetFile, evaluateResumeGuard, type RunParams } from '../shared/run-params.js';
import { evaluateDetachDecision, isDetachedChild, buildDetachedChildArgs, spawnDetached } from '../shared/detach.js';
import { patchRunStatus, printRunStatus, shouldFlushProgress } from '../shared/run-status.js';
import { writeDaemonManifest, type DaemonManifestEntry } from '../shared/daemon-manifest.js';

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

// Extraction/compaction model + provider overrides, mirroring locomo/run.mts
// (additive, 2026-07-24): omit any flag to inherit defaultConfig()'s built-in
// value exactly as before these flags existed. Passing --extraction-provider
// codex-subscription --extraction-model gpt-5.4-mini points the isolated eval
// daemon's extraction at the champion codex path instead of the ollama default
// (LongMemEval haystacks are ~50 sessions/question, so ollama-only extraction
// is both slow and lower-quality — this unlocks a champion-grade number).
const extractionModelFlag = get('--extraction-model');
const compactionModelFlag = get('--compaction-model');
const extractionProviderFlag = get('--extraction-provider') as EvalModelOverrides['extractionProvider'] | undefined;
const compactionProviderFlag = get('--compaction-provider') as EvalModelOverrides['compactionProvider'] | undefined;
const modelOverrides: EvalModelOverrides | undefined =
  (extractionModelFlag !== undefined || compactionModelFlag !== undefined
    || extractionProviderFlag !== undefined || compactionProviderFlag !== undefined)
    ? {
        extraction: extractionModelFlag, compaction: compactionModelFlag,
        extractionProvider: extractionProviderFlag, compactionProvider: compactionProviderFlag,
      }
    : undefined;
// Additive — omit to inherit the shipped 'engineering' default. Pass
// 'conversational' for LongMemEval's chat-style haystacks (the 'engineering'
// profile starves personal-conversation extraction; see locomo/run.mts).
const extractProfileFlag = get('--extract-profile') as 'engineering' | 'conversational' | undefined;
// FEAT-462 AC-1: re-attach to an existing --run-dir instead of starting a
// fresh one. The sample is deterministically re-derived from the same
// --dataset/--seed/--n flags (sampleStratified is a pure function), so the
// question set and per-shard buckets line up exactly with the original
// invocation without needing to persist and re-read them. Each shard's
// ingest ledger (scripts/eval/shared/resume-ledger.ts) is what actually
// skips already-completed sessions — see runShard below.
const resumeDir = get('--resume');
// FEAT-462 slice B AC-2: launch this run detached (survives the invoking
// terminal/session ending) -- see ../shared/detach.ts's header comment.
const detachRequested = has('--detach');
// FEAT-462 slice B AC-2: print run-status.json for an existing run dir and
// exit -- bypasses everything else (sampling, Azure, daemons).
const statusDir = get('--status');

// Sampled-dataset extrapolation constants (README "Throughput" section) —
// used only to print the 50q/500q projection table in dry-run mode, never to
// gate or skip real work.
const AVG_SESSIONS_PER_QUESTION = 49; // plan doc section 4 measured average
const SAMPLE_50_SESSIONS = Math.round(50 * AVG_SESSIONS_PER_QUESTION);
const FULL_500_SESSIONS = Math.round(500 * AVG_SESSIONS_PER_QUESTION);
const DOCUMENTED_BASELINE_SECS_PER_SESSION = 50; // README measured midpoint (45-60s/session), single daemon, no sharding

if (statusDir) {
  process.exitCode = printRunStatus(statusDir);
} else if (dryRunThroughput) {
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
  /** FEAT-462 AC-1: when true, skip re-POSTing sessions this shard's
   *  ledger already shows completed ok. Defaults to false so every
   *  existing call site (including --dry-run-throughput) is unaffected —
   *  AC-7. */
  resume?: boolean;
  /** FEAT-462 slice B AC-3: called once this shard's daemon has printed its
   *  bound port, so the caller can accumulate + write daemon-manifest.json.
   *  Optional -- every existing call site is unaffected (AC-7). */
  onDaemonSpawned?: (entry: DaemonManifestEntry) => void;
  /** FEAT-462 slice B AC-2: called on every ingest progress tick so the
   *  caller can aggregate cross-shard sessions-done/total into
   *  run-status.json. Optional -- every existing call site is unaffected
   *  (AC-7). */
  reportIngestProgress?: (shardIndex: number, done: number, total: number) => void;
  /** Extraction/compaction model+provider overrides for this shard's isolated
   *  daemon (2026-07-24, additive). Optional — omitted => inherit defaults,
   *  every existing call site unaffected. */
  modelOverrides?: EvalModelOverrides;
  /** distill.extractProfile override (2026-07-24, additive). Optional. */
  extractProfile?: 'engineering' | 'conversational';
}): Promise<ShardResult> {
  const {
    shardIndex, totalShards, questions, runDir, concurrency, distillTimeoutMs, k, azureCfg, resume = false,
    onDaemonSpawned, reportIngestProgress, modelOverrides, extractProfile,
  } = opts;
  const label = totalShards > 1 ? `shard-${shardIndex}` : undefined;
  const shardDir = label ? join(runDir, label) : runDir;
  const dataDir = join(shardDir, 'datadir');
  // Crash-safe ledger (FEAT-462 AC-1/AC-4) — always written (cheap, additive,
  // AC-7-safe) so ANY run dir can later be resumed even if --resume wasn't
  // anticipated at launch time. Only READ (to skip already-done sessions)
  // when --resume is explicitly passed.
  const ledgerPath = join(shardDir, 'ingest-ledger.jsonl');
  const resumeCompleted = resume ? ledgerCompletedMap(ledgerPath) : undefined;
  const token = randomBytes(32).toString('hex');
  const isolated = makeIsolatedEvalEnv(label ? `lme-${label}` : 'lme-smoke', { models: modelOverrides, extractProfile });
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
    onDaemonSpawned?.({ shard: shardIndex, label: label ?? 'single', pid: daemon.pid, port: daemon.port, datadir: dataDir });

    t = Date.now();
    const ingestManifest = await ingestQuestions(
      { baseUrl: daemon.baseUrl, token },
      questions,
      {
        concurrency,
        ledgerPath,
        resumeCompleted,
        onProgress: (d, total) => {
          checkDaemonAlive();
          reportIngestProgress?.(shardIndex, d, total);
          if (d % 50 === 0 || d === total) process.stdout.write(`\r  ${tag}${d}/${total} sessions ingested`);
        },
      },
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
  const runDir = resumeDir ?? get('--run-dir') ?? join('.eval-data', 'longmemeval', 'runs', new Date().toISOString().replace(/[:.]/g, '-'));

  if (resumeDir && !existsSync(resumeDir)) {
    console.error(`--resume ${resumeDir}: run dir does not exist — nothing to resume.`);
    process.exitCode = 1;
    return;
  }
  mkdirSync(runDir, { recursive: true });
  console.log(resumeDir ? `Resuming run dir: ${runDir} (ledger-driven skip of already-ingested sessions)` : `Run dir: ${runDir}`);

  // FEAT-462 slice B AC-2: --detach re-execs this exact invocation (pinned
  // to this runDir) as a detached child, writes the initial run-status.json,
  // and returns -- the detached child re-evaluates this same decision point
  // and takes the 'run-inline' branch instead (env marker set by the spawn).
  const detachDecision = evaluateDetachDecision({ detachRequested, alreadyDetached: isDetachedChild(process.env) });
  const startedAt = new Date().toISOString();
  if (detachDecision.action === 'spawn-detached') {
    const child = spawnDetached({
      scriptPath: fileURLToPath(import.meta.url),
      args: buildDetachedChildArgs(args, runDir),
      cwd: process.cwd(),
      runDir,
    });
    patchRunStatus(runDir, {
      status: 'running', phase: 'starting', orchestrator_pid: child.pid ?? -1, detached: true,
      started_at: startedAt, sessions_done: 0, sessions_total: 0,
    });
    console.log(`Detached: orchestrator pid ${child.pid}, run dir ${runDir}`);
    console.log(`Check progress:  bun scripts/eval/longmemeval/run-smoke.mts --status ${runDir}`);
    console.log(`Detached stdout/stderr -> ${child.stdoutPath} / ${child.stderrPath}`);
    return;
  }
  patchRunStatus(runDir, {
    status: 'running', phase: 'starting', orchestrator_pid: process.pid, detached: isDetachedChild(process.env),
    started_at: startedAt, sessions_done: 0, sessions_total: 0,
  });

  // FEAT-462 review fix (finding 5): refuse a --resume whose sampling scope
  // doesn't match the original invocation -- see ../shared/run-params.ts's
  // header comment for the full incident this guards against (a smaller
  // --n silently completing a scope-narrowed, falsely "fully successful"
  // run because every session in the smaller sample is already ok in the
  // ledger from the larger original run).
  const runParamsPath = join(runDir, 'run-params.json');
  const currentParams: RunParams = { datasetPath, datasetHash: hashDatasetFile(datasetPath), seed, n, shards };
  const guard = evaluateResumeGuard(runParamsPath, Boolean(resumeDir), currentParams);
  if (guard.action === 'refuse') {
    console.error(`--resume ${resumeDir}: ${guard.refuseMessage}`);
    patchRunStatus(runDir, {
      status: 'failed', phase: 'failed', orchestrator_pid: process.pid, started_at: startedAt,
      error: guard.refuseMessage, exit_code: 1,
    });
    process.exitCode = 1;
    return;
  }

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
  const totalSessionsSampled = sample.reduce((s, q) => s + q.haystack_session_ids.length, 0);
  patchRunStatus(runDir, {
    orchestrator_pid: process.pid, started_at: startedAt, phase: 'sampling', sessions_total: totalSessionsSampled,
  });

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

  patchRunStatus(runDir, { orchestrator_pid: process.pid, started_at: startedAt, phase: 'ingesting' });

  // FEAT-462 slice B AC-3: accumulate every shard's daemon {pid, port,
  // datadir} into daemon-manifest.json as each one spawns -- synchronous
  // push+write, safe under concurrent shard promises (single-threaded JS,
  // no await between the two).
  const daemonManifestEntries: DaemonManifestEntry[] = [];
  const onDaemonSpawned = (entry: DaemonManifestEntry): void => {
    daemonManifestEntries.push(entry);
    writeDaemonManifest(runDir, [...daemonManifestEntries]);
  };
  // FEAT-462 slice B AC-2: throttled cross-shard ingest-progress aggregation
  // into run-status.json's sessions_done/sessions_total.
  const shardIngestProgress = new Map<number, { done: number; total: number }>();
  let lastProgressFlushMs = 0;
  const reportIngestProgress = (shardIndex: number, done: number, total: number): void => {
    shardIngestProgress.set(shardIndex, { done, total });
    const now = Date.now();
    if (!shouldFlushProgress(lastProgressFlushMs, now)) return;
    lastProgressFlushMs = now;
    let sessionsDone = 0;
    for (const v of shardIngestProgress.values()) sessionsDone += v.done;
    patchRunStatus(runDir, {
      orchestrator_pid: process.pid, started_at: startedAt, phase: 'ingesting',
      sessions_done: sessionsDone, sessions_total: totalSessionsSampled,
    });
  };

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
      modelOverrides,
      extractProfile: extractProfileFlag,
      resume: Boolean(resumeDir),
      onDaemonSpawned,
      reportIngestProgress,
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
  patchRunStatus(runDir, {
    status: exitCode === 0 ? 'completed' : 'failed', phase: exitCode === 0 ? 'completed' : 'failed',
    orchestrator_pid: process.pid, started_at: startedAt,
    sessions_done: manifest.ok_count, sessions_total: manifest.total_sessions, exit_code: exitCode,
  });
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
