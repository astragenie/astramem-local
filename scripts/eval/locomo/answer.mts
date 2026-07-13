/**
 * Question driver -- for every sampled conversation, POST /recall
 * (project-scoped to that conversation) for each of its QA pairs, then a
 * fixed cheap Azure model (gpt-5-mini, reasoning_effort=minimal) turns the
 * retrieved memories into an answer. Same "fixed cheap answerer" rationale
 * as ../longmemeval/answer.mts: this measures the MEMORY system, not the
 * LLM's world knowledge.
 *
 * No `as_of` filtering here (unlike LongMemEval's temporal-reasoning /
 * knowledge-update question types): LoCoMo's temporal category (2) asks
 * about date relationships WITHIN the retrieved conversation content
 * itself (e.g. "how long ago was X"), not "what did the memory system know
 * as of date Y" -- there is no natural per-question `as_of` anchor in the
 * LoCoMo schema the way LongMemEval's `question_date` provides one. The
 * answerer is asked to reason over dates present in the retrieved notes
 * directly.
 *
 * The prompt asks for terse answers and a specific abstention phrase
 * ("no information available") matching the exact substrings the upstream
 * scoring script (and judge/metrics.ts, which reimplements it) checks for
 * on adversarial (category 5) questions -- see judge/metrics.ts's header.
 *
 * CLI: bun scripts/eval/locomo/answer.mts --sample <sample.json>
 *        --daemon-url <url> --token <token> [--k 10] [--out hypotheses.jsonl]
 *        [--ready <distill-wait-result.json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { LoCoMoSample, HypothesisRecord, LoCoMoCategory } from './lib/types.js';
import { qaId } from './lib/types.js';
import { recall, type DaemonClientOpts, type SearchHit } from '../shared/daemon-client.js';
import { projectIdFor } from './lib/envelope.js';
import { azureChatComplete } from '../shared/azure-client.js';
import { resolveAzureConfig, type AzureConfig } from '../shared/config.js';

const ANSWER_MAX_COMPLETION_TOKENS = 150;

function buildAnswerPrompt(question: string, hits: SearchHit[]): string {
  const notes = hits.length > 0
    ? hits.map((h, i) => `${i + 1}. ${h.text}`).join('\n')
    : '(no memories were retrieved for this question)';
  return [
    'You are answering a question using ONLY the memory notes below, taken from a personal memory assistant.',
    'Answer as briefly as possible -- a short phrase, not a sentence, unless the question truly needs more.',
    'If the notes do not contain enough information to answer, or the question presupposes something not supported by the notes, respond with exactly: "no information available" -- do not guess.',
    '',
    'Memory notes:',
    notes,
    '',
    `Question: ${question}`,
  ].join('\n');
}

export interface AnswerOutcome {
  qa_id: string;
  sample_id: string;
  category: LoCoMoCategory;
  hypothesis: string;
  hit_count: number;
}

export async function answerConversations(
  daemonClient: DaemonClientOpts,
  azureCfg: AzureConfig,
  samples: LoCoMoSample[],
  opts: { k?: number; readySampleIds?: Set<string> } = {},
): Promise<AnswerOutcome[]> {
  const k = opts.k ?? 10;
  const outcomes: AnswerOutcome[] = [];

  for (const sample of samples) {
    const notReady = opts.readySampleIds !== undefined && !opts.readySampleIds.has(sample.sample_id);
    for (let i = 0; i < sample.qa.length; i++) {
      const qa = sample.qa[i]!;
      const id = qaId(sample.sample_id, i);
      if (notReady) {
        outcomes.push({ qa_id: id, sample_id: sample.sample_id, category: qa.category, hypothesis: '(skipped: conversation did not finish distilling within timeout)', hit_count: 0 });
        continue;
      }
      const hits = await recall(daemonClient, { text: qa.question, limit: k, filters: { project: projectIdFor(sample.sample_id) } });
      const prompt = buildAnswerPrompt(qa.question, hits);
      const hypothesis = await azureChatComplete(azureCfg, {
        deployment: azureCfg.answererDeployment,
        messages: [{ role: 'user', content: prompt }],
        maxCompletionTokens: ANSWER_MAX_COMPLETION_TOKENS,
        reasoningEffort: 'minimal',
      });
      outcomes.push({ qa_id: id, sample_id: sample.sample_id, category: qa.category, hypothesis: hypothesis.trim(), hit_count: hits.length });
    }
  }

  assertStoreNotEmpty(outcomes);
  return outcomes;
}

/** Thrown when every answered question retrieved ZERO memories — a broken run, not a result. */
export class EmptyStoreError extends Error {
  constructor(answered: number) {
    super(
      `LoCoMo run is INVALID: all ${answered} answered questions retrieved ZERO memories — the store is empty.\n\n` +
        `This is not a score. It is a broken run, and it would look like a catastrophic regression.\n\n` +
        `On 2026-07-13 exactly this happened: the daemon's embed preflight timed out (Ollama was\n` +
        `saturated), it never left 'degraded', nothing was ingested, and the harness went on to write\n` +
        `199 hypotheses against an empty database. Those would have scored ~22 token-F1 — which is\n` +
        `NOT a low score, it is the ABSTAIN FLOOR: LoCoMo category 5 (adversarial) is ~22.5% of\n` +
        `questions and its correct answer is "no information available", so a system with NO MEMORY\n` +
        `AT ALL scores ~22.5 by abstaining on everything. A garbage run and a total regression are\n` +
        `indistinguishable by score alone. Hence this guard.\n\n` +
        `Check: did ingest+distill actually finish? Is /health 'ok' (not 'degraded')? Is Ollama\n` +
        `responsive (an embed should take <1s, not 48s)?`,
    );
    this.name = 'EmptyStoreError';
  }
}

/**
 * Refuse to emit a score from an empty store (2026-07-13 incident).
 *
 * NOTE ON BENCHMARK INTEGRITY: this does NOT touch `buildAnswerPrompt`, the
 * answerer model, or k. The fixed cheap answerer is unchanged — this only
 * refuses to report a number that measures nothing. It makes the benchmark more
 * honest, not easier.
 *
 * Only counts questions that were actually ANSWERED — conversations skipped for
 * a distill timeout legitimately have 0 hits and are excluded, so a partial
 * distill failure still surfaces as its own (separate) signal rather than
 * tripping this.
 */
export function assertStoreNotEmpty(outcomes: AnswerOutcome[]): void {
  const answered = outcomes.filter(o => !o.hypothesis.startsWith('(skipped:'));
  if (answered.length === 0) return; // nothing was answered at all — a different failure
  const totalHits = answered.reduce((n, o) => n + o.hit_count, 0);
  if (totalHits === 0) throw new EmptyStoreError(answered.length);
}

export function writeHypothesesJsonl(outcomes: AnswerOutcome[], path: string): void {
  const lines = outcomes.map((o): HypothesisRecord => ({ qa_id: o.qa_id, sample_id: o.sample_id, category: o.category, hypothesis: o.hypothesis }));
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

  const samples = JSON.parse(readFileSync(samplePath, 'utf8')) as LoCoMoSample[];
  let readySampleIds: Set<string> | undefined;
  if (readyPath) {
    const ready = JSON.parse(readFileSync(readyPath, 'utf8')) as { ready_sample_ids: string[] };
    readySampleIds = new Set(ready.ready_sample_ids);
  }

  const azureCfg = resolveAzureConfig();
  const totalQa = samples.reduce((n, s) => n + s.qa.length, 0);
  console.log(`Answering ${totalQa} QA pairs across ${samples.length} conversations via Azure deployment "${azureCfg.answererDeployment}" (k=${k})...`);

  const outcomes = await answerConversations({ baseUrl: daemonUrl, token }, azureCfg, samples, { k, readySampleIds });
  writeHypothesesJsonl(outcomes, outPath);

  const abstained = outcomes.filter(o => o.hypothesis.startsWith('(skipped')).length;
  console.log(`Wrote ${outcomes.length} hypotheses -> ${outPath} (${abstained} skipped due to distill timeout, avg hit_count=${(outcomes.reduce((n, o) => n + o.hit_count, 0) / outcomes.length).toFixed(1)})`);
}
