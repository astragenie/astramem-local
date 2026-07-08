/**
 * Metrics aggregator — reimplements the official LongMemEval
 * `print_qa_metrics.py`'s grouping logic (per-type accuracy, task-averaged
 * accuracy, overall accuracy, abstention accuracy) in TypeScript.
 *
 * WHY not just shell out to the official print_qa_metrics.py: that script
 * has a hard `assert entry['autoeval_label']['model'] == 'gpt-4o-2024-08-06'`
 * (verified against the upstream source 2026-07-08) — it aborts immediately
 * on ANY judge whose recorded model string isn't that exact OpenAI snapshot
 * id. Our Azure judge calls record whatever `model_zoo` short name was used
 * (e.g. 'gpt-5-mini' for the smoke judge, or 'gpt-4o' for the Azure gpt-4o
 * deployment, which is snapshot 2024-11-20 — NOT 2024-08-06). Forging the
 * literal OpenAI string to satisfy the assert would misrepresent which
 * model actually judged the run, so this aggregator works from
 * `autoeval_label.label` alone and never checks the model string.
 *
 * Reads the `.eval-results-<judge>` file evaluate_qa_azure.py writes (one
 * JSON object per line, each with `autoeval_label: {model, label}`) plus
 * the original reference file (for question_type lookup), same two-file
 * contract as the official script.
 *
 * bun scripts/eval/longmemeval/judge/metrics.mts --results <hyp>.eval-results-<judge> --ref <dataset.json>
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { QUESTION_TYPES, isAbstention, type LongMemEvalQuestion, type QuestionType } from '../lib/types.js';

export interface JudgedEntry {
  question_id: string;
  hypothesis: string;
  autoeval_label: { model: string; label: boolean };
}

export interface MetricsReport {
  per_type: Record<QuestionType, { accuracy: number; n: number }>;
  task_averaged_accuracy: number;
  overall_accuracy: number;
  abstention_accuracy: number | null;
  abstention_n: number;
  judge_models_seen: string[];
}

export function computeMetrics(judged: JudgedEntry[], references: LongMemEvalQuestion[]): MetricsReport {
  const refById = new Map(references.map(r => [r.question_id, r]));
  const perType = new Map<QuestionType, boolean[]>();
  for (const t of QUESTION_TYPES) perType.set(t, []);
  const abstention: boolean[] = [];
  const judgeModels = new Set<string>();

  for (const entry of judged) {
    const ref = refById.get(entry.question_id);
    if (!ref) {
      console.warn(`Warning: ${entry.question_id} not found in reference data — skipping.`);
      continue;
    }
    judgeModels.add(entry.autoeval_label.model);
    perType.get(ref.question_type)!.push(entry.autoeval_label.label);
    if (isAbstention(entry)) abstention.push(entry.autoeval_label.label);
  }

  const mean = (xs: boolean[]): number => (xs.length === 0 ? NaN : xs.filter(Boolean).length / xs.length);

  const perTypeOut: MetricsReport['per_type'] = {} as MetricsReport['per_type'];
  const taskAccuracies: number[] = [];
  const allLabels: boolean[] = [];
  for (const t of QUESTION_TYPES) {
    const labels = perType.get(t)!;
    perTypeOut[t] = { accuracy: mean(labels), n: labels.length };
    if (labels.length > 0) taskAccuracies.push(mean(labels));
    allLabels.push(...labels);
  }

  return {
    per_type: perTypeOut,
    task_averaged_accuracy: taskAccuracies.length > 0 ? taskAccuracies.reduce((a, b) => a + b, 0) / taskAccuracies.length : NaN,
    overall_accuracy: mean(allLabels),
    abstention_accuracy: abstention.length > 0 ? mean(abstention) : null,
    abstention_n: abstention.length,
    judge_models_seen: [...judgeModels],
  };
}

export function printMetricsReport(report: MetricsReport): void {
  console.log('\nEvaluation results by task:');
  for (const t of QUESTION_TYPES) {
    const { accuracy, n } = report.per_type[t];
    console.log(`\t${t}: ${Number.isNaN(accuracy) ? 'n/a' : accuracy.toFixed(4)} (${n})`);
  }
  console.log(`\nTask-averaged Accuracy: ${report.task_averaged_accuracy.toFixed(4)}`);
  console.log(`Overall Accuracy: ${report.overall_accuracy.toFixed(4)}`);
  console.log(`Abstention Accuracy: ${report.abstention_accuracy === null ? 'n/a' : report.abstention_accuracy.toFixed(4)} (${report.abstention_n})`);
  console.log(`Judge model(s): ${report.judge_models_seen.join(', ')}`);
}

function parseJsonlOrJson<T>(path: string): T[] {
  const raw = readFileSync(path, 'utf8').trim();
  try {
    return raw.split('\n').map(line => JSON.parse(line) as T);
  } catch {
    return JSON.parse(raw) as T[];
  }
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
  const resultsPath = get('--results');
  const refPath = get('--ref');
  if (!resultsPath || !refPath) {
    console.error('Usage: bun metrics.mts --results <hyp>.eval-results-<judge> --ref <dataset.json>');
    process.exit(1);
  }
  const judged = parseJsonlOrJson<JudgedEntry>(resultsPath);
  const references = JSON.parse(readFileSync(refPath, 'utf8')) as LongMemEvalQuestion[];
  printMetricsReport(computeMetrics(judged, references));
}
