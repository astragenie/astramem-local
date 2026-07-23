/**
 * mem0-judge.mts — re-score EXISTING cached hypotheses under Mem0's (or
 * Zep's) own published LLM-judge rubric, VERBATIM, isolating "judge
 * methodology" from "memory quality". No re-answering: reads a cell's
 * `*.hypotheses.jsonl` + the run's `sample.json` (same layout every LoCoMo
 * harness in this repo writes) and only re-runs the grading step — same
 * shape as `rejudge.mts`, different rubric source.
 *
 * SOURCE OF TRUTH for both prompts below:
 * `docs/research/20260723-mem0-zep-locomo-harness-extraction.md` (Mem0
 * §A2/A3, Zep §B3). Read that doc before touching the rubric text — the
 * leniency wording IS the experiment; do not paraphrase it.
 *
 * JUDGE-ONLY SWAP: same cached answers, different grading rubric. The other
 * lever the doc calls out — Mem0's answer-generation prompt capping replies
 * at "less than 5-6 words" — is a SEPARATE, not-yet-built arm. This script
 * does not touch answer generation at all.
 *
 * JUDGE MODEL: both Mem0's and Zep's own harnesses use `gpt-4o-mini`
 * (doc §A2, §B3). gpt-4o-mini is NOT deployed on this Azure resource (only
 * gpt-4o, gpt-5-mini, text-embedding-3-small — see `answerers/strong.mts`'s
 * header for the same substitution). This script uses **gpt-4o** instead —
 * the closest deployed sibling. Any score this produces is "Mem0/Zep's
 * rubric under a stronger judge model", not a byte-identical reproduction of
 * either vendor's published number.
 *
 * gpt-4o is not a reasoning model — no `reasoning_effort`, and (unlike every
 * other judge in this repo) it DOES accept `temperature`, which the upstream
 * harnesses pin to `0.0` (doc §A2/§B3). `azureChatComplete` had no
 * `temperature` knob before this file needed one — added additively in
 * `../../shared/azure-client.ts` (existing reasoning-model callers omit it
 * and are unaffected).
 *
 * LABEL PARSING: Mem0's own harness forces `response_format: json_object`
 * against gpt-4o-mini and pulls `{"label": "..."}`; Zep's uses a structured
 * `Grade` pydantic model with an `is_correct` field instead. Neither shape is
 * enforceable through this repo's plain-fetch `azureChatComplete` (no
 * `response_format` support, and gpt-4o's adherence to an unenforced "return
 * JSON" instruction is not guaranteed the way gpt-4o-mini + json_object is)
 * — so `extractLabel` below parses BOTH the JSON shape and a bare
 * CORRECT/WRONG line defensively, and any response matching neither is
 * logged as a genuine parse failure (scored 0, not silently miscounted).
 *
 * METRIC: Mem0's own aggregation (`evaluation/generate_scores.py`) flattens
 * every question-level record into one DataFrame and takes the POOLED mean
 * — NOT an average of per-category averages (the two differ whenever
 * category sizes are unequal, which they are in LoCoMo). `pooled` below is
 * that number — Mem0's actual "J". Per-category accuracy is also reported,
 * for diagnostics only.
 *
 * Per Mem0 (§A3) and Zep (§B2/§B3) alike: category 5 (adversarial) is
 * excluded — no gold `answer` field exists for it, only a distractor
 * `adversarial_answer`, and the correct behavior there is abstention, which
 * this binary CORRECT/WRONG rubric cannot score the same way.
 *
 * Usage:
 *   bun scripts/eval/locomo/oracle/mem0-judge.mts \
 *     --ref <run-dir>/sample.json \
 *     --hyp <run-dir>/cell-<src>-<ans>.hypotheses.jsonl [--hyp ...] \
 *     [--rubric mem0|zep]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveAzureConfig } from '../../shared/config.js';
import { azureChatComplete, type ChatMessage } from '../../shared/azure-client.js';
import { mapWithConcurrency } from '../../shared/concurrency.js';
import { LOCOMO_CATEGORIES, CATEGORY_NAMES, type LoCoMoCategory, type LoCoMoSample } from '../lib/types.js';

type Rubric = 'mem0' | 'zep';

const JUDGE_DEPLOYMENT = process.env.ASTRA_LOCOMO_MEM0_JUDGE_DEPLOYMENT ?? 'gpt-4o';
// One-sentence reasoning + a CORRECT/WRONG label (or a small JSON object) —
// gpt-4o is not a reasoning model, so this budget is pure visible output,
// unlike the reasoning-model judges elsewhere in this dir.
const JUDGE_MAX_COMPLETION_TOKENS = 300;
const CONCURRENCY = 8;

interface HypRow { qa_id: string; sample_id: string; category: LoCoMoCategory; hypothesis: string }

function parseJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
}

/**
 * Mem0 `ACCURACY_PROMPT`, VERBATIM from `evaluation/metrics/llm_judge.py` @
 * commit `aae5989e78` (extraction doc §A2). A single user-turn message, no
 * system prompt — matches Mem0's own `client.chat.completions.create` call
 * shape exactly. Only the `{question}`/`{gold_answer}`/`{generated_answer}`
 * Python `.format()` placeholders become `${}` template substitutions; the
 * surrounding rubric text (including the curly quotes) is untouched.
 */
function mem0AccuracyPrompt(question: string, goldAnswer: string, generatedAnswer: string): string {
  return `
Your task is to label an answer to a question as ’CORRECT’ or ’WRONG’. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a ’gold’ (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: ${question}
Gold answer: ${goldAnswer}
Generated answer: ${generatedAnswer}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Just return the label CORRECT or WRONG in a json format with the key as "label".
`;
}

/**
 * Zep `GRADER_SYSTEM_PROMPT` + `GRADER_PROMPT`, VERBATIM from the current
 * open-sourced `getzep/zep` `benchmarks/locomo/prompts.py` (extraction doc
 * §B3) — near-identical body to Mem0's (same Hawaii/shell-necklace example,
 * same date-format leniency clause), wrapped with a system message instead
 * of folded into the one user turn, and without Mem0's trailing
 * "return...json format" instruction (Zep's own harness gets structured
 * output via a pydantic model this plain-fetch client can't enforce — see
 * this file's header). `{response}` is Zep's own placeholder name for the
 * generated answer (not `{generated_answer}`).
 */
const ZEP_GRADER_SYSTEM_PROMPT = 'You are an expert grader that determines if answers to questions match a gold standard answer.';

function zepGraderPrompt(question: string, goldAnswer: string, generatedAnswer: string): string {
  return `Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a 'gold' (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: ${question}
Gold answer: ${goldAnswer}
Generated answer: ${generatedAnswer}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.`;
}

function buildMessages(rubric: Rubric, question: string, goldAnswer: string, generatedAnswer: string): ChatMessage[] {
  if (rubric === 'zep') {
    return [
      { role: 'system', content: ZEP_GRADER_SYSTEM_PROMPT },
      { role: 'user', content: zepGraderPrompt(question, goldAnswer, generatedAnswer) },
    ];
  }
  return [{ role: 'user', content: mem0AccuracyPrompt(question, goldAnswer, generatedAnswer) }];
}

/**
 * Defensively pull a CORRECT/WRONG label out of the judge's raw response —
 * see this file's header for why neither upstream's forced-output shape is
 * enforceable here. Tries, in order:
 *   1. a JSON object anywhere in the text with a "label" or "is_correct"
 *      string value of CORRECT/WRONG (Mem0's and Zep's own output shapes)
 *   2. the LAST standalone CORRECT/WRONG token in the text — both rubrics
 *      ask for a one-sentence explanation THEN the label, so the last
 *      occurrence is the verdict, not an incidental word inside the reasoning
 * Returns null (never a silent default) when neither shape is found, so the
 * caller can log a genuine parse failure instead of miscounting it as WRONG.
 */
function extractLabel(raw: string): 'CORRECT' | 'WRONG' | null {
  const jsonMatch = raw.match(/\{[^{}]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const val = obj.label ?? obj.is_correct;
      if (typeof val === 'string') {
        const upper = val.trim().toUpperCase();
        if (upper === 'CORRECT' || upper === 'WRONG') return upper;
      }
    } catch {
      // Not actually JSON (or not the label object) -- fall through to the text scan.
    }
  }
  const tokens = raw.match(/\b(CORRECT|WRONG)\b/gi);
  if (tokens && tokens.length > 0) return tokens[tokens.length - 1]!.toUpperCase() as 'CORRECT' | 'WRONG';
  return null;
}

interface JudgeCellResult {
  /** Mem0's "J" — pooled per-question mean across every judged, non-cat-5
   *  question. NOT an average of per-category averages. */
  pooled: number;
  per: Record<number, { acc: number; n: number }>;
  /** Responses that matched neither the JSON nor the bare-token label shape
   *  (logged, scored 0, never silently dropped from `n`). */
  failures: number;
  n: number;
}

async function judgeCell(hypPath: string, refs: LoCoMoSample[], rubric: Rubric): Promise<JudgeCellResult> {
  const azureCfg = resolveAzureConfig();
  const byQaId = new Map<string, { question: string; answer: string | number | undefined }>();
  for (const s of refs) s.qa.forEach((qa, i) => byQaId.set(`${s.sample_id}#${i}`, { question: qa.question, answer: qa.answer }));

  // Skip category 5 -- Mem0 (§A3) and Zep (§B2/§B3) both exclude adversarial
  // questions: no gold `answer` field exists for them (only a distractor
  // `adversarial_answer`), and the correct behavior is abstention.
  const hyps = parseJsonl<HypRow>(hypPath).filter(h => h.category !== 5 && !h.hypothesis.startsWith('(skipped') && !h.hypothesis.startsWith('(answer failed'));
  let failures = 0;
  const graded = await mapWithConcurrency(hyps, CONCURRENCY, async (h): Promise<{ cat: LoCoMoCategory; score: number } | null> => {
    const ref = byQaId.get(h.qa_id);
    if (!ref || ref.answer === undefined) return null;
    // sample.json `answer` can be a string OR a number (e.g. `2022`) -- coerce.
    const goldAnswer = String(ref.answer);
    try {
      const out = await azureChatComplete(azureCfg, {
        deployment: JUDGE_DEPLOYMENT,
        messages: buildMessages(rubric, ref.question, goldAnswer, h.hypothesis),
        maxCompletionTokens: JUDGE_MAX_COMPLETION_TOKENS,
        temperature: 0,
      });
      const label = extractLabel(out);
      if (label === null) {
        failures++;
        console.error(`  [warn] unparseable judge response q=${h.qa_id}: ${out.slice(0, 200)}`);
        return { cat: h.category, score: 0 };
      }
      return { cat: h.category, score: label === 'CORRECT' ? 1 : 0 };
    } catch (err) {
      failures++;
      console.error(`  [warn] judge failed q=${h.qa_id}: ${err instanceof Error ? err.message : String(err)}`);
      return { cat: h.category, score: 0 };
    }
  });

  const byCat = new Map<LoCoMoCategory, number[]>();
  for (const c of LOCOMO_CATEGORIES) byCat.set(c, []);
  for (const g of graded) if (g) byCat.get(g.cat)!.push(g.score);

  const per: Record<number, { acc: number; n: number }> = {};
  let all: number[] = [];
  for (const c of LOCOMO_CATEGORIES) {
    if (c === 5) continue;
    const s = byCat.get(c)!;
    const acc = s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
    per[c] = { acc, n: s.length };
    all = all.concat(s);
  }
  return {
    pooled: all.length ? all.reduce((a, b) => a + b, 0) / all.length : NaN,
    per,
    failures,
    n: all.length,
  };
}

const isMain = (() => { try { return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; } })();

if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const getAll = (flag: string): string[] => { const o: string[] = []; for (let i = 0; i < args.length; i++) if (args[i] === flag && i + 1 < args.length) o.push(args[i + 1]!); return o; };
  const refPath = getAll('--ref')[0];
  const hypPaths = getAll('--hyp');
  const rubricArg = get('--rubric');
  const rubric: Rubric = rubricArg === 'zep' ? 'zep' : 'mem0';
  if (rubricArg && rubricArg !== 'mem0' && rubricArg !== 'zep') {
    console.error(`--rubric must be "mem0" or "zep", got "${rubricArg}"`);
    process.exit(1);
  }
  if (!refPath || hypPaths.length === 0) {
    console.error('Usage: bun mem0-judge.mts --ref <sample.json> --hyp <cell.hypotheses.jsonl> [--hyp ...] [--rubric mem0|zep]');
    process.exit(1);
  }
  const refs = JSON.parse(readFileSync(refPath, 'utf8')) as LoCoMoSample[];
  console.log(`${rubric} rubric judge (deployment=${JUDGE_DEPLOYMENT}, temperature=0, gpt-4o substituted for gpt-4o-mini). cat5 excluded; pooled is Mem0's "J".\n`);
  for (const hp of hypPaths) {
    const cell = hp.split(/[\\/]/).pop();
    console.log(`=== ${cell} ===`);
    const r = await judgeCell(hp, refs, rubric);
    const catStr = LOCOMO_CATEGORIES.filter(c => c !== 5).map(c => `${CATEGORY_NAMES[c]}=${Number.isNaN(r.per[c]!.acc) ? 'n/a' : r.per[c]!.acc.toFixed(3)}(${r.per[c]!.n})`).join(' ');
    console.log(`  ${rubric} pooled J=${r.pooled.toFixed(4)}  n=${r.n}${r.failures ? `  [${r.failures} judge failures]` : ''}`);
    console.log(`  per-cat: ${catStr}\n`);
  }
}
