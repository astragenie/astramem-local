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
 *   bun scripts/eval/extraction-bench/run-bench.mts --models qwen2.5-coder:7b,llama3.1:8b --runs 3   (FEAT-450: mean±stdev + significance gate)
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
 *
 * FEAT-450 (multi-run + significance): each config was run ONCE by default,
 * judged by a single non-deterministic judge call, over 15 fixtures — that
 * gave a ±14 F1 run-to-run swing on the same model (see
 * .claude/artifacts/loop/backlog/pending/FEAT-450.md), making prompt/temp/
 * model tuning impossible. `--runs N` (N>1) now re-runs the full
 * extract+judge pass N times per model and reports mean±stdev, and the
 * report labels any cross-model F1 delta smaller than the observed noise
 * floor "within noise / not significant" instead of ranking it. `--runs 1`
 * (the default) is byte-for-byte the old single-run report shape (AC-5).
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFixtures, type GoldFixture } from './lib/fixtures.js';
import { runOllamaCandidate, type DaemonFixtureResult } from './lib/daemon-runner.js';
import { runDirectPipeline } from './lib/pipeline-direct.js';
import { AzureReasoningLLMProvider } from './lib/azure-reasoning-provider.js';
import { NuExtractAdapterProvider } from './lib/nuextract-adapter-provider.js';
import { judgeFixture, judgeSelfAgreement, type FixtureScore, type JudgeAtomIn, type JudgeAgreementReport, type JudgeReasoningEffort } from './lib/judge.js';
import { aggregateFixtureScores, combineRuns, renderMarkdown, type ModelReport, type SingleRunReport } from './lib/report.js';
import { formatStatsPct } from '../shared/stats.js';
import { resolveAzureConfig, type AzureConfig } from '../longmemeval/lib/config.js';
import { OllamaLLMProvider } from '../../../src/providers/llm/ollama.js';
import { OpenAICompatibleLLMProvider } from '../../../src/providers/llm/openai-compatible.js';
import { CodexSubscriptionLLMProvider } from '../../../src/providers/llm/codex-subscription.js';
import type { LLMProvider } from '../../../src/contracts/llm.js';

// --- bench API keys (gitignored) ---------------------------------------------
// Load KEY=value lines from .bench-keys.env at the repo root into process.env
// (without overwriting anything already set) so cloud specs can authenticate.
const BENCH_KEYS_FILE = '.bench-keys.env';
if (existsSync(BENCH_KEYS_FILE)) {
  for (const line of readFileSync(BENCH_KEYS_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m && m[1] && m[2] !== undefined && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// OpenAI-compatible cloud aliases: `openai:<alias>:<model>` (e.g.
// `openai:dashscope:qwen-plus`). Compaction stays local ollama; only
// extraction hits the cloud endpoint, mirroring the azure: branch.
const OPENAI_ALIASES: Record<string, { baseUrl: string; envKey: string }> = {
  dashscope: { baseUrl: process.env.DASHSCOPE_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', envKey: 'DASHSCOPE_API_KEY' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GEMINI_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY' },
};

/** Shared per-fixture direct-pipeline loop for cloud/codex extraction specs. */
async function collectDirect(model: string, llmCompaction: LLMProvider, llmExtraction: LLMProvider, fixtures: GoldFixture[]): Promise<ModelAtomsByFixture> {
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

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (flag: string): boolean => args.includes(flag);

const modelsArg = get('--models');
if (!modelsArg) {
  console.error('Usage: bun run-bench.mts --models <comma-separated model specs> [--out-dir <dir>] [--per-session-timeout-ms 180000] [--skip-judge] [--runs 1]');
  console.error('  Ollama candidate: bare tag, e.g. qwen2.5-coder:7b');
  console.error('  Azure reference:  azure:<deployment>, e.g. azure:gpt-5-mini');
  console.error('  --runs N (default 1): re-run extraction+judging N times per model; N>1 reports mean±stdev and a pairwise significance gate (FEAT-450).');
  process.exit(1);
}
const models = modelsArg.split(',').map(s => s.trim()).filter(Boolean);
const perSessionTimeoutMs = Number(get('--per-session-timeout-ms') ?? '180000');
const skipJudge = has('--skip-judge');
const fixturesDir = get('--fixtures-dir'); // override for smoke-testing against a subset
const outDir = get('--out-dir') ?? join(import.meta.dirname, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outDir, { recursive: true });

// FEAT-450 flags.
const runsCount = Math.max(1, Math.trunc(Number(get('--runs') ?? '1') || 1));
const judgeReasoningEffort = (get('--judge-reasoning-effort') ?? 'low') as JudgeReasoningEffort;
const judgeAgreementFixturesN = Math.max(0, Math.trunc(Number(get('--judge-agreement-fixtures') ?? '2') || 0));
const judgeAgreementRepeats = Math.max(0, Math.trunc(Number(get('--judge-agreement-repeats') ?? '3') || 0));
const skipJudgeAgreement = has('--skip-judge-agreement');

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

  if (model.startsWith('openai:')) {
    // openai:<alias>:<model> — e.g. openai:dashscope:qwen-plus
    const firstColon = model.indexOf(':');
    const secondColon = model.indexOf(':', firstColon + 1);
    const alias = model.slice(firstColon + 1, secondColon);
    const extractModel = model.slice(secondColon + 1);
    const a = OPENAI_ALIASES[alias];
    if (!a) throw new Error(`unknown openai alias '${alias}' — known: ${Object.keys(OPENAI_ALIASES).join(', ')}`);
    const apiKey = process.env[a.envKey];
    if (!apiKey) throw new Error(`${a.envKey} not set (add it to .bench-keys.env) — required for ${model}`);
    console.log(`\n=== ${model} (direct in-process pipeline; compaction=ollama/qwen2.5-coder:7b, extraction=openai-compat ${alias}/${extractModel}) ===`);
    const llmCompaction = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
    const llmExtraction = new OpenAICompatibleLLMProvider({ baseUrl: a.baseUrl, model: extractModel, apiKey });
    return collectDirect(model, llmCompaction, llmExtraction, fixtures);
  }

  if (model.startsWith('codex:')) {
    // codex:<model> — uses the machine's existing ~/.codex login (no key).
    const codexModel = model.slice('codex:'.length);
    console.log(`\n=== ${model} (direct in-process pipeline; compaction=ollama/qwen2.5-coder:7b, extraction=codex-subscription/${codexModel}) ===`);
    const llmCompaction = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
    const llmExtraction = new CodexSubscriptionLLMProvider({ model: codexModel });
    return collectDirect(model, llmCompaction, llmExtraction, fixtures);
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

/**
 * Run one model through extraction + judging exactly once, returning the
 * pre-FEAT-450 single-run report shape. `--runs N` calls this N times per
 * model and combines the results via lib/report.ts's combineRuns.
 */
async function runModelOnce(
  model: string,
  fixtures: GoldFixture[],
  azureCfgForJudge: AzureConfig | null,
  reasoningEffort: JudgeReasoningEffort,
): Promise<{ report: SingleRunReport; judgeUsd: number }> {
  const collected = await collectAtomsForModel(model, fixtures);
  let judgeUsd = 0;

  const fixtureReports: SingleRunReport['fixtures'] = [];
  for (const fixture of fixtures) {
    const entry = collected.perFixture[fixture.id];
    if (!entry) continue;

    let score: FixtureScore | null = null;
    if (azureCfgForJudge) {
      try {
        score = await judgeFixture(azureCfgForJudge, fixture.id, fixture.gold_atoms, entry.atoms, reasoningEffort);
      } catch (err) {
        // A single flaky/off-schema judge response must never take down the
        // whole multi-model run (this happened once during development —
        // see judge.ts's tryParseJudge comment). Leave this fixture unscored
        // and keep going; results.json still records everything else.
        console.log(`  [judge] ${model} / ${fixture.id}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
      // judgeFixture's fast-path (both empty) makes no LLM call, so only
      // estimate spend when there was actually a call (extractedCount>0 or
      // goldCount>0 beyond the zero/zero fast path already handled inside
      // judgeFixture).
      if (!(fixture.gold_atoms.length === 0 && entry.atoms.length === 0)) {
        // Rough judge-call cost estimate (gpt-5-mini $0.25/$2.00 per 1M) —
        // prompt is small (atom lists), so this is a conservative fixed
        // estimate rather than re-deriving exact token counts here.
        judgeUsd += 0.001;
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

  const azureUsd = Object.values(collected.perFixture).reduce((sum, e) => sum + e.usageUsd, 0);
  const aggregate = aggregateFixtureScores(fixtureReports, azureUsd);

  return {
    report: { model, daemonBootMs: collected.daemonBootMs, fixtures: fixtureReports, aggregate },
    judgeUsd,
  };
}

async function main(): Promise<void> {
  const fixtures = fixturesDir ? loadFixtures(fixturesDir) : loadFixtures();
  console.log(`Loaded ${fixtures.length} gold fixtures.`);
  console.log(`Models under test: ${models.join(', ')}`);
  if (runsCount > 1) console.log(`Runs per model: ${runsCount} (multi-run variance mode — FEAT-450)`);

  const azureCfgForJudge = skipJudge ? null : resolveAzureConfig({ answererDeployment: 'gpt-5-mini' });
  const reports: ModelReport[] = [];
  let totalAzureJudgeUsd = 0;
  let firstModelFirstRunFixtures: SingleRunReport['fixtures'] | null = null;

  for (const model of models) {
    const runReports: SingleRunReport[] = [];
    for (let runIdx = 0; runIdx < runsCount; runIdx++) {
      if (runsCount > 1) console.log(`\n### ${model} — run ${runIdx + 1}/${runsCount} ###`);
      const { report: runReport, judgeUsd } = await runModelOnce(model, fixtures, azureCfgForJudge, judgeReasoningEffort);
      totalAzureJudgeUsd += judgeUsd;
      runReports.push(runReport);
      if (firstModelFirstRunFixtures === null) firstModelFirstRunFixtures = runReport.fixtures;
    }

    const combined = combineRuns(runReports);
    reports.push(combined);

    // Write after EVERY model, not just at the end — a crash or a flaky
    // judge call partway through a later model must never lose an
    // already-completed model's results (this happened once during
    // development: an uncaught judge parse error crashed the whole 4-model
    // run and discarded a fully-scored model that was never persisted).
    // Shape: always the plain array of ModelReport (AC-5) — judge
    // self-agreement (computed once, after every model has run) is written
    // to a separate judge-agreement.json below so this file's top-level
    // shape never changes.
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(reports, null, 2));
    writeFileSync(join(outDir, 'report.md'), renderMarkdown(reports, totalAzureJudgeUsd, { judgeReasoningEffort }));
  }

  // AC-4: judge self-agreement. Re-judges the SAME (model, fixture)
  // extracted-atom set `judgeAgreementRepeats` times so the variance
  // observed is judge noise specifically, not model/extraction noise.
  // Uses the first model's first-run atoms for the first
  // `judgeAgreementFixturesN` fixtures (deterministic, cheap, bounded —
  // independent of --runs and of how many models are under test).
  let agreement: JudgeAgreementReport[] = [];
  if (azureCfgForJudge && !skipJudgeAgreement && firstModelFirstRunFixtures && judgeAgreementRepeats >= 2 && judgeAgreementFixturesN > 0) {
    const subset = firstModelFirstRunFixtures.slice(0, judgeAgreementFixturesN);
    console.log(`\nMeasuring judge self-agreement on ${subset.length} fixture(s), ${judgeAgreementRepeats} repeats each (same atoms, re-judged)...`);
    for (const f of subset) {
      const goldAtoms = fixtures.find(fx => fx.id === f.fixtureId)?.gold_atoms ?? [];
      try {
        const rep = await judgeSelfAgreement(azureCfgForJudge, f.fixtureId, goldAtoms, f.atoms, judgeAgreementRepeats, judgeReasoningEffort);
        agreement.push(rep);
        totalAzureJudgeUsd += 0.001 * judgeAgreementRepeats;
        console.log(`  ${f.fixtureId}: F1 ${formatStatsPct(rep.f1)} across ${rep.repeats} repeats`);
      } catch (err) {
        console.log(`  ${f.fixtureId}: judge self-agreement FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (agreement.length > 0) {
      writeFileSync(join(outDir, 'judge-agreement.json'), JSON.stringify(agreement, null, 2));
    }
  }

  const md = renderMarkdown(reports, totalAzureJudgeUsd, { judgeReasoningEffort, agreement });
  writeFileSync(join(outDir, 'report.md'), md);

  console.log(`\n${md}`);
  console.log(`\nResults -> ${join(outDir, 'results.json')}`);
  console.log(`Report  -> ${join(outDir, 'report.md')}`);
  if (agreement.length > 0) console.log(`Judge self-agreement -> ${join(outDir, 'judge-agreement.json')}`);
}

await main();
