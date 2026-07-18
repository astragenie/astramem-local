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
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadFixtures, type GoldFixture } from './lib/fixtures.js';
import { runOllamaCandidate, DEFAULT_COMPACTION_MODEL, type DaemonFixtureResult } from './lib/daemon-runner.js';
import { runDirectPipeline } from './lib/pipeline-direct.js';
import { AzureReasoningLLMProvider } from './lib/azure-reasoning-provider.js';
import { NuExtractAdapterProvider } from './lib/nuextract-adapter-provider.js';
import { judgeFixture, judgeSelfAgreement, type FixtureScore, type JudgeAtomIn, type JudgeAgreementReport, type JudgeReasoningEffort } from './lib/judge.js';
import { findForbiddenItemHits, applyForbiddenItemScoring, computeEvidenceAccuracy, fixtureTranscriptText } from './lib/mechanical-checks.js';
import { aggregateFixtureScores, combineRuns, renderMarkdown, type ModelReport, type SingleRunReport } from './lib/report.js';
import { loadGatesConfig, evaluateGates, staleCalibrationWarning, type GatesConfig } from './lib/gates.js';
import { formatStatsPct } from '../shared/stats.js';
import { resolveAzureConfig, type AzureConfig } from '../shared/config.js';
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

/**
 * FEAT-534: split a `+passB=<spec>` suffix off a model spec, e.g.
 * `codex:gpt-5.4-mini+passB=ollama:qwen3:8b` -> base `codex:gpt-5.4-mini`,
 * passBSpec `ollama:qwen3:8b`. No suffix -> passBSpec `null` (single-pass,
 * byte-identical to pre-FEAT-534 parsing — every existing spec has no `+`).
 */
function splitPassBSuffix(spec: string): { base: string; passBSpec: string | null } {
  const idx = spec.indexOf('+passB=');
  if (idx === -1) return { base: spec, passBSpec: null };
  return { base: spec.slice(0, idx), passBSpec: spec.slice(idx + '+passB='.length) };
}

/**
 * FEAT-534: resolve a bare provider:model spec (the same syntax
 * collectAtomsForModel's own branches accept, minus the daemon-HTTP-path
 * bare-ollama-tag special case) into a constructed LLMProvider, for use as
 * a `+passB=` override. Supports `ollama:<tag>` (or a bare tag, defaulting
 * to ollama — mirrors the FEAT's own `+passB=ollama:qwen3:8b` example),
 * `codex:<model>`, `azure:<deployment>`, `openai:<alias>:<model>`.
 */
function buildProviderFromSpec(spec: string): { label: string; provider: LLMProvider } {
  if (spec.startsWith('azure:')) {
    const deployment = spec.slice('azure:'.length);
    const azureCfg = resolveAzureConfig({ answererDeployment: deployment });
    return { label: spec, provider: new AzureReasoningLLMProvider({ cfg: azureCfg, model: deployment, reasoningEffort: 'minimal' }) };
  }
  if (spec.startsWith('openai:')) {
    const firstColon = spec.indexOf(':');
    const secondColon = spec.indexOf(':', firstColon + 1);
    const alias = spec.slice(firstColon + 1, secondColon);
    const extractModel = spec.slice(secondColon + 1);
    const a = OPENAI_ALIASES[alias];
    if (!a) throw new Error(`unknown openai alias '${alias}' in +passB= spec — known: ${Object.keys(OPENAI_ALIASES).join(', ')}`);
    const apiKey = process.env[a.envKey];
    if (!apiKey) throw new Error(`${a.envKey} not set (add it to .bench-keys.env) — required for +passB=${spec}`);
    return { label: spec, provider: new OpenAICompatibleLLMProvider({ baseUrl: a.baseUrl, model: extractModel, apiKey }) };
  }
  if (spec.startsWith('codex:')) {
    const codexModel = spec.slice('codex:'.length);
    return { label: spec, provider: new CodexSubscriptionLLMProvider({ model: codexModel }) };
  }
  // ollama: explicit `ollama:<tag>` prefix, or a bare tag defaulting to ollama.
  const ollamaTag = spec.startsWith('ollama:') ? spec.slice('ollama:'.length) : spec;
  return { label: `ollama:${ollamaTag}`, provider: new OllamaLLMProvider({ model: ollamaTag }) };
}

/** Shared per-fixture direct-pipeline loop for cloud/codex extraction specs.
 *  `passB` set (FEAT-534) runs dual-pass extraction, pass A on
 *  `llmExtraction`, pass B on `passB.provider` — see pipeline-direct.ts's
 *  own extractionPasses/llmExtractionPassB doc comment for the merge rules. */
async function collectDirect(
  model: string,
  llmCompaction: LLMProvider,
  llmExtraction: LLMProvider,
  fixtures: GoldFixture[],
  passB?: { label: string; provider: LLMProvider },
): Promise<ModelAtomsByFixture> {
  const perFixture: ModelAtomsByFixture['perFixture'] = {};
  for (const fixture of fixtures) {
    process.stdout.write(`  ${fixture.id}... `);
    try {
      const result = await runDirectPipeline(fixture.turns, {
        llmCompaction, llmExtraction,
        ...(passB ? { extractionPasses: 2 as const, llmExtractionPassB: passB.provider } : {}),
      });
      perFixture[fixture.id] = {
        // FEAT-542: evidence now threaded through (was dropped here before —
        // pipeline-direct.ts's DirectRunResult.atoms already carries it).
        atoms: result.atoms.map(a => ({ type: a.type, text: a.text, evidence: a.evidence })),
        wallMs: result.wallMs,
        status: 'ready',
        poisonJobs: 0,
        usageUsd: result.usageUsd,
        // FEAT-534 AC-4 (review finding, PR #376): threaded through to
        // runModelOnce -> FixtureReportRow below, not just printed — the
        // archived results.json/report.md are the actual measurement gate
        // for adopting hybrid as default, not this console line.
        passAAtomCount: result.passAAtomCount,
        passBAtomCount: result.passBAtomCount,
      };
      const splitNote = result.passBAtomCount !== undefined
        ? ` (passA=${result.passAAtomCount}, passB=${result.passBAtomCount}, merged=${result.atoms.length})`
        : '';
      console.log(`${result.atoms.length} atoms${splitNote} in ${result.wallMs}ms ($${result.usageUsd.toFixed(4)})`);
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
  console.error('  Mixed-pass (FEAT-534): <spec>+passB=<spec>, e.g. codex:gpt-5.4-mini+passB=ollama:qwen3:8b — pass A on the base spec, pass B (specifics sweeper) on the override; only azure:/openai:/codex: base specs support it.');
  console.error('  --runs N (default 1): re-run extraction+judging N times per model; N>1 reports mean±stdev and a pairwise significance gate (FEAT-450).');
  console.error(`  --compaction-model <tag> (default ${DEFAULT_COMPACTION_MODEL}): compaction model held constant across every candidate.`);
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
// --compaction-model (2026-07-13, qwen3:8b operator standardization): compaction
// was five hardcoded 'qwen2.5-coder:7b' literals scattered through this file —
// now one named default (lib/daemon-runner.ts's DEFAULT_COMPACTION_MODEL),
// overridable here so a future model swap doesn't repeat the hunt.
const compactionModel = get('--compaction-model') ?? DEFAULT_COMPACTION_MODEL;
// --compaction-mode auto|always|never (additive, 2026-07-17): `never` = raw-turn
// passthrough for the daemon-path candidates — isolates compaction-stage loss
// from extractor quality. Omit to inherit the shipped default (auto). Daemon
// path only; the azure:/codex: direct path keeps its own pipeline defaults.
const compactionMode = get('--compaction-mode') as 'auto' | 'always' | 'never' | undefined;
if (compactionMode !== undefined && !['auto', 'always', 'never'].includes(compactionMode)) {
  console.error(`--compaction-mode must be auto|always|never, got: ${compactionMode}`);
  process.exit(1);
}
// --max-chunk-chars N (additive, 2026-07-17): chunk-size A/B lever for the
// daemon-path candidates — overrides config.distill.maxChunkChars (default 3200)
// in the sandbox config. Daemon path only, like --compaction-mode.
const maxChunkCharsRaw = get('--max-chunk-chars');
const maxChunkChars = maxChunkCharsRaw !== undefined ? Number(maxChunkCharsRaw) : undefined;
if (maxChunkChars !== undefined && (!Number.isInteger(maxChunkChars) || maxChunkChars < 400)) {
  console.error(`--max-chunk-chars must be an integer >= 400, got: ${maxChunkCharsRaw}`);
  process.exit(1);
}
// --atom-triage off|dry-run|enabled (additive, 2026-07-17): FEAT-533 post-
// extraction keep/junk triage as a bench A/B lever; triage provider pinned to
// the candidate extraction model itself (see daemon-runner). Daemon path only.
const atomTriageMode = get('--atom-triage') as 'off' | 'dry-run' | 'enabled' | 'repair-only' | undefined;
if (atomTriageMode !== undefined && !['off', 'dry-run', 'enabled', 'repair-only'].includes(atomTriageMode)) {
  console.error(`--atom-triage must be off|dry-run|enabled|repair-only, got: ${atomTriageMode}`);
  process.exit(1);
}
// --triage-model NAME (additive, FEAT-547): pins the atom-triage tier's
// model INDEPENDENTLY of the candidate extraction model — the existing
// --atom-triage lever alone always pins triage to the extraction candidate
// itself (see daemon-runner's runOllamaCandidate), which can't express a
// phi4-mini/qwen2.5:7b-triaging-CODEX's-atoms A/B (FEAT-547 AC-3). Only
// meaningful alongside --atom-triage (ignored otherwise — no atomTriage
// config block is ever emitted when --atom-triage is unset). Daemon path
// only, same constraint --atom-triage itself already carries.
const triageModel = get('--triage-model');
// --gatekeeper off|dry-run|enabled (additive, 2026-07-18): FEAT-548
// pre-extraction chunk-level substantiveness gate as a bench A/B lever;
// gatekeeper provider pinned to the candidate extraction model itself (see
// daemon-runner). Daemon path only, mirroring --atom-triage. This is the
// lever AC-4's 55-fixture dry-run measurement runs through (`--gatekeeper
// dry-run`): every substantive fixture must report a 0% false-skip rate.
const gatekeeperMode = get('--gatekeeper') as 'off' | 'dry-run' | 'enabled' | undefined;
if (gatekeeperMode !== undefined && !['off', 'dry-run', 'enabled'].includes(gatekeeperMode)) {
  console.error(`--gatekeeper must be off|dry-run|enabled, got: ${gatekeeperMode}`);
  process.exit(1);
}

interface ModelAtomsByFixture {
  model: string;
  perFixture: Record<string, {
    atoms: JudgeAtomIn[]; wallMs: number; status: string; poisonJobs: number; usageUsd: number;
    /** FEAT-534: only set by collectDirect's mixed-pass (`+passB=`) branch. */
    passAAtomCount?: number; passBAtomCount?: number;
  }>;
  daemonBootMs: number | null;
}

async function collectAtomsForModel(model: string, fixtures: GoldFixture[]): Promise<ModelAtomsByFixture> {
  // FEAT-534: mixed-pass spec syntax, e.g. `codex:gpt-5.4-mini+passB=ollama:qwen3:8b`.
  // `base` drives the existing prefix branching below unchanged; `passBSpec`
  // (when present) is resolved once here and threaded into whichever
  // direct-pipeline branch matches `base` — the ONLY specs that support it,
  // since the daemon-HTTP (bare ollama) and nuextract:adapted branches below
  // have no in-process pipeline call to attach a second pass to.
  const { base, passBSpec } = splitPassBSuffix(model);
  const passB = passBSpec ? buildProviderFromSpec(passBSpec) : undefined;

  if (base.startsWith('azure:')) {
    const deployment = base.slice('azure:'.length);
    console.log(`\n=== ${model} (direct in-process pipeline; compaction=ollama/${compactionModel}, extraction=azure/${deployment}${passB ? `, passB=${passB.label}` : ''}) ===`);
    const azureCfg = resolveAzureConfig({ answererDeployment: deployment });
    const llmCompaction = new OllamaLLMProvider({ model: compactionModel });
    const llmExtraction = new AzureReasoningLLMProvider({ cfg: azureCfg, model: deployment, reasoningEffort: 'minimal' });
    return collectDirect(model, llmCompaction, llmExtraction, fixtures, passB);
  }

  if (base.startsWith('openai:')) {
    // openai:<alias>:<model> — e.g. openai:dashscope:qwen-plus
    const firstColon = base.indexOf(':');
    const secondColon = base.indexOf(':', firstColon + 1);
    const alias = base.slice(firstColon + 1, secondColon);
    const extractModel = base.slice(secondColon + 1);
    const a = OPENAI_ALIASES[alias];
    if (!a) throw new Error(`unknown openai alias '${alias}' — known: ${Object.keys(OPENAI_ALIASES).join(', ')}`);
    const apiKey = process.env[a.envKey];
    if (!apiKey) throw new Error(`${a.envKey} not set (add it to .bench-keys.env) — required for ${base}`);
    console.log(`\n=== ${model} (direct in-process pipeline; compaction=ollama/${compactionModel}, extraction=openai-compat ${alias}/${extractModel}${passB ? `, passB=${passB.label}` : ''}) ===`);
    const llmCompaction = new OllamaLLMProvider({ model: compactionModel });
    const llmExtraction = new OpenAICompatibleLLMProvider({ baseUrl: a.baseUrl, model: extractModel, apiKey });
    return collectDirect(model, llmCompaction, llmExtraction, fixtures, passB);
  }

  if (base.startsWith('codex:')) {
    // codex:<model> — uses the machine's existing ~/.codex login (no key).
    const codexModel = base.slice('codex:'.length);
    console.log(`\n=== ${model} (direct in-process pipeline; compaction=ollama/${compactionModel}, extraction=codex-subscription/${codexModel}${passB ? `, passB=${passB.label}` : ''}) ===`);
    const llmCompaction = new OllamaLLMProvider({ model: compactionModel });
    const llmExtraction = new CodexSubscriptionLLMProvider({ model: codexModel });
    return collectDirect(model, llmCompaction, llmExtraction, fixtures, passB);
  }

  if (passBSpec) {
    throw new Error(
      `+passB= mixed-pass syntax is only supported for direct-pipeline specs (azure:/openai:/codex:), ` +
      `not '${base}' (daemon HTTP path / nuextract:adapted have no in-process pipeline to attach a second pass to). See FEAT-534.`,
    );
  }

  if (model === 'nuextract:adapted') {
    console.log(`\n=== ${model} (direct in-process pipeline; compaction=ollama/${compactionModel}, extraction=ollama/nuextract via bench-side template adapter) ===`);
    const llmCompaction = new OllamaLLMProvider({ model: compactionModel });
    const llmExtraction = new NuExtractAdapterProvider({ model: 'nuextract' });

    const perFixture: ModelAtomsByFixture['perFixture'] = {};
    for (const fixture of fixtures) {
      process.stdout.write(`  ${fixture.id}... `);
      try {
        const result = await runDirectPipeline(fixture.turns, { llmCompaction, llmExtraction });
        perFixture[fixture.id] = {
          atoms: result.atoms.map(a => ({ type: a.type, text: a.text, evidence: a.evidence })),
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

  console.log(`\n=== ${model} (daemon HTTP path; compaction=ollama/${compactionModel}, extraction=ollama/${model}) ===`);
  const run = await runOllamaCandidate(model, fixtures, { perSessionTimeoutMs, compactionModel, ...(compactionMode ? { compactionMode } : {}), ...(maxChunkChars ? { maxChunkChars } : {}), ...(atomTriageMode ? { atomTriageMode } : {}), ...(triageModel ? { triageModel } : {}), ...(gatekeeperMode ? { gatekeeperMode } : {}) });
  console.log(`  daemon boot: ${run.daemonBootMs}ms`);
  const perFixture: ModelAtomsByFixture['perFixture'] = {};
  for (const r of run.results as DaemonFixtureResult[]) {
    console.log(`  ${r.fixtureId}: ${r.status} — ${r.atoms.length} atoms in ${r.wallMs}ms${r.poisonJobs > 0 ? ` (${r.poisonJobs} poison jobs)` : ''}`);
    perFixture[r.fixtureId] = {
      // FEAT-542: evidence now flows from DaemonAtom (digest route additively
      // exposes it — src/server/queries/provenance.ts) instead of being
      // dropped here, so Ollama daemon-path candidates get real Evidence-acc
      // numbers too, not a permanent dash.
      atoms: r.atoms.map(a => ({ type: a.type, text: a.text, evidence: a.evidence })),
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

    // FEAT-542 AC-2/AC-6: mechanical forbidden-item scoring — runs whether or
    // not the LLM judge ran (skip-judge smoke passes still get precision-
    // relevant signal for free), and never touches judge.ts's own logic.
    let forbiddenHitCount: number | undefined;
    if (fixture.forbidden_items && fixture.forbidden_items.length > 0) {
      const hits = findForbiddenItemHits(entry.atoms, fixture.forbidden_items);
      forbiddenHitCount = hits.length;
      if (score) {
        score = applyForbiddenItemScoring(score, entry.atoms, fixture.forbidden_items).score;
      }
    }

    // FEAT-542 AC-3: mechanical evidence-accuracy — judge-free, so this is
    // computed unconditionally (including --skip-judge runs).
    const evidenceResult = computeEvidenceAccuracy(entry.atoms, fixtureTranscriptText(fixture.turns));

    fixtureReports.push({
      fixtureId: fixture.id,
      difficulty: fixture.difficulty,
      status: entry.status,
      wallMs: entry.wallMs,
      poisonJobs: entry.poisonJobs,
      atoms: entry.atoms,
      score,
      // FEAT-534 (review finding, PR #376): undefined on every single-pass
      // fixture (the daemon-HTTP/nuextract branches above never set these on
      // `entry`), same optional shape FixtureReportRow documents.
      passAAtomCount: entry.passAAtomCount,
      passBAtomCount: entry.passBAtomCount,
      forbiddenItemHits: forbiddenHitCount,
      evidenceAccNumerator: evidenceResult.denominator > 0 ? evidenceResult.numerator : undefined,
      evidenceAccDenominator: evidenceResult.denominator > 0 ? evidenceResult.denominator : undefined,
    });
  }

  const azureUsd = Object.values(collected.perFixture).reduce((sum, e) => sum + e.usageUsd, 0);
  const aggregate = aggregateFixtureScores(fixtureReports, azureUsd);

  return {
    report: { model, daemonBootMs: collected.daemonBootMs, fixtures: fixtureReports, aggregate },
    judgeUsd,
  };
}

/**
 * Run-identity metadata (added 2026-07-13, model-ab investigation).
 *
 * The ab-run-2026-07-08 report shipped a qwen3:8b row that looked like a
 * real quality/speed measurement but was actually an artifact of a since-
 * fixed bug (Ollama's `think` default), and nothing in that run recorded
 * enough to tell the two apart after the fact — no code version, no Ollama
 * env, no fixture-set identity. `results.json` itself keeps its documented
 * plain-array shape (AC-5, see the write below) so this writes a SIBLING
 * `run-metadata.json` instead of changing that contract.
 */
function collectRunMetadata(fixtures: GoldFixture[]): Record<string, unknown> {
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  const tryGit = (cmd: string): string => {
    try {
      return execSync(cmd, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      return 'unknown';
    }
  };
  const ollamaEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith('OLLAMA_')),
  );
  // Sorted-by-id content hash — identifies exactly which fixture bytes were
  // run, not just a count, so a fixture edit that keeps the same file names
  // is still detectable.
  const fixtureSetHash = createHash('sha256')
    .update(JSON.stringify([...fixtures].sort((a, b) => a.id.localeCompare(b.id))))
    .digest('hex');

  return {
    recordedAt: new Date().toISOString(),
    gitSha: tryGit('git rev-parse HEAD'),
    gitBranch: tryGit('git rev-parse --abbrev-ref HEAD'),
    gitDirty: tryGit('git status --porcelain').length > 0,
    ollamaEnv, // whatever OLLAMA_* vars were visible to THIS process — may not reflect the Ollama server's own env if it was started elsewhere (see note below)
    ollamaEnvNote: 'reflects the bench process env, not necessarily the Ollama server process env if it runs as a separate service — treat absence as "unrecorded", not "unset"',
    modelsUnderTest: models,
    compactionModel: `ollama/${compactionModel}`, // held constant for every candidate — see README "What it measures"; sourced from the --compaction-model flag (default DEFAULT_COMPACTION_MODEL), not hardcoded
    runsPerModel: runsCount,
    judgeReasoningEffort,
    fixtureCount: fixtures.length,
    fixtureSetHash,
  };
}

/**
 * FEAT-544: numeric quality-gate tiers. `gates.json` is optional — a missing
 * file quietly disables the whole Gates section (no error, no gates-summary.json)
 * rather than blocking the bench; a PRESENT-but-malformed file throws loudly
 * (loadGatesConfig's own shape validation) since that's a real misconfiguration.
 */
const gatesConfig: GatesConfig | null = loadGatesConfig();

/** Builds the `RenderOptions.gates` object (or `undefined` when no gates.json). */
function buildGatesRenderOpts(reports: ModelReport[], actualFixtureCount: number) {
  if (!gatesConfig) return undefined;
  return { config: gatesConfig, results: evaluateGates(gatesConfig, reports), actualFixtureCount };
}

async function main(): Promise<void> {
  const fixtures = fixturesDir ? loadFixtures(fixturesDir) : loadFixtures();
  console.log(`Loaded ${fixtures.length} gold fixtures.`);
  console.log(`Models under test: ${models.join(', ')}`);
  if (runsCount > 1) console.log(`Runs per model: ${runsCount} (multi-run variance mode — FEAT-450)`);
  if (gatesConfig) {
    const warning = staleCalibrationWarning(gatesConfig, fixtures.length);
    if (warning) console.log(`[gates] WARNING: ${warning}`);
  } else {
    console.log(`No gates.json found at default path — Gates section omitted from report.md.`);
  }

  const runMetadataStart = Date.now();
  const runMetadata = collectRunMetadata(fixtures);
  writeFileSync(join(outDir, 'run-metadata.json'), JSON.stringify(runMetadata, null, 2));

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
    writeFileSync(join(outDir, 'report.md'), renderMarkdown(reports, totalAzureJudgeUsd, { judgeReasoningEffort, gates: buildGatesRenderOpts(reports, fixtures.length) }));
    // FEAT-542 AC-7: raw per-model inputs behind Evidence-acc/forbidden-item
    // hits — closes the observability gap the FEAT calls out (the final
    // percentage alone doesn't tell you the sample size it was computed
    // from). Written after every model, same crash-safety reasoning as
    // results.json/report.md above.
    writeFileSync(
      join(outDir, 'summary.json'),
      JSON.stringify(
        reports.map(r => ({
          model: r.model,
          forbiddenItemHitsTotal: r.aggregate.forbiddenItemHitsTotal,
          evidenceAccNumerator: r.aggregate.evidenceAccNumerator,
          evidenceAccDenominator: r.aggregate.evidenceAccDenominator,
          evidenceAcc: r.aggregate.evidenceAcc,
        })),
        null,
        2,
      ),
    );
    // FEAT-544 AC-8: machine-readable gate verdicts alongside the prose
    // Gates section in report.md — same "written after every model" crash
    // safety as summary.json above. Omitted entirely (no file written) when
    // no gates.json was loaded, mirroring the report.md section's own
    // silent-omission behavior.
    if (gatesConfig) {
      writeFileSync(
        join(outDir, 'gates-summary.json'),
        JSON.stringify(
          {
            calibration: gatesConfig.calibration,
            actualFixtureCount: fixtures.length,
            staleCalibrationWarning: staleCalibrationWarning(gatesConfig, fixtures.length),
            results: evaluateGates(gatesConfig, reports),
          },
          null,
          2,
        ),
      );
    }
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

  const md = renderMarkdown(reports, totalAzureJudgeUsd, { judgeReasoningEffort, agreement, gates: buildGatesRenderOpts(reports, fixtures.length) });
  writeFileSync(join(outDir, 'report.md'), md);

  writeFileSync(
    join(outDir, 'run-metadata.json'),
    JSON.stringify({ ...runMetadata, finishedAt: new Date().toISOString(), durationMs: Date.now() - runMetadataStart }, null, 2),
  );

  console.log(`\n${md}`);
  console.log(`\nResults -> ${join(outDir, 'results.json')}`);
  console.log(`Report  -> ${join(outDir, 'report.md')}`);
  console.log(`Metadata -> ${join(outDir, 'run-metadata.json')}`);
  if (agreement.length > 0) console.log(`Judge self-agreement -> ${join(outDir, 'judge-agreement.json')}`);
}

await main();
