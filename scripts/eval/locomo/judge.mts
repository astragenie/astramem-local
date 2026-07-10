/**
 * Judge orchestrator. Default scoring is the F1/token-overlap reimplementation
 * in judge/metrics.ts (matches the upstream LoCoMo benchmark's own scoring,
 * see that file's header) -- Azure-free, deterministic, and works on any
 * machine with the hypotheses + reference sample file, no network required.
 *
 * `--llm-judge` additionally runs an Azure LLM-judge pass over categories
 * 1-4 (not 5 -- adversarial is already a deterministic substring check, an
 * LLM pass adds nothing there) via the same Azure deployment plumbing
 * LongMemEval's judge uses (../shared/config.ts, ../shared/azure-client.ts).
 * This exists because token-F1 against a full-sentence hypothesis is known
 * to under-score answers that are semantically correct but phrased
 * differently from the terse reference answer -- the upstream benchmark's
 * own models produce short extracted spans, ours produces natural-language
 * sentences from an `/recall`-grounded prompt (see answer.mts), so F1 alone
 * is a harsher (not necessarily wrong, just harsher) measure here than in
 * the original paper's own reported numbers. Both reports are always
 * written; `--llm-judge` is additive, never a replacement.
 *
 * bun scripts/eval/locomo/judge.mts --hyp <hypotheses.jsonl>
 *   --ref <sample.json used for the run> [--llm-judge] [--out <dir>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LOCOMO_CATEGORIES, CATEGORY_NAMES, type LoCoMoCategory, type LoCoMoSample } from './lib/types.js';
import { scoreRun, printMetricsReport, type MetricsReport } from './judge/metrics.mts';
import { azureChatComplete } from '../shared/azure-client.js';
import { resolveAzureConfig } from '../shared/config.js';

interface HypothesisRow {
  qa_id: string;
  sample_id: string;
  category: LoCoMoCategory;
  hypothesis: string;
}

function parseJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}

const LLM_JUDGE_MAX_COMPLETION_TOKENS = 5;

function buildJudgePrompt(question: string, referenceAnswer: string, hypothesis: string): string {
  return [
    'You are grading whether a candidate answer is correct for a question, given the reference (correct) answer.',
    'The candidate answer may be phrased differently, more verbosely, or more tersely than the reference -- that is fine, judge MEANING, not wording.',
    'Respond with exactly one word: "yes" if the candidate answer is correct, "no" if it is not.',
    '',
    `Question: ${question}`,
    `Reference answer: ${referenceAnswer}`,
    `Candidate answer: ${hypothesis}`,
  ].join('\n');
}

export async function runLlmJudge(
  hypotheses: HypothesisRow[],
  references: LoCoMoSample[],
): Promise<MetricsReport> {
  const azureCfg = resolveAzureConfig();
  const byQaId = new Map<string, { question: string; answer: string | number | undefined }>();
  for (const sample of references) {
    sample.qa.forEach((qa, i) => byQaId.set(`${sample.sample_id}#${i}`, { question: qa.question, answer: qa.answer }));
  }

  const byCategory = new Map<LoCoMoCategory, number[]>();
  for (const c of LOCOMO_CATEGORIES) byCategory.set(c, []);

  for (const h of hypotheses) {
    if (h.category === 5) continue; // adversarial already scored deterministically -- see judge/metrics.ts
    if (h.hypothesis.startsWith('(skipped')) continue;
    const ref = byQaId.get(h.qa_id);
    if (!ref || ref.answer === undefined) continue;
    const prompt = buildJudgePrompt(ref.question, String(ref.answer), h.hypothesis);
    const verdict = await azureChatComplete(azureCfg, {
      deployment: azureCfg.answererDeployment,
      messages: [{ role: 'user', content: prompt }],
      maxCompletionTokens: LLM_JUDGE_MAX_COMPLETION_TOKENS,
      reasoningEffort: 'minimal',
    });
    byCategory.get(h.category)!.push(verdict.trim().toLowerCase().startsWith('y') ? 1 : 0);
  }

  const perCategory = {} as MetricsReport['per_category'];
  const categoryAccuracies: number[] = [];
  const allScores: number[] = [];
  for (const c of LOCOMO_CATEGORIES) {
    const scores = byCategory.get(c)!;
    const accuracy = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : NaN;
    perCategory[c] = { accuracy, n: scores.length, name: CATEGORY_NAMES[c] };
    if (scores.length > 0) categoryAccuracies.push(accuracy);
    allScores.push(...scores);
  }
  return {
    per_category: perCategory,
    category_averaged_accuracy: categoryAccuracies.length > 0 ? categoryAccuracies.reduce((a, b) => a + b, 0) / categoryAccuracies.length : NaN,
    overall_accuracy: allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : NaN,
    n_total: allScores.length,
  };
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const hypPath = get('--hyp');
  const refPath = get('--ref');
  const useLlmJudge = has('--llm-judge');
  const outPath = get('--out') ?? `${hypPath}.metrics.json`;

  if (!hypPath || !refPath) {
    console.error('Usage: bun judge.mts --hyp <hypotheses.jsonl> --ref <sample.json used for the run> [--llm-judge] [--out <path>]');
    process.exit(1);
  }

  const hypotheses = parseJsonl<HypothesisRow>(hypPath);
  const references = JSON.parse(readFileSync(refPath, 'utf8')) as LoCoMoSample[];

  console.log(`Scoring ${hypotheses.length} hypotheses against ${refPath} (F1/token-overlap, matches upstream LoCoMo scoring)...`);
  const f1Report = scoreRun(hypotheses, references);
  printMetricsReport(f1Report);

  const out: { f1: MetricsReport; llm_judge?: MetricsReport } = { f1: f1Report };

  if (useLlmJudge) {
    console.log(`\nRunning Azure LLM-judge pass on categories 1-4 (deployment "${resolveAzureConfig().answererDeployment}")...`);
    const llmReport = await runLlmJudge(hypotheses, references);
    console.log('\nLLM-judge results (semantic correctness, categories 1-4 only):');
    printMetricsReport(llmReport);
    out.llm_judge = llmReport;
  }

  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nMetrics -> ${outPath}`);
}
