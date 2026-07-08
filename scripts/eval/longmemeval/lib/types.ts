/**
 * Shared types for the LongMemEval adapter (docs/eval/longmemeval-plan.md).
 * Mirrors the verified dataset schema from the plan doc section 1.1 — do not
 * add fields that aren't actually present in longmemeval_s_cleaned.json.
 */

export const QUESTION_TYPES = [
  'multi-session',
  'temporal-reasoning',
  'knowledge-update',
  'single-session-user',
  'single-session-assistant',
  'single-session-preference',
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

export interface HaystackTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface LongMemEvalQuestion {
  question_id: string;
  question_type: QuestionType;
  question: string;
  /** "YYYY/MM/DD (Dow) HH:MM" — see lib/dates.ts for the parser. */
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  /** Same format as question_date, one per haystack session. */
  haystack_dates: string[];
  haystack_session_ids: string[];
  /** One array-of-turns per session, same order as haystack_session_ids/dates. */
  haystack_sessions: HaystackTurn[][];
}

/** `true` for abstention questions — a question_id suffix, not a distinct
 *  question_type value (plan doc section 1.2). */
export function isAbstention(question: Pick<LongMemEvalQuestion, 'question_id'>): boolean {
  return question.question_id.includes('_abs');
}

/** LongMemEval official hypothesis record shape (plan doc section 2). */
export interface HypothesisRecord {
  question_id: string;
  hypothesis: string;
}

export interface IngestSession {
  question_id: string;
  session_id: string;
  haystack_index: number;
}
