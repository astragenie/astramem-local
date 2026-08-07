/**
 * `astramem-local cost report|drain|otel-ingest` — FEAT-476 Phase 0 CLI
 * surface for the cost ledger (src/storage/cost-events.ts). Separate
 * top-level command from `budget` (src/cli/budget.ts) deliberately: budget
 * tracks THIS repo's own LLM spend (embedding/distill calls, `usd_total`
 * stored directly — a pre-existing, narrower exception) — `cost` tracks
 * externally-captured agent-run usage (proxy tee + OTel), never stores a
 * dollar column, and derives figures at read time. Two different systems
 * answering two different questions; see FEAT-476 spec's risk notes for why
 * this is a deliberate two-table-family design, not an oversight.
 */
import { parseArg } from './arg-parse.js';
import { openRuntimeDb } from './open-runtime-db.js';
import { costReport, type CostReport } from '../storage/cost-events.js';
import { drainCostSpool } from '../ingest/cost-spool-drain.js';
import { parseOtelLogsFile } from '../capture/otel-ingest.js';
import { recordCostEvent } from '../storage/cost-events.js';

function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function printReport(report: CostReport): void {
  console.log('');
  console.log('  AstraMemory Cost Ledger (FEAT-476 Phase 0)');
  console.log('  ────────────────────────────────────────────');
  console.log(`  Total (priced turns only): ${formatUsd(report.totalUsd)}`);
  console.log('');

  console.log('  By slice:');
  const sliceKeys = Object.keys(report.bySlice).sort();
  if (sliceKeys.length === 0) console.log('    (no priced turns)');
  for (const key of sliceKeys) {
    const b = report.bySlice[key]!;
    console.log(`    ${key}: ${formatUsd(b.usd)} (${b.count} turns)`);
  }
  console.log('');

  console.log('  By model:');
  for (const key of Object.keys(report.byModel).sort()) {
    const b = report.byModel[key]!;
    console.log(`    ${key}: ${formatUsd(b.usd)} (${b.count} turns)`);
  }
  console.log('');

  console.log('  By agent role:');
  for (const key of Object.keys(report.byAgentRole).sort()) {
    const b = report.byAgentRole[key]!;
    console.log(`    ${key}: ${formatUsd(b.usd)} (${b.count} turns)`);
  }
  console.log('');

  console.log('  Cache:');
  console.log(`    Read cost:  ${formatUsd(report.cache.readCostUsd)}`);
  console.log(`    Write cost: ${formatUsd(report.cache.writeCostUsd)}`);
  console.log(`    Hit ratio:  ${report.cache.hitRatio === null ? 'n/a (no cache data)' : `${(report.cache.hitRatio * 100).toFixed(1)}%`}`);
  console.log('');

  console.log(`  Truncated replies: ${report.truncatedCount}`);
  console.log(`  Unknown-usage turns (excluded from totals): ${report.unknownUsageCount}`);
  const unpricedKeys = Object.keys(report.unpricedModels);
  const unpricedTotal = unpricedKeys.reduce((sum, k) => sum + report.unpricedModels[k]!, 0);
  console.log(`  Unpriced-model turns (excluded from totals): ${unpricedTotal}`);
  for (const key of unpricedKeys) {
    console.log(`    ${key}: ${report.unpricedModels[key]} turns — no price_versions row, never guessed`);
  }
  if (report.longContextWarningCount > 0) {
    console.log(`  [!] ${report.longContextWarningCount} turn(s) hit the long-context input-token threshold — pricing may be inaccurate (long-context tier not modeled, Phase 0 named gap).`);
  }
  console.log('');
}

export async function costCommand(rest: string[]): Promise<void> {
  const [sub, ...subRest] = rest;

  switch (sub) {
    case 'report': {
      const { db, dataDir } = openRuntimeDb();
      // First drain anything pending in the proxy cost-spool so a report
      // run right after capture (no daemon running to drain it on its own
      // timer — see src/cli/serve.ts) still reflects the latest facts.
      drainCostSpool(db, dataDir);
      const sinceArg = parseArg(subRest, '--since');
      const sinceMs = sinceArg ? Date.now() - parseDurationMs(sinceArg) : undefined;
      const report = costReport(db, { sinceMs });
      if (subRest.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printReport(report);
      }
      db.close();
      break;
    }

    case 'drain': {
      const { db, dataDir } = openRuntimeDb();
      const result = drainCostSpool(db, dataDir);
      console.log(`cost drain: ${result.drained} drained, ${result.failed} failed, ${result.pending} pending`);
      db.close();
      break;
    }

    case 'otel-ingest': {
      const file = parseArg(subRest, '--file');
      if (!file) {
        console.error('cost otel-ingest: --file <path> is required (an OTLP/HTTP-JSON logs export payload)');
        process.exitCode = 1;
        return;
      }
      const events = parseOtelLogsFile(file);
      const { db } = openRuntimeDb();
      let inserted = 0;
      let preferred = 0;
      for (const event of events) {
        const res = recordCostEvent(db, event);
        if (res.inserted) inserted++;
        if (res.preferred) preferred++;
      }
      console.log(`cost otel-ingest: parsed ${events.length} claude_code.api_request record(s) from ${file} — ${inserted} new, ${preferred - inserted} replaced a proxy-sourced row (AC-6), ${events.length - preferred} left an existing row untouched`);
      db.close();
      break;
    }

    default:
      console.error(`cost: unknown subcommand "${sub ?? ''}" (expected: report | drain | otel-ingest)`);
      process.exitCode = 1;
  }
}

/** Minimal duration parser for --since (e.g. "7d", "24h") — same shape
 *  `search --since` already accepts elsewhere in this CLI. */
function parseDurationMs(spec: string): number {
  const match = /^(\d+)([hd])$/.exec(spec.trim());
  if (!match) throw new Error(`cost report: invalid --since value "${spec}" (expected e.g. "24h" or "7d")`);
  const n = Number(match[1]);
  const unitMs = match[2] === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return n * unitMs;
}
