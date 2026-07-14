/**
 * #273 (WS7) — chunk-size sweep, PRECISION/JUNK-RATE leg. Sibling to
 * run-chunksize-sweep-sessions.mts (that one measures atom YIELD on real
 * LoCoMo sessions with no gold answer key); this one measures RECALL,
 * PRECISION, F1, and JUNK RATE at each chunk size using the extraction-
 * bench's hand-authored gold fixtures + Azure gpt-5-mini judge — the
 * instrument the team-lead brief called out by name: "more atoms is not
 * automatically better... a recall win that tanks precision is NOT a win."
 *
 * Cloud-only (codex-subscription for compaction AND extraction — zero
 * GPU/Ollama load, unlike run-bench.mts's `codex:` branch which still
 * hardcodes Ollama for compaction). Does NOT touch run-bench.mts, which is
 * under concurrent use by another workstream tonight.
 *
 * Fixture subset (16 of 44, chosen for coverage, not the full set, to keep
 * judge spend bounded across a 5-point size sweep): every 'nothing' fixture
 * (over-extraction control), every 'contradiction' fixture, every 'long'
 * fixture (multi-topic — exactly the shape most sensitive to chunk size),
 * both 'conversational' fixtures (fx44/fx45 — named-speaker shape, closest
 * proxy to LoCoMo among the gold-scored fixtures), plus a handful of
 * clean/noisy/secrets for a broader junk-rate read.
 *
 * Usage:
 *   bun scripts/eval/extraction-bench/run-chunksize-sweep-fixtures.mts \
 *     --sizes 3200,2400,1600,1200,800 --model gpt-5.4-mini --runs 1
 *   # confirmation pass at just two sizes, 3 runs each (FEAT-450 protocol):
 *   bun scripts/eval/extraction-bench/run-chunksize-sweep-fixtures.mts \
 *     --sizes 3200,1600 --runs 3 --out-dir results/chunksize-fixtures-confirm
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadFixtures, FIXTURES_DIR, type GoldFixture } from './lib/fixtures.js';
import { CodexSubscriptionLLMProvider } from '../../../src/providers/llm/codex-subscription.js';
import { defaultConfig, type Config } from '../../../src/config/config.js';
import { runDirectPipeline } from './lib/pipeline-direct.js';
import { judgeFixture, type FixtureScore } from './lib/judge.js';
import { aggregateFixtureScores, combineRuns, renderMarkdown, type SingleRunReport, type ModelReport, type FixtureReportRow } from './lib/report.js';
import { resolveAzureConfig } from '../shared/config.js';

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (flag: string): boolean => args.includes(flag);

const sizes = (get('--sizes') ?? '3200,2400,1600,1200,800').split(',').map(s => Number(s.trim()));
const model = get('--model') ?? 'gpt-5.4-mini';
const runsCount = Math.max(1, Math.trunc(Number(get('--runs') ?? '1') || 1));
const outDir = get('--out-dir') ?? join(import.meta.dirname, 'results', `chunksize-fixtures-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outDir, { recursive: true });

// Curated 16-fixture subset (see header). --fixtures overrides with an
// explicit comma-separated id prefix list for a smoke test.
const DEFAULT_SUBSET = [
  'fx08-long-multitopic', 'fx28-long-threetopics-infra', 'fx29-long-multitopic-review', 'fx42-long-multitopic-mixed',
  'fx09-nothing-worth-remembering', 'fx30-nothing-smalltalk-weather', 'fx31-nothing-offtopic-joke',
  'fx10-contradiction-correction', 'fx32-contradiction-port-number', 'fx33-contradiction-cache-ttl',
  'fx44-conversational-marcus-priya-life-updates', 'fx45-conversational-sentiment-padding-carveout',
  'fx01-clean-decision', 'fx16-clean-decision-caching',
  'fx07-noisy-tool-spam',
  'fx14-secrets-present',
];
const subsetArg = get('--fixtures');
const subsetIds = has('--smoke') ? DEFAULT_SUBSET.slice(0, 2) : (subsetArg ? subsetArg.split(',').map(s => s.trim()) : DEFAULT_SUBSET);

async function main() {
  const allEngineering = loadFixtures(FIXTURES_DIR);
  const allConversational = loadFixtures(join(FIXTURES_DIR, '..', 'fixtures-conversational'));
  const all = [...allEngineering, ...allConversational];
  const fixtures: GoldFixture[] = subsetIds.map(id => {
    const f = all.find(x => x.id === id);
    if (!f) throw new Error(`fixture id not found: ${id} (available: ${all.map(x => x.id).join(', ')})`);
    return f;
  });
  console.log(`Fixture subset (${fixtures.length}): ${fixtures.map(f => f.id).join(', ')}`);

  const llmCompaction = new CodexSubscriptionLLMProvider({ model });
  const llmExtraction = new CodexSubscriptionLLMProvider({ model });
  const azureCfgForJudge = resolveAzureConfig();

  const activeSizes = has('--smoke') ? [sizes[0] as number] : sizes;
  const modelReports: ModelReport[] = [];
  let totalJudgeUsd = 0;

  for (const size of activeSizes) {
    console.log(`\n=== maxChunkChars=${size} (${runsCount} run(s)) ===`);
    const config: Config = { ...defaultConfig(), distill: { ...defaultConfig().distill, maxChunkChars: size } };
    const label = `chunkChars=${size}`;
    const runs: SingleRunReport[] = [];

    for (let runIdx = 0; runIdx < runsCount; runIdx++) {
      if (runsCount > 1) console.log(`  -- run ${runIdx + 1}/${runsCount} --`);
      const fixtureReports: FixtureReportRow[] = [];
      let azureUsd = 0;

      for (const fixture of fixtures) {
        process.stdout.write(`  ${fixture.id}... `);
        try {
          const result = await runDirectPipeline(fixture.turns, { llmCompaction, llmExtraction, config });
          const atoms = result.atoms.map(a => ({ type: a.type, text: a.text }));
          azureUsd += result.usageUsd;

          let score: FixtureScore | null = null;
          try {
            score = await judgeFixture(azureCfgForJudge, fixture.id, fixture.gold_atoms, atoms, 'low');
            if (!(fixture.gold_atoms.length === 0 && atoms.length === 0)) totalJudgeUsd += 0.001;
          } catch (err) {
            console.log(`[judge FAILED: ${err instanceof Error ? err.message : String(err)}] `);
          }

          fixtureReports.push({
            fixtureId: fixture.id, difficulty: fixture.difficulty, status: 'ready',
            wallMs: result.wallMs, poisonJobs: 0, atoms, score,
          });
          const scoreStr = score ? `recall=${score.recall !== null ? (score.recall * 100).toFixed(0) + '%' : '—'} precision=${score.precision !== null ? (score.precision * 100).toFixed(0) + '%' : '—'}` : 'unscored';
          console.log(`${atoms.length} atoms, ${result.chunksProcessed} chunks, ${result.wallMs}ms — ${scoreStr}`);
        } catch (err) {
          console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
          fixtureReports.push({ fixtureId: fixture.id, difficulty: fixture.difficulty, status: 'error', wallMs: 0, poisonJobs: 0, atoms: [], score: null });
        }
      }

      const aggregate = aggregateFixtureScores(fixtureReports, azureUsd);
      runs.push({ model: label, daemonBootMs: null, fixtures: fixtureReports, aggregate });
    }

    modelReports.push(combineRuns(runs));
  }

  const md = renderMarkdown(modelReports, totalJudgeUsd, { judgeReasoningEffort: 'low' });
  writeFileSync(join(outDir, 'report.md'), md);
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(modelReports, null, 2));
  console.log(`\nWrote ${join(outDir, 'report.md')} and results.json`);
  console.log(`\n${md}`);
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
