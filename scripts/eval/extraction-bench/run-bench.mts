/**
 * Extraction-quality + speed benchmark — CLI entry point.
 *
 * Compares typed-atom extraction quality across candidate models for
 * astramemory-local's distill pipeline (stages 01-cleanup -> 08-embed-index;
 * this bench only needs stages 1-7). See README.md for full background.
 *
 * Usage:
 *   bun scripts/eval/extraction-bench/run-bench.mts --models qwen2.5-coder:7b,llama3.1:8b,azure:gpt-5-mini
 *   bun scripts/eval/extraction-bench/run-bench.mts --models phi4-mini --skip-judge   (dry run, no Azure spend)
 *
 * Model spec: a bare Ollama tag (e.g. "qwen2.5-coder:7b") runs through the
 * real daemon HTTP path (lib/daemon-runner.ts). "azure:gpt-5-mini" runs the
 * in-process pipeline path (lib/pipeline-direct.ts) — see
 * lib/azure-reasoning-provider.ts for why gpt-5-mini can't go through the
 * daemon's azure-openai provider today. "nuextract:adapted" also runs the
 * direct pipeline path, but swaps in lib/nuextract-adapter-provider.ts —
 * the standard chat-instruction prompt was verified live (2026-07-08 smoke
 * run) to poison every fixture (0 atoms, template-paradigm mismatch), so
 * this candidate is judged on an adapted prompt instead of the verbatim one
 * every other candidate gets.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadFixtures, type GoldFixture } from './lib/fixtures.js';
import { runOllamaCandidate, type DaemonFixtureResult } from './lib/daemon-runner.js';
import { runDirectPipeline } from './lib/pipeline-direct.js';
import { AzureReasoningLLMProvider } from './lib/azure-reasoning-provider.js';
import { NuExtractAdapterProvider } from './lib/nuextract-adapter-provider.js';
import { judgeFixture, type FixtureScore, type JudgeAtomIn } from './lib/judge.js';
import { resolveAzureConfig } from '../longmemeval/lib/config.js';
import { OllamaLLMProvider } from '../../../src/providers/llm/ollama.js';

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (flag: string): boolean => args.includes(flag);

const modelsArg = get('--models');
if (!modelsArg) {
  console.error('Usage: bun run-bench.mts --models <comma-separated model specs> [--out-dir <dir>] [--per-session-timeout-ms 180000] [--skip-judge]');
  console.error('  Ollama candidate: bare tag, e.g. qwen2.5-coder:7b');
  console.error('  Azure reference:  azure:<deployment>, e.g. azure:gpt-5-mini');
  process.exit(1);
}
const models = modelsArg.split(',').map(s => s.trim()).filter(Boolean);
const perSessionTimeoutMs = Number(get('--per-session-timeout-ms') ?? '180000');
const skipJudge = has('--skip-judge');
const fixturesDir = get('--fixtures-dir'); // override for smoke-testing against a subset
const outDir = get('--out-dir') ?? join(import.meta.dirname, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outDir, { recursive: true });

interface ModelAtomsByFixture {
  model: string;
  perFixture: Record<string, { atoms: JudgeAtomIn[]; wallMs: number; status: string; poisonJobs: number; usageUsd: number }>;
  daemonBootMs: number | null;
}

async function collectAtomsForModel(model: string, fixtures: GoldFixture[]): Promise<ModelAtomsByFixture> {
  if (model.startsWith('azure:')) {
    const deployment = model.slice('azure:'.length);
    console.log(`\n=== ${model} (direct in-process pipeline; compaction=ollama/qwen2.5-coder:7b, extraction=azure/${deployment}) ===`);
    const azureCfg = resolveAzureConfig({ answererDeployment: deployment });
    const llmCompaction = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
    const llmExtraction = new AzureReasoningLLMProvider({ cfg: azureCfg, model: deployment, reasoningEffort: 'minimal' });

    const perFixture: ModelAtomsByFixture['perFixture'] = {};
    for (const fixture of fixtures) {
      process.stdout.write(`  ${fixture.id}... `);
      try {
        const result = await runDirectPipeline(fixture.turns, { llmCompaction, llmExtraction });
        perFixture[fixture.id] = {
          atoms: result.atoms.map(a => ({ type: a.type, text: a.text })),
          wallMs: result.wallMs,
          status: 'ready',
          poisonJobs: 0,
          usageUsd: result.usageUsd,
        };
        console.log(`${result.atoms.length} atoms in ${result.wallMs}ms ($${result.usageUsd.toFixed(4)})`);
      } catch (err) {
        console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
        perFixture[fixture.id] = { atoms: [], wallMs: 0, status: 'error', poisonJobs: 0, usageUsd: 0 };
      }
    }
    return { model, perFixture, daemonBootMs: null };
  }

  if (model === 'nuextract:adapted') {
    console.log(`\n=== ${model} (direct in-process pipeline; compaction=ollama/qwen2.5-coder:7b, extraction=ollama/nuextract via bench-side template adapter) ===`);
    const llmCompaction = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
    const llmExtraction = new NuExtractAdapterProvider({ model: 'nuextract' });

    const perFixture: ModelAtomsByFixture['perFixture'] = {};
    for (const fixture of fixtures) {
      process.stdout.write(`  ${fixture.id}... `);
      try {
        const result = await runDirectPipeline(fixture.turns, { llmCompaction, llmExtraction });
        perFixture[fixture.id] = {
          atoms: result.atoms.map(a => ({ type: a.type, text: a.text })),
          wallMs: result.wallMs,
          status: 'ready',
          poisonJobs: 0,
          usageUsd: result.usageUsd,
        };
        console.log(`${result.atoms.length} atoms in ${result.wallMs}ms`);
      } catch (err) {
        console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
        perFixture[fixture.id] = { atoms: [], wallMs: 0, status: 'error', poisonJobs: 0, usageUsd: 0 };
      }
    }
    return { model, perFixture, daemonBootMs: null };
  }

  console.log(`\n=== ${model} (daemon HTTP path; compaction=ollama/qwen2.5-coder:7b, extraction=ollama/${model}) ===`);
  const run = await runOllamaCandidate(model, fixtures, { perSessionTimeoutMs });
  console.log(`  daemon boot: ${run.daemonBootMs}ms`);
  const perFixture: ModelAtomsByFixture['perFixture'] = {};
  for (const r of run.results as DaemonFixtureResult[]) {
    console.log(`  ${r.fixtureId}: ${r.status} — ${r.atoms.length} atoms in ${r.wallMs}ms${r.poisonJobs > 0 ? ` (${r.poisonJobs} poison jobs)` : ''}`);
    perFixture[r.fixtureId] = {
      atoms: r.atoms.map(a => ({ type: a.type, text: a.text })),
      wallMs: r.wallMs,
      status: r.status,
      poisonJobs: r.poisonJobs,
      usageUsd: 0, // Ollama — always $0
    };
  }
  return { model, perFixture, daemonBootMs: run.daemonBootMs };
}

interface ModelReport {
  model: string;
  daemonBootMs: number | null;
  fixtures: Array<{
    fixtureId: string;
    difficulty: string;
    status: string;
    wallMs: number;
    poisonJobs: number;
    atoms: JudgeAtomIn[];
    score: FixtureScore | null;
  }>;
  aggregate: {
    avgRecall: number | null;
    avgPrecision: number | null;
    f1: number | null;
    avgJunkRate: number | null;
    avgTypeAccuracy: number | null;
    overExtractionOnNothingFixture: number | null;
    failedFixtures: number;
    avgWallMsPerSession: number;
    totalWallMs: number;
    azureUsd: number;
  };
}

function mean(nums: number[]): number | null {
  const finite = nums.filter(n => Number.isFinite(n));
  return finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
}

async function main(): Promise<void> {
  const fixtures = fixturesDir ? loadFixtures(fixturesDir) : loadFixtures();
  console.log(`Loaded ${fixtures.length} gold fixtures.`);
  console.log(`Models under test: ${models.join(', ')}`);

  const azureCfgForJudge = skipJudge ? null : resolveAzureConfig({ answererDeployment: 'gpt-5-mini' });
  const reports: ModelReport[] = [];
  let totalAzureJudgeUsd = 0;

  for (const model of models) {
    const collected = await collectAtomsForModel(model, fixtures);

    const fixtureReports: ModelReport['fixtures'] = [];
    for (const fixture of fixtures) {
      const entry = collected.perFixture[fixture.id];
      if (!entry) continue;

      let score: FixtureScore | null = null;
      if (!skipJudge && azureCfgForJudge) {
        try {
          score = await judgeFixture(azureCfgForJudge, fixture.id, fixture.gold_atoms, entry.atoms);
        } catch (err) {
          // A single flaky/off-schema judge response must never take down the
          // whole multi-model run (this happened once during development —
          // see judge.ts's tryParseJudge comment). Leave this fixture unscored
          // and keep going; results.json still records everything else.
          console.log(`  [judge] ${model} / ${fixture.id}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
        }
        // judgeFixture's fast-path (both empty) makes no LLM call, so only
        // estimate spend when there was actually a call (extractedCount>0 or goldCount>0
        // beyond the zero/zero fast path already handled inside judgeFixture).
        if (!(fixture.gold_atoms.length === 0 && entry.atoms.length === 0)) {
          // Rough judge-call cost estimate (gpt-5-mini $0.25/$2.00 per 1M) —
          // prompt is small (atom lists), so this is a conservative fixed estimate
          // rather than re-deriving exact token counts here.
          totalAzureJudgeUsd += 0.001;
        }
      }

      fixtureReports.push({
        fixtureId: fixture.id,
        difficulty: fixture.difficulty,
        status: entry.status,
        wallMs: entry.wallMs,
        poisonJobs: entry.poisonJobs,
        atoms: entry.atoms,
        score,
      });
    }

    const scored = fixtureReports.filter(f => f.score !== null).map(f => f.score as FixtureScore);
    const recalls = scored.map(s => s.recall).filter((r): r is number => r !== null);
    const precisions = scored.map(s => s.precision).filter((p): p is number => p !== null);
    const junkRates = scored.map(s => s.junkRate).filter((j): j is number => j !== null);
    const typeAccs = scored.map(s => s.typeAccuracy).filter((t): t is number => t !== null);
    const avgRecall = mean(recalls);
    const avgPrecision = mean(precisions);
    const f1 = avgRecall !== null && avgPrecision !== null && (avgRecall + avgPrecision) > 0
      ? (2 * avgRecall * avgPrecision) / (avgRecall + avgPrecision)
      : null;
    const nothingFixtureScore = scored.find(s => s.fixtureId === 'fx09-nothing-worth-remembering');

    const wallTimes = fixtureReports.filter(f => f.status !== 'error').map(f => f.wallMs);
    const failedFixtures = fixtureReports.filter(f => f.status === 'error' || f.status === 'timeout' || f.status === 'partial').length;
    const azureUsd = Object.values(collected.perFixture).reduce((sum, e) => sum + e.usageUsd, 0);

    reports.push({
      model,
      daemonBootMs: collected.daemonBootMs,
      fixtures: fixtureReports,
      aggregate: {
        avgRecall,
        avgPrecision,
        f1,
        avgJunkRate: mean(junkRates),
        avgTypeAccuracy: mean(typeAccs),
        overExtractionOnNothingFixture: nothingFixtureScore?.overExtractionCount ?? null,
        failedFixtures,
        avgWallMsPerSession: mean(wallTimes) ?? 0,
        totalWallMs: wallTimes.reduce((a, b) => a + b, 0),
        azureUsd,
      },
    });

    // Write after EVERY model, not just at the end — a crash or a flaky
    // judge call partway through a later model must never lose an
    // already-completed model's results (this happened once during
    // development: an uncaught judge parse error crashed the whole 4-model
    // run and discarded a fully-scored model that was never persisted).
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(reports, null, 2));
    writeFileSync(join(outDir, 'report.md'), renderMarkdown(reports, totalAzureJudgeUsd));
  }

  const md = renderMarkdown(reports, totalAzureJudgeUsd);
  writeFileSync(join(outDir, 'report.md'), md);

  console.log(`\n${md}`);
  console.log(`\nResults -> ${join(outDir, 'results.json')}`);
  console.log(`Report  -> ${join(outDir, 'report.md')}`);
}

function renderMarkdown(reports: ModelReport[], judgeUsd: number): string {
  const lines: string[] = [];
  lines.push('# Extraction-bench results', '');
  lines.push('| Model | Recall | Precision | F1 | Junk rate | Type acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  const fmtPct = (n: number | null) => n === null ? '—' : `${(n * 100).toFixed(0)}%`;
  for (const r of reports) {
    const a = r.aggregate;
    lines.push(
      `| ${r.model} | ${fmtPct(a.avgRecall)} | ${fmtPct(a.avgPrecision)} | ${fmtPct(a.f1)} | ${fmtPct(a.avgJunkRate)} | ${fmtPct(a.avgTypeAccuracy)} | ${a.overExtractionOnNothingFixture ?? '—'} | ${(a.avgWallMsPerSession / 1000).toFixed(1)}s | ${a.failedFixtures} | $${a.azureUsd.toFixed(4)} |`,
    );
  }
  lines.push('', `_Judge: Azure gpt-5-mini (reasoning_effort=minimal). Estimated judge spend this run: ~$${judgeUsd.toFixed(3)}._`);
  return lines.join('\n');
}

await main();
