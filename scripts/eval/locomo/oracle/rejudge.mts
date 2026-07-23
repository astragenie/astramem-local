/**
 * rejudge.mts — re-score EXISTING cached hypotheses with a gpt-5.4
 * chain-of-thought judge, matching Zep's published judge half (Zep uses
 * reader = gpt-5.4 medium + judge = gpt-5.4 CoT). No re-answering: reads a
 * cell's `*.hypotheses.jsonl` + the run's `sample.json` and only re-runs the
 * grading step. Purpose: isolate whether the ~0.53 oracle ceiling is a JUDGE
 * artifact — the current judge is gpt-5-mini with a one-word yes/no prompt
 * (`judge.mts`'s runLlmJudge), which marks verbose-but-correct and
 * date-paraphrased answers wrong.
 *
 * Same per-category accuracy math as runLlmJudge (category-averaged + overall,
 * cat5 excluded) so the number is directly comparable to the factorial table.
 * The ONLY differences vs runLlmJudge: deployment (gpt-5.4 not gpt-5-mini),
 * effort (medium not minimal), and an explicit reason-then-VERDICT prompt.
 *
 * Usage:
 *   bun scripts/eval/locomo/oracle/rejudge.mts \
 *     --ref <run-dir>/sample.json \
 *     --hyp <run-dir>/cell-<src>-<ans>.hypotheses.jsonl [--hyp ...]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveAzureConfig } from '../../shared/config.js';
import { azureChatComplete } from '../../shared/azure-client.js';
import { LOCOMO_CATEGORIES, CATEGORY_NAMES, type LoCoMoCategory, type LoCoMoSample } from '../lib/types.js';

const JUDGE_DEPLOYMENT = process.env.ASTRA_LOCOMO_REJUDGE_DEPLOYMENT ?? 'gpt-5.4';
const JUDGE_MAX_COMPLETION_TOKENS = 2000; // room for a CoT trace + the final VERDICT line
const JUDGE_EFFORT = ((): 'minimal' | 'low' | 'medium' | 'high' =>
  (['minimal', 'low', 'medium', 'high'] as const).find(e => e === process.env.ASTRA_LOCOMO_REJUDGE_EFFORT) ?? 'medium')();
const CONCURRENCY = 8;

interface HypRow { qa_id: string; sample_id: string; category: LoCoMoCategory; hypothesis: string }

function parseJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
}

/** Chain-of-thought grader: reason about equivalence, then a parseable verdict.
 *  Judge MEANING generously (paraphrase, verbosity, resolved dates like
 *  "next month (June 2023)" == "June 2023", equivalent phrasings) but hold the
 *  line on genuine factual disagreement. */
function buildCoTJudgePrompt(question: string, referenceAnswer: string, hypothesis: string): string {
  return [
    'You are grading whether a CANDIDATE answer is correct for a question, given the REFERENCE (correct) answer.',
    'Think step by step: identify the fact the reference asserts, then decide whether the candidate asserts the SAME fact.',
    'Rules:',
    '- Judge MEANING, not wording. Paraphrase, extra verbosity, or terseness is fine if the fact matches.',
    '- A candidate that resolves a relative expression to the right absolute value is CORRECT (e.g. "next month (June 2023)" for "June 2023"; "the week before 9 June 2023" for that same date).',
    '- Partial answers that contain the correct core fact are CORRECT.',
    '- Only mark "no" for a genuine factual mismatch, a missing answer, or an explicit "no information available".',
    'After reasoning, end your response with a final line in EXACTLY this form:',
    'VERDICT: yes    (or)    VERDICT: no',
    '',
    `Question: ${question}`,
    `Reference answer: ${referenceAnswer}`,
    `Candidate answer: ${hypothesis}`,
  ].join('\n');
}

function parseVerdict(out: string): boolean {
  const m = out.match(/VERDICT:\s*(yes|no)/gi);
  if (m && m.length > 0) return /yes/i.test(m[m.length - 1]!); // last VERDICT line wins
  // fallback: last standalone yes/no token
  const t = out.trim().toLowerCase();
  return t.endsWith('yes') || /\byes\b(?!.*\bno\b)/.test(t);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; results[i] = await worker(items[i]!, i); }
  }));
  return results;
}

async function judgeCell(hypPath: string, refs: LoCoMoSample[]) {
  const azureCfg = resolveAzureConfig();
  const byQaId = new Map<string, { question: string; answer: string | number | undefined }>();
  for (const s of refs) s.qa.forEach((qa, i) => byQaId.set(`${s.sample_id}#${i}`, { question: qa.question, answer: qa.answer }));

  const hyps = parseJsonl<HypRow>(hypPath).filter(h => h.category !== 5 && !h.hypothesis.startsWith('(skipped') && !h.hypothesis.startsWith('(answer failed'));
  let failures = 0;
  const graded = await mapWithConcurrency(hyps, CONCURRENCY, async (h): Promise<{ cat: LoCoMoCategory; score: number } | null> => {
    const ref = byQaId.get(h.qa_id);
    if (!ref || ref.answer === undefined) return null;
    try {
      const out = await azureChatComplete(azureCfg, {
        deployment: JUDGE_DEPLOYMENT,
        messages: [{ role: 'user', content: buildCoTJudgePrompt(ref.question, String(ref.answer), h.hypothesis) }],
        maxCompletionTokens: JUDGE_MAX_COMPLETION_TOKENS,
        reasoningEffort: JUDGE_EFFORT,
      });
      return { cat: h.category, score: parseVerdict(out) ? 1 : 0 };
    } catch (err) {
      failures++;
      console.error(`  [warn] judge failed q=${h.qa_id}: ${err instanceof Error ? err.message : String(err)}`);
      return { cat: h.category, score: 0 };
    }
  });

  const byCat = new Map<LoCoMoCategory, number[]>();
  for (const c of LOCOMO_CATEGORIES) byCat.set(c, []);
  for (const g of graded) if (g) byCat.get(g.cat)!.push(g.score);

  const catAccs: number[] = [];
  const per: Record<number, { acc: number; n: number }> = {};
  let all: number[] = [];
  for (const c of LOCOMO_CATEGORIES) {
    const s = byCat.get(c)!;
    if (c === 5) continue;
    const acc = s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
    per[c] = { acc, n: s.length };
    if (s.length) catAccs.push(acc);
    all = all.concat(s);
  }
  return {
    catAvg: catAccs.length ? catAccs.reduce((a, b) => a + b, 0) / catAccs.length : NaN,
    overall: all.length ? all.reduce((a, b) => a + b, 0) / all.length : NaN,
    per, failures, n: all.length,
  };
}

const isMain = (() => { try { return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; } })();

if (isMain) {
  const args = process.argv.slice(2);
  const getAll = (flag: string): string[] => { const o: string[] = []; for (let i = 0; i < args.length; i++) if (args[i] === flag && i + 1 < args.length) o.push(args[i + 1]!); return o; };
  const refPath = getAll('--ref')[0];
  const hypPaths = getAll('--hyp');
  if (!refPath || hypPaths.length === 0) {
    console.error('Usage: bun rejudge.mts --ref <sample.json> --hyp <cell.hypotheses.jsonl> [--hyp ...]');
    process.exit(1);
  }
  const refs = JSON.parse(readFileSync(refPath, 'utf8')) as LoCoMoSample[];
  console.log(`gpt-5.4 CoT re-judge (deployment=${JUDGE_DEPLOYMENT}, effort=${JUDGE_EFFORT}). cat5 excluded, category-averaged.\n`);
  for (const hp of hypPaths) {
    const cell = hp.split(/[\\/]/).pop();
    console.log(`=== ${cell} ===`);
    const r = await judgeCell(hp, refs);
    const catStr = LOCOMO_CATEGORIES.filter(c => c !== 5).map(c => `${CATEGORY_NAMES[c]}=${Number.isNaN(r.per[c]!.acc) ? 'n/a' : r.per[c]!.acc.toFixed(3)}(${r.per[c]!.n})`).join(' ');
    console.log(`  CoT-judge cat-avg=${r.catAvg.toFixed(4)}  overall=${r.overall.toFixed(4)}  n=${r.n}${r.failures ? `  [${r.failures} judge failures]` : ''}`);
    console.log(`  per-cat: ${catStr}\n`);
  }
}
