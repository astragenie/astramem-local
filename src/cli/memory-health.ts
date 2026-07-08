/**
 * `astramem-local memory health [--json] [--deep]`
 *
 * FEAT-444 AC-3: human-readable per-store health report, read-only (opens
 * the production DB directly, same key-aware/config-aware resolution as
 * doctor/budget/queue via openRuntimeDb() — no daemon needs to be running).
 * Exits 0 unconditionally; never mutates memories, memory_events, or
 * consolidation_proposals.
 *
 * `--deep` additionally runs the heavy CLI-only metrics (near-duplicate
 * estimate, junk heuristic, optional LLM-judged sample) from
 * server/queries/memory-health-deep.ts — these are NEVER run without the
 * flag, and NEVER wired into `doctor`'s default pass or `GET /health` (see
 * that module's file header for why). The LLM-judged sample additionally
 * requires `memoryHealth.llmJudgedJunkSample.enabled: true` in config.yaml
 * (AC-5) — `--deep` alone only runs the heuristic (no LLM call).
 */

import { openRuntimeDb } from './open-runtime-db.js';
import { buildMemoryHealthFull, type MemoryHealthReport } from '../server/queries/memory-health.js';
import {
  estimateNearDuplicates,
  estimateJunkHeuristic,
  estimateLlmJudgedJunk,
  type NearDuplicateEstimate,
  type JunkHeuristicEstimate,
  type LlmJudgedJunkResult,
} from '../server/queries/memory-health-deep.js';
import { getProviders } from '../providers/index.js';

export interface MemoryHealthDeepSection {
  nearDuplicate: NearDuplicateEstimate;
  junk: JunkHeuristicEstimate;
  llmJudged: LlmJudgedJunkResult;
}

export interface MemoryHealthCliReport {
  report: MemoryHealthReport;
  deep?: MemoryHealthDeepSection;
}

function pct(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

export async function memoryHealthCommand(args: string[]): Promise<void> {
  const jsonMode = args.includes('--json');
  const deepMode = args.includes('--deep');

  // Key-aware + config.yaml-aware open (same resolution as serve/doctor/queue).
  const { db, cfg } = openRuntimeDb();

  const report = buildMemoryHealthFull(db);

  let deep: MemoryHealthDeepSection | undefined;
  if (deepMode) {
    const nearDuplicate = estimateNearDuplicates(db);
    const junk = estimateJunkHeuristic(db);

    const llmJudgeEnabled = cfg.memoryHealth.llmJudgedJunkSample.enabled;
    const llmJudged = await estimateLlmJudgedJunk(db, {
      enabled: llmJudgeEnabled,
      // Only ever construct a provider when explicitly opted in (AC-5) — no
      // provider is built, let alone called, when the config flag is off.
      provider: llmJudgeEnabled ? getProviders(cfg).llm.extraction : undefined,
    });

    deep = { nearDuplicate, junk, llmJudged };
  }

  db.close();

  const out: MemoryHealthCliReport = deep ? { report, deep } : { report };

  if (jsonMode) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log('');
  console.log('  AstraMemory Memory Health');
  console.log('  ──────────────────────────────');

  if (report.activeCount === 0) {
    console.log('  No data yet — 0 active memories.');
    console.log('');
    return;
  }

  console.log(`  Active:   ${report.activeCount}`);
  console.log(`  Archived: ${report.archivedCount}`);

  if (report.counts) {
    console.log('');
    console.log('  By type:');
    for (const [type, n] of Object.entries(report.counts.byType).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${type.padEnd(14)} ${n}`);
    }
    console.log('  By scope:');
    for (const [scope, n] of Object.entries(report.counts.byScope).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${scope.padEnd(14)} ${n}`);
    }
  }

  if (report.staleness) {
    console.log('');
    console.log('  Staleness (active memories, age over valid_from):');
    for (const b of report.staleness) {
      console.log(`    ${b.label.padEnd(10)} ${b.count}`);
    }
  }

  console.log('');
  console.log(`  Usefulness coverage: ${pct(report.usefulness.coverageRate)} (${report.usefulness.served} served / ${report.activeCount} active)`);
  console.log(`  Correction rate:     ${pct(report.corrections.rate)} (${report.corrections.corrected} corrected)`);
  console.log(`  Poison distill sessions: ${report.poisonDistillSessions}`);

  if (deep) {
    console.log('');
    console.log('  ── Deep metrics (--deep; bounded samples) ──');
    const nd = deep.nearDuplicate;
    console.log(
      `  Near-duplicate estimate: ${pct(nd.rate)} (${nd.nearDuplicatePairs}/${nd.sampledPairs} pairs, ` +
      `${nd.scannedGroups} groups × up to ${nd.bound.maxPerGroup} atoms, threshold ${nd.bound.threshold})`,
    );
    const jh = deep.junk;
    console.log(
      `  Junk heuristic: ${pct(jh.rate)} (${jh.junkCount}/${jh.sampledCount} sampled — ` +
      `${jh.ultraShortCount} ultra-short, ${jh.lowImportanceCount} low-importance, ${jh.neverRecalledCount} never-recalled)`,
    );
    const lj = deep.llmJudged;
    if (lj.enabled) {
      console.log(`  LLM-judged junk sample: ${pct(lj.rate)} (${lj.judgedJunkCount}/${lj.sampledCount} sampled)`);
    } else {
      console.log('  LLM-judged junk sample: disabled (set memoryHealth.llmJudgedJunkSample.enabled: true to opt in)');
    }
  }

  console.log('');
}
