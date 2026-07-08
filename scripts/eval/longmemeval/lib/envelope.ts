import type { LongMemEvalQuestion } from './types.js';
import type { CanonicalIngestEnvelope } from './daemon-client.js';
import { parseLongMemEvalDate } from './dates.js';

/** `project_id` isolates one question's haystack from every other question's
 *  (plan doc 3.1) — LongMemEval reuses raw sessions across different
 *  questions' haystacks, so sharing a project would leak recall pools. */
export function projectIdFor(questionId: string): string {
  return `longmemeval-${questionId}`;
}

/** `session_id` namespaced with the question id so idempotency-key hashing
 *  never collides across the run (plan doc 3.1). */
export function sessionIdFor(questionId: string, haystackSessionId: string): string {
  return `lme-${questionId}-${haystackSessionId}`;
}

export function buildIngestEnvelope(question: LongMemEvalQuestion, haystackIndex: number): CanonicalIngestEnvelope {
  const haystackSessionId = question.haystack_session_ids[haystackIndex];
  const turns = question.haystack_sessions[haystackIndex];
  const capturedAtRaw = question.haystack_dates[haystackIndex];
  if (haystackSessionId === undefined || turns === undefined || capturedAtRaw === undefined) {
    throw new Error(`question ${question.question_id}: haystack index ${haystackIndex} out of range`);
  }
  if (turns.length === 0) {
    throw new Error(`question ${question.question_id}: haystack session ${haystackSessionId} has zero turns`);
  }

  return {
    event: 'session_end',
    session_id: sessionIdFor(question.question_id, haystackSessionId),
    project_id: projectIdFor(question.question_id),
    agent_type: 'longmemeval-harness',
    captured_at: parseLongMemEvalDate(capturedAtRaw),
    turns: turns.map(t => ({ role: t.role, text: t.content })),
    client_scrub_applied: false,
    client_scrub_hits: 0,
    client_version: 'longmemeval-eval-harness/0.1',
    client_scrub_version: 'none',
    wire_version: 'v1.0',
  };
}
