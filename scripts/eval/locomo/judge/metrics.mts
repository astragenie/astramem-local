/**
 * LoCoMo scorer -- reimplements the upstream benchmark's own QA scoring
 * (task_eval/evaluation.py::eval_question_answering,
 * task_eval/evaluation_stats.py::analyze_aggr_acc) in TypeScript. This is
 * "new authorship, not reuse" (FEAT-457): unlike LongMemEval
 * (../../longmemeval/judge.mts), which shells out to a vendored Azure fork
 * of the upstream Python judge script, LoCoMo's OWN upstream scoring is
 * pure F1/token-overlap + a substring check -- not an LLM judge at all.
 * Reimplementing it in TypeScript keeps the whole harness Azure-optional by
 * default (Azure is still available as a secondary signal via
 * ../judge.mts's `--llm-judge` flag, since raw token-F1 is known to
 * under-score a full-sentence LLM answer against a terse reference answer --
 * see judge.mts's header).
 *
 * Category numbering derivation (verified against the actual upstream
 * source 2026-07-10, not the paper's prose alone -- see ../lib/types.ts's
 * header for the full trail):
 *   category 1 (multi-hop):    f1() -- comma-split multi-answer F1
 *   category 2 (temporal):     f1_score() -- plain token-overlap F1
 *   category 3 (open-domain):  f1_score() against answer.split(';')[0] only
 *   category 4 (single-hop):   f1_score() -- plain token-overlap F1
 *   category 5 (adversarial):  binary -- 1 iff hypothesis contains
 *                               "no information available" or "not
 *                               mentioned" (case-insensitive), else 0
 *
 * normalize_answer's exact pipeline (order matters, mirrors upstream
 * byte-for-byte): lowercase -> strip punctuation -> strip standalone
 * articles "a"/"an"/"the"/"and" (yes, upstream's regex includes "and" as an
 * "article" here, not just a/an/the -- kept as-is for fidelity) ->
 * collapse whitespace. Tokens are then Porter-stemmed (./porter-stemmer.ts)
 * before the Counter-intersection F1 computation.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LOCOMO_CATEGORIES, CATEGORY_NAMES, isAdversarial, type LoCoMoCategory, type LoCoMoSample } from '../lib/types.js';
import { porterStem } from './porter-stemmer.js';
import { computeStats, formatStatsPct, type Stats } from '../../shared/stats.js';

const ARTICLES_RE = /\b(a|an|the|and)\b/g;
// string.punctuation (Python) -- ASCII punctuation set, used verbatim.
const PUNCTUATION_RE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

export function normalizeAnswer(raw: string): string {
  const lowered = raw.toLowerCase();
  const noPunct = lowered.replace(PUNCTUATION_RE, '');
  const noArticles = noPunct.replace(ARTICLES_RE, ' ');
  return noArticles.split(/\s+/).filter(Boolean).join(' ');
}

function stemmedTokens(s: string): string[] {
  return normalizeAnswer(s).split(' ').filter(Boolean).map(porterStem);
}

/** Plain token-overlap F1 with Porter stemming (upstream's `f1_score`). */
export function f1Score(prediction: string, groundTruth: string): number {
  const predTokens = stemmedTokens(prediction);
  const gtTokens = stemmedTokens(groundTruth);
  const predCounts = new Map<string, number>();
  for (const t of predTokens) predCounts.set(t, (predCounts.get(t) ?? 0) + 1);
  let numSame = 0;
  const gtCounts = new Map<string, number>();
  for (const t of gtTokens) gtCounts.set(t, (gtCounts.get(t) ?? 0) + 1);
  for (const [tok, gtCount] of gtCounts) {
    numSame += Math.min(gtCount, predCounts.get(tok) ?? 0);
  }
  if (numSame === 0 || predTokens.length === 0 || gtTokens.length === 0) return 0;
  const precision = numSame / predTokens.length;
  const recall = numSame / gtTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

/** Comma-split multi-answer F1 (upstream's `f1`, used only for category 1 --
 *  multi-hop questions whose ground-truth answer may list several parts). */
export function multiAnswerF1(prediction: string, groundTruth: string): number {
  const predictions = prediction.split(',').map(p => p.trim()).filter(Boolean);
  const groundTruths = groundTruth.split(',').map(g => g.trim()).filter(Boolean);
  if (predictions.length === 0 || groundTruths.length === 0) return 0;
  const perGt = groundTruths.map(gt => Math.max(...predictions.map(p => f1Score(p, gt))));
  return perGt.reduce((a, b) => a + b, 0) / perGt.length;
}

const ADVERSARIAL_ABSTAIN_PHRASES = ['no information available', 'not mentioned'];

export function isAbstentionPhrase(hypothesis: string): boolean {
  const lower = hypothesis.toLowerCase();
  return ADVERSARIAL_ABSTAIN_PHRASES.some(p => lower.includes(p));
}

export interface ScoredQa {
  qa_id: string;
  category: LoCoMoCategory;
  score: number;
}

/** Scores one QA pair's hypothesis against its ground truth, per the
 *  category dispatch table in this file's header. `answer`/`adversarialAnswer`
 *  come from the reference sample file (see judge.mts). */
export function scoreHypothesis(
  category: LoCoMoCategory,
  hypothesis: string,
  answer: string | number | undefined,
): number {
  if (isAdversarial(category)) {
    return isAbstentionPhrase(hypothesis) ? 1 : 0;
  }
  if (answer === undefined) {
    throw new Error(`category ${category} QA is missing its reference answer`);
  }
  let answerStr = String(answer);
  if (category === 3) answerStr = (answerStr.split(';')[0] ?? '').trim();
  return category === 1 ? multiAnswerF1(hypothesis, answerStr) : f1Score(hypothesis, answerStr);
}

export interface MetricsReport {
  per_category: Record<LoCoMoCategory, { accuracy: number; n: number; name: string }>;
  category_averaged_accuracy: number;
  overall_accuracy: number;
  n_total: number;
}

export function computeMetrics(scored: ScoredQa[]): MetricsReport {
  const byCategory = new Map<LoCoMoCategory, number[]>();
  for (const c of LOCOMO_CATEGORIES) byCategory.set(c, []);
  for (const s of scored) byCategory.get(s.category)!.push(s.score);

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

export function printMetricsReport(report: MetricsReport): void {
  console.log('\nLoCoMo results by category:');
  for (const c of LOCOMO_CATEGORIES) {
    const { accuracy, n, name } = report.per_category[c];
    console.log(`\t${c} (${name}): ${Number.isNaN(accuracy) ? 'n/a' : accuracy.toFixed(4)} (${n})`);
  }
  console.log(`\nCategory-averaged accuracy: ${Number.isNaN(report.category_averaged_accuracy) ? 'n/a' : report.category_averaged_accuracy.toFixed(4)}`);
  console.log(`Overall accuracy (F1/token-overlap, category 5 binary): ${Number.isNaN(report.overall_accuracy) ? 'n/a' : report.overall_accuracy.toFixed(4)} (n=${report.n_total})`);
}

// ── multi-run aggregation (FEAT-457 slice 1, AC-4) ─────────────────────────
//
// judge.mts scores exactly one run's hypotheses against one reference sample
// file. When the SAME harness invocation (same dataset/seed/config) is
// repeated N times -- each producing its own run dir with its own
// hypotheses.jsonl -- per-run point accuracy alone hides how much of the
// spread is run-to-run noise vs a real difference. combineMetricsReports
// aggregates N single-run MetricsReports into mean+-stdev per category and
// overall, reusing ../../shared/stats.ts's computeStats/formatStatsPct (the
// same math extraction-bench's --runs N uses, FEAT-450) rather than a new
// bespoke aggregator.

export interface CategoryStats {
  name: string;
  /** mean/stdev across per-run accuracy for this one category. */
  accuracy: Stats;
}

/**
 * A MetricsReport augmented with mean+-stdev across N>=2 repeated runs.
 * `per_category`/`category_averaged_accuracy`/`overall_accuracy` remain
 * plain numbers (the mean-of-per-run values), so any existing code reading
 * them as a single-run report keeps working unchanged; `runs`,
 * `category_stats`, `category_averaged_accuracy_stats`, and
 * `overall_accuracy_stats` are the additive fields, present only when
 * combineMetricsReports actually combined more than one report.
 */
export interface MultiRunMetricsReport extends MetricsReport {
  runs?: MetricsReport[];
  category_stats?: Record<LoCoMoCategory, CategoryStats>;
  category_averaged_accuracy_stats?: Stats;
  overall_accuracy_stats?: Stats;
}

/**
 * Combine N per-run MetricsReports (N repeated end-to-end runs of the same
 * harness invocation) into one report carrying mean+-stdev per category and
 * overall. Mirrors extraction-bench/lib/report.ts's combineRuns: with
 * exactly one report, returns it completely unchanged -- no `runs`/`*_stats`
 * keys at all -- so single-run output/shape is untouched (backward compat).
 */
export function combineMetricsReports(reports: MetricsReport[]): MultiRunMetricsReport {
  if (reports.length === 0) throw new Error('combineMetricsReports requires at least one run');
  if (reports.length === 1) return reports[0] as MultiRunMetricsReport;

  const perCategory = {} as MetricsReport['per_category'];
  const categoryStats = {} as Record<LoCoMoCategory, CategoryStats>;
  for (const c of LOCOMO_CATEGORIES) {
    const stats = computeStats(reports.map(r => r.per_category[c].accuracy));
    const n = reports.reduce((sum, r) => sum + r.per_category[c].n, 0);
    perCategory[c] = { accuracy: stats.mean ?? NaN, n, name: CATEGORY_NAMES[c] };
    categoryStats[c] = { name: CATEGORY_NAMES[c], accuracy: stats };
  }

  const categoryAveragedStats = computeStats(reports.map(r => r.category_averaged_accuracy));
  const overallStats = computeStats(reports.map(r => r.overall_accuracy));

  return {
    per_category: perCategory,
    category_averaged_accuracy: categoryAveragedStats.mean ?? NaN,
    overall_accuracy: overallStats.mean ?? NaN,
    n_total: reports.reduce((sum, r) => sum + r.n_total, 0),
    runs: reports,
    category_stats: categoryStats,
    category_averaged_accuracy_stats: categoryAveragedStats,
    overall_accuracy_stats: overallStats,
  };
}

/**
 * Prints a MultiRunMetricsReport. For a single-run report (no `runs`/
 * `category_stats`) this delegates straight to printMetricsReport, so output
 * is byte-for-byte identical to the pre-AC-4 single-run path.
 */
export function printMultiRunReport(report: MultiRunMetricsReport): void {
  if (!report.runs || !report.category_stats) {
    printMetricsReport(report);
    return;
  }
  const totalRuns = report.runs.length;
  console.log(`\nLoCoMo results by category (n=${totalRuns} runs, mean ± stdev):`);
  for (const c of LOCOMO_CATEGORIES) {
    const { name, accuracy } = report.category_stats[c];
    const n = report.per_category[c].n;
    // Review fix (observability nit): accuracy.n is the count of runs that
    // actually had >=1 QA in this category, not the pooled QA count -- flag
    // it when a category was missing from some run(s), e.g. a distill
    // timeout that emptied one run's worth of a category's QA pairs.
    const contributingRuns = accuracy.n;
    const runsNote = contributingRuns !== totalRuns ? `, ${contributingRuns}/${totalRuns} runs` : '';
    console.log(`\t${c} (${name}): ${formatStatsPct(accuracy)} (n=${n}${runsNote})`);
  }
  console.log(`\nCategory-averaged accuracy: ${formatStatsPct(report.category_averaged_accuracy_stats)}`);
  console.log(`Overall accuracy (F1/token-overlap, category 5 binary): ${formatStatsPct(report.overall_accuracy_stats)} (n=${report.n_total})`);
}

// ── CLI entry ────────────────────────────────────────────────────────────
interface HypothesisRow {
  qa_id: string;
  sample_id: string;
  category: LoCoMoCategory;
  hypothesis: string;
}

function parseJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}

export function scoreRun(hypotheses: HypothesisRow[], references: LoCoMoSample[]): MetricsReport {
  const answerByQaId = new Map<string, string | number | undefined>();
  for (const sample of references) {
    sample.qa.forEach((qa, i) => answerByQaId.set(`${sample.sample_id}#${i}`, qa.answer));
  }
  const scored: ScoredQa[] = [];
  for (const h of hypotheses) {
    if (h.hypothesis.startsWith('(skipped')) continue; // distill timeout -- excluded from scoring, not scored as wrong
    if (!answerByQaId.has(h.qa_id)) {
      console.warn(`Warning: ${h.qa_id} not found in reference data — skipping.`);
      continue;
    }
    const score = scoreHypothesis(h.category, h.hypothesis, answerByQaId.get(h.qa_id));
    scored.push({ qa_id: h.qa_id, category: h.category, score });
  }
  return computeMetrics(scored);
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
  const hypPath = get('--hyp');
  const refPath = get('--ref');
  if (!hypPath || !refPath) {
    console.error('Usage: bun metrics.mts --hyp <hypotheses.jsonl> --ref <sample.json used for the run>');
    process.exit(1);
  }
  const hypotheses = parseJsonl<HypothesisRow>(hypPath);
  const references = JSON.parse(readFileSync(refPath, 'utf8')) as LoCoMoSample[];
  printMetricsReport(scoreRun(hypotheses, references));
}
