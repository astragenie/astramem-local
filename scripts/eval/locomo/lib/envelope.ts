import type { LoCoMoSample } from './types.js';
import type { CanonicalIngestEnvelope } from '../../shared/daemon-client.js';
import { parseLocomoDateTime } from './dates.js';

/** `project_id` isolates one conversation's sessions from every other
 *  conversation's -- unlike LongMemEval (../../longmemeval/lib/envelope.ts),
 *  this is keyed by `sample_id` alone, NOT per-question: LoCoMo is
 *  conversation-centric (FEAT-457 architecture note) -- one conversation is
 *  ingested once, then every one of its QA pairs is answered against the
 *  same project. */
export function projectIdFor(sampleId: string): string {
  return `locomo-${sampleId}`;
}

/** `session_id` namespaced with the sample id so idempotency-key hashing
 *  never collides across the run. */
export function sessionIdFor(sampleId: string, sessionNumber: number): string {
  return `locomo-${sampleId}-s${sessionNumber}`;
}

/** Builds one canonical ingest envelope per LoCoMo session
 *  (`conversation.session_${n}`). Turn `role` is derived from `speaker`
 *  (`speaker_a` -> 'user', `speaker_b` -> 'assistant') since the canonical
 *  envelope only carries a binary role, but the speaker's actual name is
 *  prefixed onto the turn text so extraction still sees who said what --
 *  most LoCoMo QA pairs are keyed to a specific named person, and losing
 *  the name would make a large fraction of the benchmark unanswerable
 *  regardless of retrieval quality. Image turns get an inline
 *  `[shares <blip_caption>]` note, the same convention the upstream
 *  benchmark's own token-length accounting uses
 *  (task_eval/evaluation_stats.py's get_conversation_lengths). */
export function buildIngestEnvelope(sample: LoCoMoSample, sessionNumber: number): CanonicalIngestEnvelope {
  const turns = sample.conversation[`session_${sessionNumber}`];
  const dateTimeRaw = sample.conversation[`session_${sessionNumber}_date_time`];
  if (turns === undefined || dateTimeRaw === undefined) {
    throw new Error(`sample ${sample.sample_id}: session ${sessionNumber} is missing turns or date_time`);
  }
  if (turns.length === 0) {
    throw new Error(`sample ${sample.sample_id}: session ${sessionNumber} has zero turns`);
  }
  const { speaker_a } = sample.conversation;

  return {
    event: 'session_end',
    session_id: sessionIdFor(sample.sample_id, sessionNumber),
    project_id: projectIdFor(sample.sample_id),
    agent_type: 'locomo-harness',
    captured_at: parseLocomoDateTime(dateTimeRaw),
    turns: turns.map(t => ({
      role: t.speaker === speaker_a ? 'user' : 'assistant',
      text: t.blip_caption ? `${t.speaker}: ${t.text} [shares ${t.blip_caption}]` : `${t.speaker}: ${t.text}`,
    })),
    client_scrub_applied: false,
    client_scrub_hits: 0,
    client_version: 'locomo-eval-harness/0.1',
    client_scrub_version: 'none',
    wire_version: 'v1.0',
  };
}
