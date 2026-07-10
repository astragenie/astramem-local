/**
 * Question driver: POST /recall (project-scoped, as_of-scoped for
 * temporal-reasoning/knowledge-update per plan doc 3.3) -> build an answer
 * prompt from the retrieved memories -> fixed cheap Azure model (gpt-5-mini,
 * reasoning_effort=minimal) -> {question_id, hypothesis} JSONL.
 *
 * The answering model is intentionally fixed and cheap: this measures the
 * MEMORY system, not the LLM's world knowledge (plan doc 3.3 point 3 / risk
 * #3) — using a stronger model would let it guess plausible answers from
 * general knowledge instead of the retrieved memories, inflating scores
 * independent of retrieval quality.
 *
 * CLI: bun scripts/eval/longmemeval/answer.mts --sample <sample.json>
 *        --daemon-url <url> --token <token> [--k 10] [--out hypotheses.jsonl]
 *        [--ready <distill-wait-result.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { LongMemEvalQuestion, HypothesisRecord } from './lib/types.js';
import { recall, type DaemonClientOpts, type SearchHit } from '../shared/daemon-client.js';
import { projectIdFor } from './lib/envelope.js';
import { parseLongMemEvalDate } from './lib/dates.js';
import { azureChatComplete } from '../shared/azure-client.js';
import { resolveAzureConfig, type AzureConfig } from '../shared/config.js';

const AS_OF_TYPES = new Set(['temporal-reasoning', 'knowledge-update']);

const ANSWER_MAX_COMPLETION_TOKENS = 300;

function buildAnswerPrompt(question: LongMemEvalQuestion, hits: SearchHit[]): string {
  const notes = hits.length > 0
    ? hits.map((h, i) => `${i + 1}. ${h.text}`).join('\n')
    : '(no memories were retrieved for this question)';
  return [
    'You are answering a question using ONLY the memory notes below, taken from a personal memory assistant.',
    'If the notes do not contain enough information to answer, say plainly that you do not have that information — do not guess.',
    'Answer concisely, in a sentence or two, with no preamble.',
    '',
    'Memory notes:',
    notes,
    '',
    `Question: ${question.question}`,
  ].join('\n');
}

export interface AnswerOutcome {
  question_id: string;
  hypothesis: string;
  hit_count: number;
  used_as_of: boolean;
}

export async function answerQuestions(
  daemonClient: DaemonClientOpts,
  azureCfg: AzureConfig,
  questions: LongMemEvalQuestion[],
  opts: { k?: number; readyQuestionIds?: Set<string> } = {},
): Promise<AnswerOutcome[]> {
  const k = opts.k ?? 10;
  const outcomes: AnswerOutcome[] = [];

  for (const q of questions) {
    if (opts.readyQuestionIds && !opts.readyQuestionIds.has(q.question_id)) {
      outcomes.push({ question_id: q.question_id, hypothesis: '(skipped: haystack did not finish distilling within timeout)', hit_count: 0, used_as_of: false });
      continue;
    }
    const useAsOf = AS_OF_TYPES.has(q.question_type);
    const filters = {
      project: projectIdFor(q.question_id),
      ...(useAsOf ? { as_of: parseLongMemEvalDate(q.question_date) } : {}),
    };
    const hits = await recall(daemonClient, { text: q.question, limit: k, filters });
    const prompt = buildAnswerPrompt(q, hits);
    const hypothesis = await azureChatComplete(azureCfg, {
      deployment: azureCfg.answererDeployment,
      messages: [{ role: 'user', content: prompt }],
      maxCompletionTokens: ANSWER_MAX_COMPLETION_TOKENS,
      reasoningEffort: 'minimal',
    });
    outcomes.push({ question_id: q.question_id, hypothesis: hypothesis.trim(), hit_count: hits.length, used_as_of: useAsOf });
  }

  return outcomes;
}

export function writeHypothesesJsonl(outcomes: AnswerOutcome[], path: string): void {
  const lines = outcomes.map((o): HypothesisRecord => ({ question_id: o.question_id, hypothesis: o.hypothesis }));
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

// ── CLI entry ────────────────────────────────────────────────────────────
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
  const samplePath = get('--sample');
  const daemonUrl = get('--daemon-url');
  const token = get('--token');
  const k = Number(get('--k') ?? '10');
  const outPath = get('--out') ?? 'hypotheses.jsonl';
  const readyPath = get('--ready');

  if (!samplePath || !daemonUrl || !token) {
    console.error('Usage: bun answer.mts --sample <path> --daemon-url <url> --token <token> [--k 10] [--out hypotheses.jsonl] [--ready <distill-wait-result.json>]');
    process.exit(1);
  }

  const questions = JSON.parse(readFileSync(samplePath, 'utf8')) as LongMemEvalQuestion[];
  let readyQuestionIds: Set<string> | undefined;
  if (readyPath) {
    const ready = JSON.parse(readFileSync(readyPath, 'utf8')) as { ready_question_ids: string[] };
    readyQuestionIds = new Set(ready.ready_question_ids);
  }

  const azureCfg = resolveAzureConfig();
  console.log(`Answering ${questions.length} questions via Azure deployment "${azureCfg.answererDeployment}" (k=${k})...`);

  const outcomes = await answerQuestions({ baseUrl: daemonUrl, token }, azureCfg, questions, { k, readyQuestionIds });
  writeHypothesesJsonl(outcomes, outPath);

  const abstained = outcomes.filter(o => o.hypothesis.startsWith('(skipped')).length;
  console.log(`Wrote ${outcomes.length} hypotheses -> ${outPath} (${abstained} skipped due to distill timeout, avg hit_count=${(outcomes.reduce((n, o) => n + o.hit_count, 0) / outcomes.length).toFixed(1)})`);
}
