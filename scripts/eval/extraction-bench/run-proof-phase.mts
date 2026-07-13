/**
 * SLICE-436 hardened proof phase (FEAT-479 AC-12/AC-13).
 *
 * Compares 4 extraction configs — old prompt vs new (v3) prompt, and local
 * qwen2.5-coder:7b vs the two codex-subscription tiers — over a bounded
 * subset of the extraction-bench gold fixtures, running each config
 * SEQUENTIALLY (never parallel — Ollama shares VRAM with the prod daemon's
 * compaction; codex-subscription shares the operator's ChatGPT quota) with
 * >=2 runs per config so quality is reported as a RANGE, not a point
 * estimate (architect-review item 6, design doc §3.4/§7).
 *
 * All 4 configs run through the SAME in-process direct pipeline
 * (lib/pipeline-direct.ts's runDirectPipeline) rather than mixing the
 * daemon-HTTP path (used by run-bench.mts for bare Ollama tags) with the
 * direct path (used for codex/azure) — this bench's own stated methodology
 * already holds compaction constant at ollama/qwen2.5-coder:7b and varies
 * only extraction; running every config through the identical code path
 * additionally (a) makes atom/relation counts directly comparable across
 * all 4 configs (relations survive this path — see the additive
 * DirectRunResult.atoms[].relations field added to pipeline-direct.ts for
 * this slice) and (b) avoids spinning 8 isolated daemons (4 configs x 2
 * runs) just to get numbers the direct path already produces byte-for-byte
 * identically (everything except the HTTP/job-queue/storage layer is the
 * real production code path — see README.md).
 *
 * BLINDING (architect-review item 6): the judge (lib/judge.ts, Azure
 * gpt-5-mini) already only ever receives {type, text} atom pairs — it has
 * no config/model-identifying input by construction, so it is structurally
 * blind regardless of this harness. This script additionally blinds its OWN
 * bookkeeping: every config is assigned a random letter (A-D) at startup,
 * all per-run console output and the raw per-letter results object use only
 * that letter, and the letter -> real config mapping is held in a variable
 * that is never printed until revealLetterMapping() runs at the very end,
 * after every run for every config has already been scored. This is
 * blinding as a structural property of the code, not a promise about
 * discipline.
 *
 * Usage:
 *   bun scripts/eval/extraction-bench/run-proof-phase.mts [--runs 2] [--out-dir <dir>]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadFixtures, type GoldFixture } from './lib/fixtures.js';
import { runDirectPipeline, type DirectRunResult } from './lib/pipeline-direct.js';
import { judgeFixture, type JudgeAtomIn } from './lib/judge.js';
import { aggregateFixtureScores, combineRuns, type FixtureReportRow, type SingleRunReport, type RunAggregate } from './lib/report.js';
import { resolveAzureConfig } from '../shared/config.js';
import { OllamaLLMProvider } from '../../../src/providers/llm/ollama.js';
import { CodexSubscriptionLLMProvider } from '../../../src/providers/llm/codex-subscription.js';
import type { LLMProvider } from '../../../src/contracts/llm.js';

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const RUNS = Math.max(2, Math.trunc(Number(get('--runs') ?? '2') || 2));
const outDir = get('--out-dir') ?? join(import.meta.dirname, 'results', `proof-phase-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });
/** Smoke-test seams — restrict fixtures/config keys for a cheap dry run before
 * paying for the full live matrix. Unset in the real proof-phase invocation. */
const fixtureOverride = get('--fixtures')?.split(',').map(s => s.trim()).filter(Boolean);
const configOverride = get('--configs')?.split(',').map(s => s.trim()).filter(Boolean);

const COMPACTION_MODEL = 'qwen2.5-coder:7b';

// --- Bounded fixture subset (honest reduction from the full 44) ------------
// Full sweep would be 44 fixtures x 2 runs x 4 configs = 352 extraction
// calls, 176 of them against codex-subscription (the operator's metered
// ChatGPT quota) — explicitly out of budget per the dispatch's "keep total
// codex calls bounded" instruction. This subset is chosen to span the
// dimensions the proof phase actually needs to see, not sampled at random:
//   - fx43: the SLICE-433 richness regression guard (rich lesson+decision,
//     the exact shape this whole FEAT exists to produce)
//   - fx44 (fixtures-conversational/, NOT the default fixtures/ dir — see
//     that file's own header comment for why): personal/conversational
//     content under the ENGINEERING profile — an over-extraction-restraint
//     check, gold_atoms: []
//   - fx13: entity/relation-rich (many named things in one session)
//   - fx01: a clean baseline decision — the simplest case, a control
//   - fx09: nothing-worth-remembering — precision/restraint, mirrors fx44's
//     role from a different angle (technical noise vs personal chatter)
const FIXTURE_IDS = [
  'fx43-rich-lesson-embed-cache-stampede',
  'fx13-entity-rich',
  'fx01-clean-decision',
  'fx09-nothing-worth-remembering',
] as const;
const CONVERSATIONAL_FIXTURES_DIR = join(import.meta.dirname, 'fixtures-conversational');
const FX44_ID = 'fx44-conversational-marcus-priya-life-updates';
/** Default fixture set for a full (non-overridden) run: FIXTURE_IDS + fx44. */
const DEFAULT_FIXTURE_IDS = [...FIXTURE_IDS, FX44_ID];

interface ConfigDef {
  key: string;
  label: string;
  /** ASTRA_EXTRACT_PROMPT override; undefined = default (v3, the new prompt). */
  extractPromptEnv: string | undefined;
  makeExtraction: () => LLMProvider;
}

const CONFIGS: ConfigDef[] = [
  {
    key: 'qwen_v1',
    label: 'qwen2.5-coder:7b + OLD prompt (v1 rollback)',
    extractPromptEnv: 'v1',
    makeExtraction: () => new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' }),
  },
  {
    key: 'qwen_v3',
    label: 'qwen2.5-coder:7b + NEW prompt (v3, current default)',
    extractPromptEnv: undefined,
    makeExtraction: () => new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' }),
  },
  {
    key: 'codex_mini_v3',
    label: 'codex-subscription gpt-5.4-mini + v3',
    extractPromptEnv: undefined,
    makeExtraction: () => new CodexSubscriptionLLMProvider({ model: 'gpt-5.4-mini' }),
  },
  {
    key: 'codex_55_v3',
    label: 'codex-subscription gpt-5.5 + v3',
    extractPromptEnv: undefined,
    makeExtraction: () => new CodexSubscriptionLLMProvider({ model: 'gpt-5.5' }),
  },
];

const LETTERS = ['A', 'B', 'C', 'D'] as const;

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

const activeConfigs = configOverride ? CONFIGS.filter(c => configOverride.includes(c.key)) : CONFIGS;
const shuffledConfigs = shuffled(activeConfigs);
const activeLetters = LETTERS.slice(0, shuffledConfigs.length);
const letterToConfig = new Map<string, ConfigDef>(activeLetters.map((L, i) => [L, shuffledConfigs[i] as ConfigDef]));

interface RunExtras {
  atomCount: number;
  relationCount: number;
  retriedFixtures: string[];
  fixtureWallMs: Record<string, number>;
}

async function runOneFixtureWithRetry(
  fixture: GoldFixture,
  llmCompaction: LLMProvider,
  llmExtraction: LLMProvider,
  retriedFixtures: string[],
): Promise<{ result: DirectRunResult; status: 'ready' | 'error' }> {
  try {
    const result = await runDirectPipeline(fixture.turns, { llmCompaction, llmExtraction });
    return { result, status: 'ready' };
  } catch (err) {
    // SLICE-433 precedent: Ollama shares VRAM with the prod daemon's
    // compaction and can evict/ECONNRESET mid-run. One retry at the same
    // (resident) config, same as OllamaLLMProvider's own internal
    // fetchWithRetry does per-call — this is a second, fixture-level layer
    // in case both internal attempts still lost the race.
    console.log(`    [retry] ${fixture.id}: ${err instanceof Error ? err.message : String(err)} — retrying once`);
    retriedFixtures.push(fixture.id);
    await sleep(2000);
    try {
      const result = await runDirectPipeline(fixture.turns, { llmCompaction, llmExtraction });
      return { result, status: 'ready' };
    } catch (err2) {
      console.log(`    [retry] ${fixture.id}: FAILED again — ${err2 instanceof Error ? err2.message : String(err2)}`);
      return {
        result: { atoms: [], chunksProcessed: 0, wallMs: 0, usageUsd: 0 },
        status: 'error',
      };
    }
  }
}

async function runOneConfigOnce(
  letter: string,
  config: ConfigDef,
  fixtures: GoldFixture[],
  azureCfg: ReturnType<typeof resolveAzureConfig>,
): Promise<{ report: SingleRunReport; extras: RunExtras }> {
  if (config.extractPromptEnv) {
    process.env.ASTRA_EXTRACT_PROMPT = config.extractPromptEnv;
  } else {
    delete process.env.ASTRA_EXTRACT_PROMPT;
  }

  const llmCompaction = new OllamaLLMProvider({ model: COMPACTION_MODEL });
  const llmExtraction = config.makeExtraction();

  const retriedFixtures: string[] = [];
  const fixtureRows: FixtureReportRow[] = [];
  let usageUsdTotal = 0;
  let atomCount = 0;
  let relationCount = 0;
  const fixtureWallMs: Record<string, number> = {};

  for (const fixture of fixtures) {
    process.stdout.write(`    [config ${letter}] ${fixture.id}... `);
    const { result, status } = await runOneFixtureWithRetry(fixture, llmCompaction, llmExtraction, retriedFixtures);
    usageUsdTotal += result.usageUsd;
    atomCount += result.atoms.length;
    relationCount += result.atoms.reduce((s, a) => s + (a.relations?.length ?? 0), 0);
    fixtureWallMs[fixture.id] = result.wallMs;
    console.log(`${result.atoms.length} atoms, ${result.atoms.reduce((s, a) => s + (a.relations?.length ?? 0), 0)} relations, ${result.wallMs}ms, $${result.usageUsd.toFixed(4)}`);

    const atomsForJudge: JudgeAtomIn[] = result.atoms.map(a => ({ type: a.type, text: a.text }));
    let score = null;
    try {
      score = await judgeFixture(azureCfg, fixture.id, fixture.gold_atoms, atomsForJudge, 'low');
    } catch (err) {
      console.log(`    [judge] ${fixture.id} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }

    fixtureRows.push({
      fixtureId: fixture.id,
      difficulty: fixture.difficulty,
      status,
      wallMs: result.wallMs,
      poisonJobs: 0,
      atoms: atomsForJudge,
      score,
    });
  }

  const aggregate = aggregateFixtureScores(fixtureRows, usageUsdTotal);
  return {
    report: { model: letter, daemonBootMs: null, fixtures: fixtureRows, aggregate },
    extras: { atomCount, relationCount, retriedFixtures, fixtureWallMs },
  };
}

interface LetterResult {
  letter: string;
  combined: ReturnType<typeof combineRuns>;
  runs: RunAggregate[];
  extrasPerRun: RunExtras[];
}

async function main(): Promise<void> {
  console.log(`SLICE-436 proof phase — ${activeConfigs.length} configs, ${RUNS} runs each, judged BLIND (labels ${activeLetters.join('/')}; mapping revealed only in the final report)\n`);

  const wantedIds = fixtureOverride ?? DEFAULT_FIXTURE_IDS;
  const baseIds = wantedIds.filter(id => id !== FX44_ID);
  const baseFixtures = loadFixtures().filter(f => baseIds.includes(f.id));
  const missing = baseIds.filter(id => !baseFixtures.some(f => f.id === id));
  if (missing.length > 0) throw new Error(`missing fixtures: ${missing.join(', ')}`);
  const conversationalFixtures = wantedIds.includes(FX44_ID)
    ? loadFixtures(CONVERSATIONAL_FIXTURES_DIR)
    : [];
  const fixtures = [...baseFixtures, ...conversationalFixtures];
  console.log(`Fixtures under test: ${fixtures.map(f => f.id).join(', ')}\n`);

  const azureCfg = resolveAzureConfig({ answererDeployment: 'gpt-5-mini' });

  const letterResults: LetterResult[] = [];

  for (const letter of activeLetters) {
    const config = letterToConfig.get(letter) as ConfigDef;
    console.log(`\n=== Config ${letter} — ${RUNS} runs (blind: real identity withheld until the reveal) ===`);
    const runReports: SingleRunReport[] = [];
    const extrasPerRun: RunExtras[] = [];
    for (let runIdx = 0; runIdx < RUNS; runIdx++) {
      console.log(`  -- run ${runIdx + 1}/${RUNS} --`);
      const { report, extras } = await runOneConfigOnce(letter, config, fixtures, azureCfg);
      runReports.push(report);
      extrasPerRun.push(extras);
    }
    const combined = combineRuns(runReports);
    const runs = combined.runs ?? [combined.aggregate];
    letterResults.push({ letter, combined, runs, extrasPerRun });

    // Persist after every config, same rationale as run-bench.mts: a later
    // config's failure must never lose an already-scored one.
    writeFileSync(join(outDir, 'raw-blinded-results.json'), JSON.stringify(letterResults, null, 2));
  }

  // --- Reveal --------------------------------------------------------------
  const mappingLines = activeLetters.map(L => `  ${L} = ${(letterToConfig.get(L) as ConfigDef).label}`).join('\n');
  console.log(`\n\n=== BLIND REVEAL ===\n${mappingLines}\n`);

  const table: string[] = [];
  table.push('| Config | F1 range | Recall range | Precision range | Atoms (avg) | Relations (avg) | Cost (total) | Latency (avg/session) |');
  table.push('|---|---|---|---|---|---|---|---|');
  for (const lr of letterResults) {
    const config = letterToConfig.get(lr.letter) as ConfigDef;
    const f1s = lr.runs.map(r => r.f1 ?? NaN).filter(n => !Number.isNaN(n));
    const recalls = lr.runs.map(r => r.avgRecall ?? NaN).filter(n => !Number.isNaN(n));
    const precisions = lr.runs.map(r => r.avgPrecision ?? NaN).filter(n => !Number.isNaN(n));
    const fmtRange = (vals: number[]) => vals.length === 0 ? '—' : `${(Math.min(...vals) * 100).toFixed(0)}%–${(Math.max(...vals) * 100).toFixed(0)}%`;
    const totalCost = lr.runs.reduce((s, r) => s + r.azureUsd, 0);
    const avgAtoms = lr.extrasPerRun.reduce((s, e) => s + e.atomCount, 0) / lr.extrasPerRun.length;
    const avgRelations = lr.extrasPerRun.reduce((s, e) => s + e.relationCount, 0) / lr.extrasPerRun.length;
    const avgWallMsPerSession = lr.runs.reduce((s, r) => s + r.avgWallMsPerSession, 0) / lr.runs.length;
    const retries = lr.extrasPerRun.flatMap(e => e.retriedFixtures);
    table.push(
      `| ${lr.letter} (${config.label}) | ${fmtRange(f1s)} | ${fmtRange(recalls)} | ${fmtRange(precisions)} | ${avgAtoms.toFixed(1)} | ${avgRelations.toFixed(1)} | $${totalCost.toFixed(4)} | ${(avgWallMsPerSession / 1000).toFixed(1)}s${retries.length > 0 ? ` (${retries.length} retries)` : ''} |`,
    );
  }
  const reportTable = table.join('\n');
  console.log(reportTable);

  writeFileSync(join(outDir, 'reveal-mapping.json'), JSON.stringify(Object.fromEntries(activeLetters.map(L => [L, (letterToConfig.get(L) as ConfigDef).key])), null, 2));
  writeFileSync(join(outDir, 'final-table.md'), reportTable);
  console.log(`\nResults -> ${outDir}`);
}

await main();
