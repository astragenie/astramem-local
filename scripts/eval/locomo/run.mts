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
 *   [--extraction-model <model>] [--compaction-model <model>]
 *   [--extraction-provider <provider>] [--compaction-provider <provider>]
 *   [--extract-profile engineering|conversational]
 *   [--cross-encoder] [--diagnose]
 *   [--run-dir .eval-data/locomo/runs/<timestamp>] [--ollama-url <url>]
 *
 * --extraction-model/--compaction-model (additive, FEAT-457 postmortem):
 * omit either (or both) to inherit defaultConfig()'s built-in model exactly
 * as before these flags existed. Passing one pins the isolated eval
 * daemon's model AND records the resolved value in run-manifest.json's
 * config.models — see ../shared/spawn-daemon.ts's resolveEvalModels header.
 *
 * --extraction-provider/--compaction-provider (additive, LoCoMo 10%
 * two-config eval, 2026-07-13): same override-or-default rule, e.g.
 * --extraction-provider codex-subscription --extraction-model gpt-5.4-mini
 * points extraction at a BYO-ChatGPT-quota provider while compaction stays
 * on whatever --compaction-model/--compaction-provider (or the default,
 * ollama/qwen2.5:7b) resolve to.
 *
 * --extract-profile (additive, FEAT-479 D3 §3.2): pins
 * distill.extractProfile for the isolated eval daemon. Omit to inherit the
 * shipped default ('engineering') exactly as before this flag existed —
 * pass 'conversational' for personal-conversation datasets like LoCoMo (the
 * 'engineering' profile starved LoCoMo extraction to ~0.5 atoms/session in
 * the first scored run).
 *
 * --cross-encoder (WS2 rerank-flip experiment,
 * docs/specs/20260713-locomo-architect-design.md workstream 2, additive):
 * flips crossEncoder.enabled (provider: mock) on every shard's isolated
 * daemon via config only — src/search/rerank.ts's own logic is never
 * touched. Run the same sample twice (once without this flag, once with
 * it) and compare judge.mts scores between the two run dirs. Omitted:
 * byte-identical to before this flag existed.
 *
 * ANSWERER_SIGNALS=1 (env, not a flag; FEAT-500 A/B prep, additive): includes
 * each retrieved hit's `top_signal` + a compact per-signal breakdown in the
 * answerer prompt (see answer.mts's formatSignalBreakdown). Unset (the
 * default): the prompt is byte-identical to every prior recorded score. Run
 * the same sample twice (once unset, once with it) and diff judge.mts scores
 * between the two run dirs — see the FEAT-500 backlog file for the exact A/B
 * command.
 *
 * --diagnose (WS2 diagnostic, same doc, additive): runs the not-in-db/
 * rank-miss/rank-ok retrieval diagnosis (see diagnose-retrieval.mts) against
 * each shard's daemon right after the answer step, before it's torn down,
 * and writes <run-dir>/diagnosis.json. Omitted: no extra recall() calls,
 * no diagnosis.json, byte-identical to before this flag existed. Combine
 * with --cross-encoder to see whether the rerank flip shrinks the
 * rank-miss bucket specifically (the diagnosis's own opposite-remedy
 * question) rather than only looking at the aggregate judge score.
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
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { resolveExtractionPassBTuning } from '../../../src/config/config.js';
import { collectRunConstants } from '../shared/run-constants.js';
import { loadDataset, sampleLocomo, ensureDatasetDownloaded } from './lib/dataset.js';
import { LOCOMO_CATEGORIES, CATEGORY_NAMES, sessionNumbers, type LoCoMoSample } from './lib/types.js';
import {
  spawnEvalDaemon, waitForHealthStatus, killDaemon, makeIsolatedEvalEnv, cleanupIsolatedEvalEnv,
  resolveEvalModels, type DaemonHandle, type EvalModelOverrides, type EvalCrossEncoderOverride,
} from '../shared/spawn-daemon.js';
import { ingestConversations, type IngestManifest } from './ingest.mts';
import { waitForSamplesDistilled, type DistillWaitResult } from './distill-wait.mts';
import { answerConversations, writeHypothesesJsonl, type AnswerOutcome } from './answer.mts';
import { diagnoseRetrieval, computeBreakdown, printBreakdown, writeDiagnosisReport, type DiagnosisReport, type DiagnosisRecord, type JudgeSummary } from './diagnose-retrieval.mts';
import { resolveAzureConfig, type AzureConfig } from '../shared/config.js';
import { partitionRoundRobin } from '../shared/shard.js';
import { resolveOllamaBaseUrl, queryOllamaStatus, printOllamaTuningGuidance } from '../shared/ollama-tuning.js';
import { ledgerCompletedMap } from '../shared/resume-ledger.js';
import { hashDatasetFile, evaluateResumeGuard, type RunParams } from '../shared/run-params.js';
import { evaluateDetachDecision, isDetachedChild, buildDetachedChildArgs, spawnDetached } from '../shared/detach.js';
import { patchRunStatus, printRunStatus, shouldFlushProgress, readRunStatus, type RunStatus } from '../shared/run-status.js';
import { writeDaemonManifest, type DaemonManifestEntry } from '../shared/daemon-manifest.js';

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (flag: string): boolean => args.includes(flag);

const datasetPath = get('--dataset') ?? '.eval-data/locomo/locomo10.json';
const seed = Number(get('--seed') ?? '42');
const k = Number(get('--k') ?? '10');
// How many QA pairs are answered at once. Purely a scheduling knob — the prompt,
// deployment, token budget and k are untouched, so the hypotheses (and therefore
// the score) are identical to the old strictly-serial loop. See
// DEFAULT_ANSWER_CONCURRENCY in answer.mts.
const answerConcurrency = Number(get('--answer-concurrency') ?? '8');
// FEAT-500 A/B prep: env, not a flag, so it composes with --resume unchanged
// and default runs (unset) stay byte-identical to every prior recorded
// score. See answer.mts's buildAnswerPrompt/formatSignalBreakdown.
const answererIncludeSignals = process.env.ANSWERER_SIGNALS === '1';
// --answerer <ollama-tag> (additive, 2026-07-18 local-answerer A/B): swap the
// fixed cheap Azure answerer for a local Ollama model on the SAME stored
// memories — pairs with --resume for a re-answer-only pass. Omit -> Azure.
const answererFlag = get('--answerer');
const concurrency = Number(get('--concurrency') ?? '4');
const shards = Number(get('--shards') ?? '1');
const ollamaBaseUrl = resolveOllamaBaseUrl(get('--ollama-url'));
// Additive-only (FEAT-457 postmortem): omitting either flag reproduces
// defaultConfig()'s built-in model exactly, byte-for-byte, same as before
// these flags existed. Passing one pins the isolated eval daemon's model
// AND records what it resolved to in the run/throughput manifest below —
// closing the gap where a prior run silently used a different model than
// the operator believed, discoverable only in postmortem.
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
// FEAT-479 D3 §3.2: additive — omit to inherit the shipped 'engineering'
// default exactly as before this flag existed.
const extractProfileFlag = get('--extract-profile') as 'engineering' | 'conversational' | undefined;
const extractionPassesRaw = get('--extraction-passes');
const extractionPassesFlag = extractionPassesRaw !== undefined ? (Number(extractionPassesRaw) as 1 | 2) : undefined;
if (extractionPassesFlag !== undefined && extractionPassesFlag !== 1 && extractionPassesFlag !== 2) {
  console.error(`--extraction-passes must be 1 or 2, got: ${extractionPassesRaw}`);
  process.exit(1);
}
// --compaction-mode auto|always|never (additive): `never` = raw-turn passthrough,
// no compaction LLM call — the stage can summarize away facts extraction needs, so
// disabling it isolates extraction quality. Omit to inherit the shipped default (auto).
const compactionModeFlag = get('--compaction-mode') as 'auto' | 'always' | 'never' | undefined;
if (compactionModeFlag !== undefined && !['auto', 'always', 'never'].includes(compactionModeFlag)) {
  console.error(`--compaction-mode must be auto|always|never, got: ${compactionModeFlag}`);
  process.exit(1);
}
// --passb-provider/--passb-model (additive, FEAT-534 A/B): route the dual-pass
// specifics-sweeper Pass B to a different provider/model than Pass A via
// distill.extractionPassB. Both flags required together.
// --passb-sweep untuned (2026-07-18): restore the pre-tuning full sweep
// (gate off, no output cap) — required for any faithful replication of a
// pre-2026-07-18 dual-pass number (e.g. the 0.6002 champion). Omit = the
// shipped EXTRACTION_PASS_B_DEFAULTS tuning applies.
const maxChunkCharsFlagRaw = get('--max-chunk-chars');
const maxChunkCharsFlag = maxChunkCharsFlagRaw !== undefined ? Number(maxChunkCharsFlagRaw) : undefined;
if (maxChunkCharsFlag !== undefined && (!Number.isFinite(maxChunkCharsFlag) || maxChunkCharsFlag <= 0)) {
  console.error(`--max-chunk-chars must be a positive number, got: ${maxChunkCharsFlagRaw}`);
  process.exit(1);
}
const passBSweepFlag = get('--passb-sweep') as 'untuned' | undefined;
if (passBSweepFlag !== undefined && passBSweepFlag !== 'untuned') {
  console.error(`--passb-sweep only supports 'untuned', got: ${passBSweepFlag}`);
  process.exit(1);
}
const passBProviderFlag = get('--passb-provider');
const passBModelFlag = get('--passb-model');
if ((passBProviderFlag === undefined) !== (passBModelFlag === undefined)) {
  console.error('--passb-provider and --passb-model must be set together');
  process.exit(1);
}
const extractionPassBFlag = passBProviderFlag !== undefined && passBModelFlag !== undefined
  ? { provider: passBProviderFlag, model: passBModelFlag }
  : undefined;
// WS2 rerank-flip experiment (docs/specs/20260713-locomo-architect-design.md
// workstream 2): `--cross-encoder` flips the isolated eval daemon's
// crossEncoder.enabled via config only (src/search/rerank.ts's own logic is
// never touched) -- run the same sample twice, once without the flag (the
// existing off-by-default baseline) and once with it, then compare
// judge.mts scores between the two run dirs. Omitted: byte-identical to
// before this flag existed.
const crossEncoderOverride: EvalCrossEncoderOverride | undefined =
  has('--cross-encoder') ? { enabled: true, provider: 'mock' } : undefined;
// --multihop (v2 plan C1): flip the WS6 decompose stage ON for the sandbox
// (OFF by default in defaultConfig). Additive — omitted is byte-identical.
const multiHopOverride: { enabled: boolean } | undefined =
  has('--multihop') ? { enabled: true } : undefined;
// WS2 diagnostic (same doc, workstream 2): run the not-in-db/rank-miss/
// rank-ok retrieval diagnosis against each shard's daemon right after the
// answer step, before it's torn down -- reuses the daemon that's about to
// die anyway rather than requiring a caller to keep one alive separately.
// Omitted: no diagnosis.json is written, no extra recall() calls happen,
// byte-identical to before this flag existed.
const diagnoseRequested = has('--diagnose');
const dryRunThroughput = has('--dry-run-throughput');
// FEAT-462 AC-1/AC-6: see ../longmemeval/run-smoke.mts's identical comment.
const resumeDir = get('--resume');
// FEAT-462 slice B AC-2: see ../longmemeval/run-smoke.mts's identical comment.
const detachRequested = has('--detach');
const statusDir = get('--status');

if (statusDir) {
  process.exitCode = printRunStatus(statusDir);
} else if (dryRunThroughput) {
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
  resolvedModels: {
    extraction: string; compaction: string;
    extractionProvider: string; compactionProvider: string;
  };
  /** WS2: null unless `diagnose: true` was passed AND the answer step ran
   *  (azureCfg !== null) — the diagnosis needs the same ready-sample gating
   *  the answer step uses. */
  diagnosisRecords: DiagnosisRecord[] | null;
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
  /** Additive (see the flag-parsing comment near the top of this file) —
   *  undefined reproduces pre-existing behavior exactly. */
  modelOverrides?: EvalModelOverrides;
  /** Additive (FEAT-479 D3 §3.2) — undefined reproduces the shipped
   *  'engineering' default exactly. */
  extractProfile?: 'engineering' | 'conversational';
  /** Additive (W2 dual-pass A/B) — undefined inherits the shipped default (1). */
  extractionPasses?: 1 | 2;
  /** Additive — distill.compaction mode; undefined inherits the shipped default (auto). */
  compactionMode?: 'auto' | 'always' | 'never';
  /** Additive (FEAT-534 A/B) — distill.extractionPassB; undefined = both passes on Pass A's provider. */
  extractionPassB?: { provider: string; model: string };
  /** Additive (2026-07-18) — 'untuned' restores the pre-tuning full sweep
   *  (gate off, no output cap) for faithful replication of pre-tuning runs;
   *  undefined inherits EXTRACTION_PASS_B_DEFAULTS. */
  passBSweep?: 'untuned';
  maxChunkChars?: number;
  /** Additive (WS2 rerank-flip, see the flag-parsing comment near the top of
   *  this file) — undefined reproduces pre-existing behavior exactly. */
  crossEncoderOverride?: EvalCrossEncoderOverride;
  /** Additive (v2 C1) — flips WS6 multiHop decompose on for the sandbox. */
  multiHopOverride?: { enabled: boolean };
  /** Additive (WS2 diagnostic, same comment) — false/omitted runs no extra
   *  recall() calls and writes no diagnosis.json, byte-identical to before
   *  this option existed. */
  diagnose?: boolean;
  /** FEAT-462 AC-1: see ../longmemeval/run-smoke.mts's identical option —
   *  defaults to false so every existing call site is unaffected (AC-7). */
  resume?: boolean;
  /** FEAT-462 slice B AC-3/AC-2: see ../longmemeval/run-smoke.mts's
   *  identical options. */
  onDaemonSpawned?: (entry: DaemonManifestEntry) => void;
  reportIngestProgress?: (shardIndex: number, done: number, total: number) => void;
}): Promise<ShardResult> {
  const {
    shardIndex, totalShards, samples, runDir, concurrency, distillTimeoutMs, k, azureCfg, modelOverrides,
    extractProfile, extractionPasses, compactionMode, extractionPassB, passBSweep, maxChunkChars, crossEncoderOverride, multiHopOverride, diagnose = false,
    resume = false, onDaemonSpawned, reportIngestProgress,
  } = opts;
  const label = totalShards > 1 ? `shard-${shardIndex}` : undefined;
  const shardDir = label ? join(runDir, label) : runDir;
  const dataDir = join(shardDir, 'datadir');
  // Crash-safe ledger (FEAT-462 AC-1/AC-4) — see run-smoke.mts's identical
  // comment for the always-write / conditional-read rationale.
  const ledgerPath = join(shardDir, 'ingest-ledger.jsonl');
  const resumeCompleted = resume ? ledgerCompletedMap(ledgerPath) : undefined;
  const token = randomBytes(32).toString('hex');
  const isolated = makeIsolatedEvalEnv(label ? `locomo-${label}` : 'locomo-run', { models: modelOverrides, crossEncoder: crossEncoderOverride, multiHop: multiHopOverride, extractProfile, extractionPasses, compactionMode, extractionPassB, passBSweep, maxChunkChars });
  // 2026-07-18 traceability: persist the sandbox's EXACT boot config into the
  // run dir — the sandbox datadir is deleted on cleanup, and everything not in
  // this file fell through to defaultConfig() (see run-manifest's gitState for
  // which tree built that dist). Sandbox config contains no secrets by
  // construction (bearer travels via env, never config.yaml).
  writeFileSync(join(shardDir, 'sandbox-config.yaml'), isolated.configYaml, 'utf8');
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
    onDaemonSpawned?.({ shard: shardIndex, label: label ?? 'single', pid: daemon.pid, port: daemon.port, datadir: dataDir });

    t = Date.now();
    const ingestManifest = await ingestConversations(
      { baseUrl: daemon.baseUrl, token },
      samples,
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
    // run-status must track the phases that TAKE THE TIME, not just the ones that
    // are quick to describe. Before this, `phase` was stamped 'ingesting' once and
    // then not written again until 'completed' — so the two longest phases
    // (distill-wait, answering) were invisible. On 2026-07-14 a run sat at
    // `{phase: "ingesting", sessions_done: 1}` for 90 minutes while its ingest was
    // in fact complete (272/272, 2521 atoms) and its wait loop was wedged. The
    // status file was not merely unhelpful, it was actively misleading: it named
    // the wrong phase and a session count off by 271.
    // Only the single-shard path owns run-status.json. In multi-shard mode every
    // shard shares one runDir, so N shards patching one file would race and the
    // last writer would win — a status that flickers between shards is no better
    // than one that lies. The parent aggregates shard progress separately.
    const ownsStatus = label === undefined;
    const startedAt = readRunStatus(runDir)?.started_at ?? new Date().toISOString();
    const statusBase = { orchestrator_pid: process.pid, started_at: startedAt };
    const patchStatus = (patch: Partial<RunStatus>): void => {
      if (ownsStatus) patchRunStatus(runDir, { ...statusBase, ...patch });
    };

    patchStatus({ phase: 'distill_wait', sessions_done: ingestManifest.ok_count });
    let lastFlushMs = Date.now();
    const distillResult = await waitForSamplesDistilled(
      { baseUrl: daemon.baseUrl, token },
      ingestManifest.by_sample,
      {
        timeoutMs: distillTimeoutMs,
        onProgress: (r, total) => {
          checkDaemonAlive();
          process.stdout.write(`\r  ${tag}${r}/${total} conversations distilled`);
          // Throttled so a 5s poll loop doesn't rewrite the file every round.
          const now = Date.now();
          if (shouldFlushProgress(lastFlushMs, now)) {
            lastFlushMs = now;
            patchStatus({ phase: 'distill_wait', conversations_ready: r, conversations_total: total });
          }
        },
      },
    );
    process.stdout.write('\n');
    timings.distill_wait_ms = Date.now() - t;
    if (label) writeFileSync(join(runDir, label, 'distill-wait-result.json'), JSON.stringify(distillResult, null, 2));
    console.log(`${tag}distill-wait done in ${timings.distill_wait_ms}ms: ${distillResult.ready_sample_ids.length} ready, ${distillResult.timed_out_sample_ids.length} timed out.`);

    let outcomes: AnswerOutcome[] | null = null;
    if (azureCfg) {
      t = Date.now();
      patchStatus({
        phase: 'answering',
        conversations_ready: distillResult.ready_sample_ids.length,
        conversations_timed_out: distillResult.timed_out_sample_ids.length,
      });
      outcomes = await answerConversations(
        { baseUrl: daemon.baseUrl, token },
        azureCfg,
        samples,
        { k, readySampleIds: new Set(distillResult.ready_sample_ids), concurrency: answerConcurrency, includeSignals: answererIncludeSignals, ...(answererFlag ? { ollamaAnswerer: { model: answererFlag } } : {}) },
      );
      timings.answer_ms = Date.now() - t;
      console.log(`${tag}answered ${outcomes.length} QA pairs in ${timings.answer_ms}ms`);
    }

    // WS2 diagnostic (docs/specs/20260713-locomo-architect-design.md
    // workstream 2): runs against THIS shard's daemon before it's torn down
    // in the `finally` below -- reuses the daemon that's about to die anyway.
    // Gated on `azureCfg` too (mirrors the answer step) so --dry-run-throughput
    // never triggers it even if --diagnose was also passed.
    let diagnosisRecords: DiagnosisRecord[] | null = null;
    if (diagnose && azureCfg) {
      t = Date.now();
      const report = await diagnoseRetrieval(
        { baseUrl: daemon.baseUrl, token },
        samples,
        // productionK: the SAME k the answer step above just used -- the
        // whole point of the pool-matching fix (see diagnose-retrieval.mts's
        // header) is comparing against exactly what the real answerer saw.
        { productionK: k, readySampleIds: new Set(distillResult.ready_sample_ids) },
      );
      diagnosisRecords = report.records;
      timings.diagnose_ms = Date.now() - t;
      console.log(`${tag}diagnosed ${report.records.length} QA pairs in ${timings.diagnose_ms}ms`);
    }

    return {
      shard: shardIndex, sample_ids: samples.map(s => s.sample_id), timings, ingestManifest, distillResult, outcomes,
      resolvedModels: isolated.resolvedModels, diagnosisRecords,
    };
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

  // FEAT-462 slice B AC-2: see ../longmemeval/run-smoke.mts's identical
  // comment for the full --detach mechanism/rationale.
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
    console.log(`Check progress:  bun scripts/eval/locomo/run.mts --status ${runDir}`);
    console.log(`Detached stdout/stderr -> ${child.stdoutPath} / ${child.stderrPath}`);
    return;
  }
  patchRunStatus(runDir, {
    status: 'running', phase: 'starting', orchestrator_pid: process.pid, detached: isDetachedChild(process.env),
    started_at: startedAt, sessions_done: 0, sessions_total: 0,
  });

  const overallStart = Date.now();
  const timings: Record<string, number> = {};

  const { downloaded } = await ensureDatasetDownloaded(datasetPath);
  console.log(downloaded ? `Downloaded LoCoMo dataset -> ${datasetPath}` : `Using existing dataset at ${datasetPath}`);

  // FEAT-462 review fix (finding 5) -- see ../longmemeval/run-smoke.mts's
  // identical comment for the full incident this guards against. Placed
  // after ensureDatasetDownloaded so the file is guaranteed present to hash.
  const runParamsPath = join(runDir, 'run-params.json');
  const currentParams: RunParams = {
    datasetPath,
    datasetHash: hashDatasetFile(datasetPath),
    seed,
    n: nRaw !== undefined ? Number(nRaw) : null,
    qaPerSample: qaPerSampleRaw !== undefined ? Number(qaPerSampleRaw) : null,
    shards,
  };
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
  const totalSessionsSampled = sample.reduce((s, c) => s + sessionNumbers(c.conversation).length, 0);
  patchRunStatus(runDir, {
    orchestrator_pid: process.pid, started_at: startedAt, phase: 'sampling', sessions_total: totalSessionsSampled,
  });

  const ollamaStatus = await queryOllamaStatus(ollamaBaseUrl);
  printOllamaTuningGuidance(ollamaStatus, ollamaBaseUrl);

  if (shards > 1) console.log(`\nSharding into ${shards} isolated daemons (round-robin by sample_id).`);
  const shardBuckets = partitionRoundRobin(sample, Math.max(1, shards));
  console.log(`Shard sizes: ${shardBuckets.map(b => b.length).join(', ')} conversation(s).`);

  let exitCode = 0;
  const azureCfg = resolveAzureConfig();
  console.log(`Answering via Azure deployment "${azureCfg.answererDeployment}" (reasoning_effort=minimal, k=${k})...`);

  patchRunStatus(runDir, { orchestrator_pid: process.pid, started_at: startedAt, phase: 'ingesting' });

  // FEAT-462 slice B AC-3/AC-2: see ../longmemeval/run-smoke.mts's identical
  // comment for both accumulators.
  const daemonManifestEntries: DaemonManifestEntry[] = [];
  const onDaemonSpawned = (entry: DaemonManifestEntry): void => {
    daemonManifestEntries.push(entry);
    writeDaemonManifest(runDir, [...daemonManifestEntries]);
  };
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
    shardBuckets.map((samples, i) => runShard({
      shardIndex: i, totalShards: shardBuckets.length, samples, runDir, concurrency, distillTimeoutMs, k, azureCfg,
      modelOverrides, extractProfile: extractProfileFlag, extractionPasses: extractionPassesFlag, compactionMode: compactionModeFlag, extractionPassB: extractionPassBFlag, passBSweep: passBSweepFlag, maxChunkChars: maxChunkCharsFlag, crossEncoderOverride, multiHopOverride, diagnose: diagnoseRequested,
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
  // WS2: a failed shard contributes no diagnosis records for its questions
  // (unlike allOutcomes, which gets synthetic "(skipped: shard failed)"
  // placeholders) -- diagnosis has nothing meaningful to say about a
  // question whose conversation never got ingested, so it's simply absent
  // from the report rather than padded with a placeholder classification.
  let allDiagnosisRecords: DiagnosisRecord[] = [];
  const failedShards: number[] = [];

  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      perShardTimings[`shard_${i}`] = r.value.timings;
      ingestManifests.push(r.value.ingestManifest);
      distillResults.push(r.value.distillResult);
      if (r.value.outcomes) allOutcomes.push(...r.value.outcomes);
      if (r.value.diagnosisRecords) allDiagnosisRecords.push(...r.value.diagnosisRecords);
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

  let diagnosisPath: string | null = null;
  if (diagnoseRequested) {
    const breakdown = computeBreakdown(allDiagnosisRecords);
    // run.mts never threads an --llm-judge flag through diagnoseRetrieval
    // (that's diagnose-retrieval.mts's own CLI-only opt-in, see its file
    // header's #267 section) -- this is a plain merge of each shard's
    // per-record judge accounting (issue #267 fix), not a fresh judge run,
    // so it's derived from allDiagnosisRecords rather than any shard's own
    // per-shard judge_summary (which computeBreakdown/writeDiagnosisReport
    // never see across the shard boundary anyway).
    const judge_summary: JudgeSummary = {
      enabled: allDiagnosisRecords.some(r => r.judged),
      total_calls: allDiagnosisRecords.reduce((n, r) => n + r.judge_calls, 0),
      total_failures: allDiagnosisRecords.reduce((n, r) => n + r.judge_failures, 0),
      capped_records: allDiagnosisRecords.filter(r => r.judge_capped).length,
    };
    const diagnosisReport: DiagnosisReport = { records: allDiagnosisRecords, ...breakdown, judge_summary };
    diagnosisPath = join(runDir, 'diagnosis.json');
    writeDiagnosisReport(diagnosisReport, diagnosisPath);
    printBreakdown(diagnosisReport);
    console.log(`Diagnosis -> ${diagnosisPath}`);
  }

  timings.total_ms = Date.now() - overallStart;
  // Prefer an actually-observed shard's resolvedModels (what really booted);
  // fall back to the pure resolution (what WOULD have booted) only if every
  // shard failed before makeIsolatedEvalEnv ran — the manifest should never
  // be silent about the model just because the run also failed.
  const observedModels = settled.find(r => r.status === 'fulfilled')
    ? (settled.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<ShardResult>).value.resolvedModels
    : resolveEvalModels(modelOverrides);
  const manifestOut = {
    run_dir: runDir,
    config: {
      datasetPath, n: sample.length, seed, k, concurrency, distillTimeoutMs, shards: shardBuckets.length,
      answererDeployment: azureCfg.answererDeployment,
      // FEAT-457 postmortem: record what the eval daemon actually ran with,
      // not just what defaultConfig() happens to hardcode today — a
      // published number must be checkable against this field, not memory.
      models: observedModels,
      // FEAT-479 D3 §3.2: same rationale — a published number must be
      // checkable against which extraction prompt profile actually ran.
      extractProfile: extractProfileFlag ?? 'engineering',
      // WS2 (docs/specs/20260713-locomo-architect-design.md workstream 2):
      // whether this run's daemon(s) had the cross-encoder rerank stage
      // flipped on, and whether the retrieval diagnosis ran — a published
      // comparison between a baseline and a rerank-flip run must be
      // checkable against this field, not memory.
      crossEncoder: crossEncoderOverride ?? { enabled: false },
      diagnosed: diagnoseRequested,
      // 2026-07-18 postmortem (the 0.5945-vs-0.5362 forensics failure): the
      // knobs that actually explained a 5.8-pt gap — extraction passes,
      // compaction mode, passB provider, prompt-env variant, pass-B sweep
      // tuning, and the git state of the tree that built the running dist —
      // were NONE of them recorded here, so "what changed between these two
      // runs" was reconstruction, not record. An UNSET value is recorded as
      // the string 'inherited-default' rather than omitted: inheriting
      // defaultConfig through the sandbox is exactly how an uncommitted
      // working-tree default flip poisoned a day of legs undetected.
      extractionPasses: extractionPassesFlag ?? 'inherited-default',
      compactionMode: compactionModeFlag ?? 'inherited-default',
      extractionPassB: extractionPassBFlag ?? 'inherited-default',
      passBSweep: passBSweepFlag ?? 'tuned-default',
      maxChunkChars: maxChunkCharsFlag ?? 'inherited-default',
      extractPromptEnv: process.env.ASTRA_EXTRACT_PROMPT ?? null,
      passBTuning: resolveExtractionPassBTuning(undefined),
      // 2026-07-19 operator directive (0.5346 replication review): every
      // constant that can move an eval number, derived from live source —
      // chunk size, temps, pass-A token ceiling, num_ctx formula, embed
      // dim, config-default models/modes, ollama env. Shared template with
      // extraction-bench's run-metadata.json (run-constants.ts).
      runConstants: collectRunConstants(),
      gitState: (() => {
        try {
          const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
          const dirty = execSync('git status --porcelain -- src/', { encoding: 'utf8' }).trim().length > 0;
          return { sha, srcDirty: dirty };
        } catch { return null; }
      })(),
    },
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
  patchRunStatus(runDir, {
    status: exitCode === 0 ? 'completed' : 'failed', phase: exitCode === 0 ? 'completed' : 'failed',
    orchestrator_pid: process.pid, started_at: startedAt,
    sessions_done: manifest.ok_count, sessions_total: manifest.total_sessions, exit_code: exitCode,
  });
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
      modelOverrides, extractProfile: extractProfileFlag, compactionMode: compactionModeFlag,
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

  const observedModels = results.find(r => r.status === 'fulfilled')
    ? (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<ShardResult>).value.resolvedModels
    : resolveEvalModels(modelOverrides);
  const out = {
    run_dir: runDir,
    config: {
      datasetPath, seed, dryRunConversations, effectiveShards, distillTimeoutMs, models: observedModels,
      extractProfile: extractProfileFlag ?? 'engineering',
    },
    sample_ids: sample.map(c => c.sample_id),
    total_sessions_sampled: totalSessions,
    ollama_status_before: statusBefore,
    measured: { shards: effectiveShards, ms, sessions: sessionsDone, secs_per_session: secsPerSession },
  };
  writeFileSync(join(runDir, 'throughput-dry-run.json'), JSON.stringify(out, null, 2));
  console.log(`\nThroughput dry-run result -> ${join(runDir, 'throughput-dry-run.json')}`);
}
