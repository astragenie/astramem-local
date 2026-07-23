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

// A/B knobs (v2 plan C2). Defaults reproduce prior behavior exactly. RAISE the
// token budget when raising effort — the budget is shared between hidden
// reasoning and the visible answer, so `low`+150 can truncate answers to empty
// (FEAT-450 precedent). e.g. ASTRA_LOCOMO_ANSWER_EFFORT=low ASTRA_LOCOMO_ANSWER_MAX_TOKENS=400
const ANSWER_MAX_COMPLETION_TOKENS = (() => {
  const raw = process.env.ASTRA_LOCOMO_ANSWER_MAX_TOKENS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 150;
})();
const ANSWER_REASONING_EFFORT = ((): 'minimal' | 'low' | 'medium' | 'high' => {
  const v = process.env.ASTRA_LOCOMO_ANSWER_EFFORT;
  return v === 'low' || v === 'medium' || v === 'high' ? v : 'minimal';
})();

/**
 * Local-answerer A/B (2026-07-18, additive): swap the fixed cheap Azure
 * answerer for a local Ollama model (e.g. phi4-mini) — measures whether a
 * free local answerer can hold the score the Azure one sets, on the SAME
 * stored memories (pairs with run.mts --resume for a re-answer-only pass).
 * The prompt, k, token budget, and abstention phrasing are unchanged; only
 * the completion transport differs. Omitted -> byte-identical Azure path.
 */
export interface OllamaAnswerer { model: string; baseUrl?: string }

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

/**
 * LLM rerank+abstain gate (2026-07-22, eval-only A/B, env-gated).
 *
 * Set `ASTRA_LOCOMO_RERANK_LLM=<ollama-model>` (e.g. phi4-mini) to insert a
 * local-LLM reranker BETWEEN recall and the answerer. It selects which recalled
 * notes are actually relevant — or returns NONE, which forces the exact-substring
 * abstention answer directly (no answerer call).
 *
 * Motivation (LEDGER 2026-07-22 same-store rerank A/B): the onnx cross-encoder
 * lifts content retrieval (multi-hop +0.101) but BREAKS abstention on adversarial
 * (−0.149) because it surfaces a confident-looking note for no-answer questions.
 * A cross-encoder can only ORDER; it cannot say "none of these answer this". An
 * LLM reranker can — targeting the 0.607 rerank+abstain ceiling in one call.
 *
 * Fail-OPEN: any gate error / unparseable output passes the original hits through
 * unchanged, so the gate can never turn a working retrieval into an empty one.
 * Unset: byte-identical to before this existed (no call, no import cost).
 */
const RERANK_LLM_MODEL = process.env.ASTRA_LOCOMO_RERANK_LLM;

interface RerankGateResult { abstain: boolean; hits: SearchHit[] }

/**
 * Cross-encoder score-floor abstain gate (2026-07-22, eval-only A/B, env-gated,
 * ZERO extra LLM calls). Requires the run to have rerank ON with provider=onnx
 * (`--cross-encoder --cross-encoder-provider onnx`), so each hit carries
 * `explanation.signals.cross_encoder.final` (rerank.ts:395-400 — the clamped
 * cross-encoder relevance, 0..1).
 *
 * Set `ASTRA_LOCOMO_RERANK_SCORE_FLOOR=<0..1>` to drop every hit scoring below
 * the floor; if NONE clear it, abstain outright. Targets the onnx+abstain
 * ceiling (LEDGER 2026-07-22 = 0.6068): onnx ranks content well (multi-hop
 * +0.101) but surfaces a confident-looking note for no-answer questions — a
 * relevance floor is the cheapest way to restore abstention without an LLM.
 *
 * Fallback to the fused `hit.score` only if a hit lacks a cross_encoder signal
 * (shouldn't happen when topK >= k, but defensive). Unset: no-op, byte-identical.
 */
const RERANK_SCORE_FLOOR = ((): number | undefined => {
  const raw = process.env.ASTRA_LOCOMO_RERANK_SCORE_FLOOR;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
})();

export function applyScoreFloor(hits: SearchHit[], floor: number): RerankGateResult {
  if (hits.length === 0) return { abstain: false, hits };
  const kept = hits.filter(h => (h.explanation?.signals?.cross_encoder?.final ?? h.score) >= floor);
  if (kept.length === 0) return { abstain: true, hits: [] };
  return { abstain: false, hits: kept };
}

export async function llmRerankGate(
  model: string,
  question: string,
  hits: SearchHit[],
  baseUrl: string = DEFAULT_OLLAMA_URL,
): Promise<RerankGateResult> {
  if (hits.length === 0) return { abstain: false, hits };
  const notes = hits.map((h, i) => `${i + 1}. ${h.text}`).join('\n');
  const prompt = [
    'You select which memory notes are relevant to answer a QUESTION.',
    'Output ONLY the numbers of notes that contain information needed to answer it, most relevant first, comma-separated (e.g. "3,1,7").',
    'If NONE of the notes contain information that answers the question, output exactly: NONE',
    'Do not explain. Output only the numbers or NONE.',
    '',
    `QUESTION: ${question}`,
    'NOTES:',
    notes,
  ].join('\n');
  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, messages: [{ role: 'user', content: prompt }], stream: false,
        options: { temperature: 0, num_predict: 60 },
      }),
    });
    if (!res.ok) return { abstain: false, hits }; // fail-open
    const out = (((await res.json()) as { message?: { content?: string } }).message?.content ?? '').trim();
    // Explicit NONE (and no digits) => abstain.
    if (/\bNONE\b/i.test(out) && !/\d/.test(out)) return { abstain: true, hits: [] };
    const nums = [...out.matchAll(/\d+/g)].map(m => Number(m[0])).filter(n => n >= 1 && n <= hits.length);
    const uniq = [...new Set(nums)];
    if (uniq.length === 0) return { abstain: false, hits }; // unparseable => fail-open, keep original order
    return { abstain: false, hits: uniq.map(n => hits[n - 1]!) };
  } catch {
    return { abstain: false, hits }; // fail-open
  }
}

async function ollamaChatComplete(o: OllamaAnswerer, prompt: string): Promise<string> {
  const res = await fetch(`${o.baseUrl ?? 'http://127.0.0.1:11434'}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: o.model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { temperature: 0, num_predict: ANSWER_MAX_COMPLETION_TOKENS },
    }),
  });
  if (!res.ok) throw new Error(`ollama answerer HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return body.message?.content ?? '';
}

/**
 * FEAT-500 answerer-prompt A/B prep. `hit.explanation` (per-signal scores +
 * `top_signal` argmax) has been on the wire since 2026-07-13 but never
 * reached the answerer -- 46% of measured LoCoMo losses are answerer-side,
 * and this is the cheapest way to test whether surfacing WHY a note was
 * retrieved (strong keyword match vs. semantic vs. recency) changes the
 * answerer's judgment calls. Compact by design: one line per hit, not the
 * full raw/weight/final triple -- burning the answerer's already-tight
 * 150-token completion budget on JSON would be counterproductive.
 */
export function formatSignalBreakdown(hit: SearchHit): string {
  const explanation = hit.explanation;
  if (!explanation) return '(no signal breakdown available)';
  const top = explanation.top_signal ?? '?';
  const breakdown = Object.entries(explanation.signals)
    .sort(([, a], [, b]) => b.final - a.final)
    .map(([name, s]) => `${name}=${s.final.toFixed(2)}`)
    .join(', ');
  return `[top signal: ${top} | ${breakdown}]`;
}

export function buildAnswerPrompt(question: string, hits: SearchHit[], opts: { includeSignals?: boolean } = {}): string {
  const notes = hits.length > 0
    ? hits.map((h, i) => opts.includeSignals
        ? `${i + 1}. ${h.text} ${formatSignalBreakdown(h)}`
        : `${i + 1}. ${h.text}`)
      .join('\n')
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

/**
 * How many questions are answered at once.
 *
 * Every question is INDEPENDENT: same prompt template, same deployment, same k,
 * no shared state, no ordering dependency between them. So answering them
 * concurrently produces byte-identical hypotheses to answering them one at a
 * time — this is a scheduling change, not a scoring change (see the header note
 * on benchmark integrity, which this deliberately does not touch).
 *
 * 8 is a deliberately unambitious default: high enough to turn ~55 minutes of
 * serial waiting into a few minutes, low enough to stay well clear of Azure's
 * per-deployment rate limit. Raise it with `--answer-concurrency` if your
 * deployment has the headroom; a 429 storm would cost far more than it saves.
 */
const DEFAULT_ANSWER_CONCURRENCY = 8;

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving INPUT
 * ORDER in the returned array.
 *
 * Order matters even though every outcome carries its own `qa_id`: the written
 * `hypotheses.jsonl` should be byte-stable across runs so two runs of the same
 * commit diff cleanly. Completion order under concurrency is nondeterministic;
 * index-keyed writes make the output deterministic anyway.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function answerConversations(
  daemonClient: DaemonClientOpts,
  azureCfg: AzureConfig,
  samples: LoCoMoSample[],
  opts: { k?: number; readySampleIds?: Set<string>; concurrency?: number; includeSignals?: boolean; ollamaAnswerer?: OllamaAnswerer } = {},
): Promise<AnswerOutcome[]> {
  const k = opts.k ?? 10;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_ANSWER_CONCURRENCY);
  // FEAT-500: opt-in only, default off (ANSWERER_SIGNALS unset at the CLI
  // entry point below maps to includeSignals:undefined here) -- zero effect
  // on the prompt or the fixed cheap answerer when unset, so an ordinary run
  // is byte-identical to before this flag existed.
  const includeSignals = opts.includeSignals ?? false;

  // Flatten to a single work list first. The previous nested loop answered
  // strictly one question at a time — 1986 questions x ~1.5-2s each = ~55
  // minutes of pure waiting, for work that has no sequential dependency at all.
  // A full-suite eval that takes an hour is an eval people stop running, and
  // that is how a "45.4" ends up being quoted from a single conversation
  // (n=199) instead of the full 1986-question set.
  type Task = { qa: LoCoMoSample['qa'][number]; sampleId: string; id: string; notReady: boolean };
  const tasks: Task[] = [];
  for (const sample of samples) {
    const notReady = opts.readySampleIds !== undefined && !opts.readySampleIds.has(sample.sample_id);
    for (let i = 0; i < sample.qa.length; i++) {
      tasks.push({ qa: sample.qa[i]!, sampleId: sample.sample_id, id: qaId(sample.sample_id, i), notReady });
    }
  }

  const outcomes = await mapWithConcurrency(tasks, concurrency, async (t): Promise<AnswerOutcome> => {
    if (t.notReady) {
      return {
        qa_id: t.id,
        sample_id: t.sampleId,
        category: t.qa.category,
        hypothesis: '(skipped: conversation did not finish distilling within timeout)',
        hit_count: 0,
      };
    }
    // IDENTICAL to the serial version: same recall, same k, same project filter,
    // same prompt, same deployment, same token budget, same reasoning effort.
    const recalled = await recall(daemonClient, { text: t.qa.question, limit: k, filters: { project: projectIdFor(t.sampleId) } });
    // LLM rerank+abstain gate (env-gated, eval-only A/B): unset => hits === recalled,
    // byte-identical. Set => phi4-mini reranks/filters, or NONE => abstain outright.
    let hits = recalled;
    if (RERANK_LLM_MODEL) {
      const gate = await llmRerankGate(RERANK_LLM_MODEL, t.qa.question, recalled);
      if (gate.abstain) {
        return { qa_id: t.id, sample_id: t.sampleId, category: t.qa.category, hypothesis: 'no information available', hit_count: recalled.length };
      }
      hits = gate.hits;
    }
    if (RERANK_SCORE_FLOOR !== undefined) {
      const gate = applyScoreFloor(hits, RERANK_SCORE_FLOOR);
      if (gate.abstain) {
        return { qa_id: t.id, sample_id: t.sampleId, category: t.qa.category, hypothesis: 'no information available', hit_count: recalled.length };
      }
      hits = gate.hits;
    }
    const prompt = buildAnswerPrompt(t.qa.question, hits, { includeSignals });
    const hypothesis = opts.ollamaAnswerer
      ? await ollamaChatComplete(opts.ollamaAnswerer, prompt)
      : await azureChatComplete(azureCfg, {
          deployment: azureCfg.answererDeployment,
          messages: [{ role: 'user', content: prompt }],
          maxCompletionTokens: ANSWER_MAX_COMPLETION_TOKENS,
          reasoningEffort: ANSWER_REASONING_EFFORT,
        });
    return { qa_id: t.id, sample_id: t.sampleId, category: t.qa.category, hypothesis: hypothesis.trim(), hit_count: hits.length };
  });

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
 * Two distinct broken-run shapes are caught here. The second was added after the
 * first shipped WITH THIS EXACT HOLE IN IT (2026-07-13): the original version
 * returned early on `answered.length === 0` with the comment "a different
 * failure" — and that different failure was then surfaced NOWHERE. A run whose
 * distill timed out skipped all 199 questions, scored n=0, wrote a metrics file
 * reading `n/a`, and **exited 0**. The guard against silent failure had a silent
 * failure in it, ten lines from the throw.
 */
export function assertStoreNotEmpty(outcomes: AnswerOutcome[]): void {
  if (outcomes.length === 0) return;

  const answered = outcomes.filter(o => !o.hypothesis.startsWith('(skipped:'));
  const skipped = outcomes.length - answered.length;

  // Shape 2: everything (or nearly everything) was skipped — typically a distill
  // timeout. There is no score to report, and reporting `n/a` at exit 0 is exactly
  // the "broken run wearing a real result's costume" this file exists to prevent.
  if (answered.length === 0) throw new AllSkippedError(skipped, outcomes.length);

  // Shape 1: questions WERE answered, but every one retrieved zero memories.
  const totalHits = answered.reduce((n, o) => n + o.hit_count, 0);
  if (totalHits === 0) throw new EmptyStoreError(answered.length);
}

/** Thrown when every question was skipped (e.g. distill never finished) — no score exists. */
export class AllSkippedError extends Error {
  constructor(skipped: number, total: number) {
    super(
      `LoCoMo run is INVALID: ${skipped}/${total} questions were SKIPPED — no conversation finished ` +
        `distilling, so there is nothing to score.\n\n` +
        `This is not a low score. It is the ABSENCE of a score, and the harness previously reported it ` +
        `as "n/a" while exiting 0 — indistinguishable from a successful run to anything reading the ` +
        `exit code.\n\n` +
        `Most likely cause: --distill-timeout-ms is too short for the sample. A 19-session conversation ` +
        `needs roughly 19 x per-session distill time; the 900s default is NOT enough on a contended box ` +
        `(2026-07-13: wall clock 910s against a 900s timeout -> all 199 questions skipped).\n\n` +
        `Check: is Ollama saturated (an embed should take <1s, not 48s)? Raise --distill-timeout-ms.`,
    );
    this.name = 'AllSkippedError';
  }
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
  const answerConcurrency = Number(get('--answer-concurrency') ?? String(DEFAULT_ANSWER_CONCURRENCY));
  // FEAT-500 A/B prep: opt-in only, env not a flag -- keeps the default CLI
  // invocation (and every existing script/CI caller) byte-identical. Set
  // ANSWERER_SIGNALS=1 to include each hit's top_signal + signal breakdown
  // in the answerer prompt; see scripts/eval/locomo/answer.mts's
  // formatSignalBreakdown for the exact line shape.
  const includeSignals = process.env.ANSWERER_SIGNALS === '1';

  if (!samplePath || !daemonUrl || !token) {
    console.error('Usage: bun answer.mts --sample <path> --daemon-url <url> --token <token> [--k 10] [--out hypotheses.jsonl] [--ready <distill-wait-result.json>] [--answer-concurrency 8]');
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
  console.log(`Answering ${totalQa} QA pairs across ${samples.length} conversations via Azure deployment "${azureCfg.answererDeployment}" (k=${k}${includeSignals ? ', signals=on' : ''})...`);

  const outcomes = await answerConversations({ baseUrl: daemonUrl, token }, azureCfg, samples, { k, readySampleIds, concurrency: answerConcurrency, includeSignals });
  writeHypothesesJsonl(outcomes, outPath);

  const abstained = outcomes.filter(o => o.hypothesis.startsWith('(skipped')).length;
  console.log(`Wrote ${outcomes.length} hypotheses -> ${outPath} (${abstained} skipped due to distill timeout, avg hit_count=${(outcomes.reduce((n, o) => n + o.hit_count, 0) / outcomes.length).toFixed(1)})`);
}
