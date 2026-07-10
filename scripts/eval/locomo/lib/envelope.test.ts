import { describe, it, expect } from 'vitest';
import { buildIngestEnvelope, projectIdFor, sessionIdFor } from './envelope.js';
import type { LoCoMoSample } from './types.js';

const SAMPLE: LoCoMoSample = {
  sample_id: 'conv-x',
  conversation: {
    speaker_a: 'Caroline',
    speaker_b: 'Melanie',
    session_1_date_time: '1:56 pm on 8 May, 2023',
    session_1: [
      { speaker: 'Caroline', dia_id: 'D1:1', text: 'Hey Mel!' },
      { speaker: 'Melanie', dia_id: 'D1:2', text: 'Hey Caroline!' },
      { speaker: 'Caroline', dia_id: 'D1:3', text: 'Look at this', img_url: ['http://x/img.png'], blip_caption: 'a sunset over the beach' },
    ],
  },
  qa: [],
};

describe('projectIdFor / sessionIdFor', () => {
  it('namespaces by sample_id only (conversation-centric, not per-question)', () => {
    expect(projectIdFor('conv-x')).toBe('locomo-conv-x');
    expect(sessionIdFor('conv-x', 1)).toBe('locomo-conv-x-s1');
  });
});

describe('buildIngestEnvelope', () => {
  it('maps speaker_a to user role and speaker_b to assistant role', () => {
    const env = buildIngestEnvelope(SAMPLE, 1);
    expect(env.turns[0]).toMatchObject({ role: 'user', text: 'Caroline: Hey Mel!' });
    expect(env.turns[1]).toMatchObject({ role: 'assistant', text: 'Melanie: Hey Caroline!' });
  });

  it('inlines the blip_caption for image turns', () => {
    const env = buildIngestEnvelope(SAMPLE, 1);
    expect(env.turns[2]!.text).toBe('Caroline: Look at this [shares a sunset over the beach]');
  });

  it('sets captured_at from the session date_time, parsed to UTC ISO', () => {
    const env = buildIngestEnvelope(SAMPLE, 1);
    expect(env.captured_at).toBe('2023-05-08T13:56:00.000Z');
  });

  it('sets session_id and project_id per the naming scheme', () => {
    const env = buildIngestEnvelope(SAMPLE, 1);
    expect(env.session_id).toBe('locomo-conv-x-s1');
    expect(env.project_id).toBe('locomo-conv-x');
  });

  it('sets a canonical v1.0 envelope with client_scrub fields', () => {
    const env = buildIngestEnvelope(SAMPLE, 1);
    expect(env.event).toBe('session_end');
    expect(env.wire_version).toBe('v1.0');
    expect(env.client_scrub_applied).toBe(false);
  });

  it('throws when the session number does not exist on the conversation', () => {
    expect(() => buildIngestEnvelope(SAMPLE, 2)).toThrow(/missing turns or date_time/);
  });

  it('throws when a session has zero turns', () => {
    const empty: LoCoMoSample = {
      ...SAMPLE,
      conversation: { ...SAMPLE.conversation, session_1: [] },
    };
    expect(() => buildIngestEnvelope(empty, 1)).toThrow(/zero turns/);
  });
});
