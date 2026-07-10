/**
 * Shared types for the LoCoMo adapter (FEAT-457). Schema verified against
 * the real `data/locomo10.json` from https://github.com/snap-research/locomo
 * (fetched 2026-07-10, commit on `main` at that date) — do not add fields
 * that aren't actually present in that file.
 *
 * Category numbering (1-5) is NOT self-describing in the raw data — it is
 * only defined by the upstream scoring code
 * (`task_eval/evaluation.py::eval_question_answering`), which this comment
 * mirrors exactly (verified live 2026-07-10, quoting the actual source, not
 * the paper's prose description — the two do not obviously agree just by
 * reading question text, see judge/metrics.ts's header for the full
 * derivation):
 *   category 1 -> multi-hop     (scored with `f1()`, a comma-split
 *                                 multi-answer variant — evaluation_stats.py
 *                                 additionally computes a farthest/latest
 *                                 evidence-session span ONLY for category 1,
 *                                 which only makes sense for evidence that
 *                                 spans multiple sessions)
 *   category 2 -> temporal       (plain `f1_score`; empirically every
 *                                 sampled category-2 question is a "when did
 *                                 X" date question)
 *   category 3 -> open-domain    (plain `f1_score`, but the answer is first
 *                                 truncated to `answer.split(';')[0]` — real
 *                                 category-3 answers look like "Likely no;
 *                                 though she likes reading..." i.e. a direct
 *                                 answer followed by commonsense/world-
 *                                 knowledge justification after the `;`)
 *   category 4 -> single-hop     (plain `f1_score`; empirically the
 *                                 straightforward single-fact lookups, and
 *                                 the largest category by count)
 *   category 5 -> adversarial    (binary: correct iff the model's answer
 *                                 contains "no information available" or
 *                                 "not mentioned" — these questions have NO
 *                                 `answer` field, only `adversarial_answer`,
 *                                 a plausible-but-wrong distractor)
 */

export const LOCOMO_CATEGORIES = [1, 2, 3, 4, 5] as const;
export type LoCoMoCategory = (typeof LOCOMO_CATEGORIES)[number];

export const CATEGORY_NAMES: Record<LoCoMoCategory, string> = {
  1: 'multi-hop',
  2: 'temporal',
  3: 'open-domain',
  4: 'single-hop',
  5: 'adversarial',
};

export function isAdversarial(category: LoCoMoCategory): boolean {
  return category === 5;
}

export interface LoCoMoTurn {
  speaker: string;
  /** e.g. "D1:3" -- session 1, turn 3. */
  dia_id: string;
  text: string;
  img_url?: string[];
  blip_caption?: string;
}

export interface LoCoMoConversation {
  speaker_a: string;
  speaker_b: string;
  /** Dynamic keys: `session_${n}` (LoCoMoTurn[]) and
   *  `session_${n}_date_time` (string, see lib/dates.ts) for n = 1..N.
   *  Sessions are not necessarily contiguous (some samples skip numbers). */
  [key: `session_${number}`]: LoCoMoTurn[];
  [key: `session_${number}_date_time`]: string;
}

export interface LoCoMoQA {
  question: string;
  /** String OR number in the raw data (6 of 1986 are bare numbers, e.g.
   *  `2022`) -- always coerce with String() before use. Absent for
   *  category 5 (adversarial) questions -- only `adversarial_answer` is
   *  present there. */
  answer?: string | number;
  /** Only present on category 5 (adversarial) questions -- a plausible but
   *  WRONG distractor answer; the correct response is to abstain. */
  adversarial_answer?: string;
  /** Dialog ids (e.g. "D1:3") the answer is grounded in. Can be empty. */
  evidence: string[];
  category: LoCoMoCategory;
}

export interface LoCoMoSample {
  sample_id: string;
  conversation: LoCoMoConversation;
  qa: LoCoMoQA[];
  /** Generated annotations this adapter does not currently use for
   *  ingest/scoring (kept typed loosely so the loader doesn't reject real
   *  files that include them). */
  event_summary?: Record<string, unknown>;
  observation?: Record<string, unknown>;
  session_summary?: Record<string, string>;
}

/** One (sample, session-number) pair worth of ingest work -- LoCoMo is
 *  conversation-centric (FEAT-457 architecture note): a whole sample's
 *  sessions are ingested once, then every one of that sample's QA pairs is
 *  answered against the single resulting project, unlike LongMemEval's
 *  per-question isolated haystack. */
export interface IngestSession {
  sample_id: string;
  session_number: number;
}

/** Same hypothesis record shape LongMemEval's judge/answer pipeline uses,
 *  keyed by a synthetic per-QA id (`${sample_id}#${qaIndex}`) since raw
 *  LoCoMo QA pairs have no id of their own. */
export interface HypothesisRecord {
  qa_id: string;
  sample_id: string;
  category: LoCoMoCategory;
  hypothesis: string;
}

export function qaId(sampleId: string, qaIndex: number): string {
  return `${sampleId}#${qaIndex}`;
}

/** Every `session_${n}` key present on a conversation object, sorted
 *  numerically (object key order is not guaranteed to be numeric for
 *  double-digit session numbers). */
export function sessionNumbers(conversation: LoCoMoConversation): number[] {
  const nums: number[] = [];
  for (const key of Object.keys(conversation)) {
    const m = /^session_(\d+)$/.exec(key);
    if (m) nums.push(Number(m[1]));
  }
  return nums.sort((a, b) => a - b);
}
