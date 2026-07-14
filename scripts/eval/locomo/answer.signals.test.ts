/**
 * FEAT-500 answerer-prompt A/B prep: `buildAnswerPrompt`'s opt-in
 * `includeSignals` flag (env `ANSWERER_SIGNALS=1` at the CLI entry point)
 * must be a no-op on the prompt when unset -- benchmark integrity depends on
 * the DEFAULT invocation staying byte-identical to every prior recorded
 * score (see answer.mts's own header note on this). This file pins that
 * claim plus the opt-in formatting itself.
 */
import { describe, it, expect } from 'vitest';
import { buildAnswerPrompt, formatSignalBreakdown } from './answer.mts';
import type { SearchHit } from '../shared/daemon-client.js';

const hitWithExplanation: SearchHit = {
  id: 'h1',
  type: 'fact',
  text: 'the meeting was rescheduled to Tuesday',
  score: 0.42,
  source: 'both',
  explanation: {
    final: 0.42,
    signals: {
      bm25: { raw: 4.1, weight: 0.4, final: 0.1 },
      cosine: { raw: 0.9, weight: 0.4, final: 0.3 },
      importance: { raw: 0.5, weight: 0.1, final: 0.02 },
    },
    top_signal: 'cosine',
  },
};

const hitWithoutExplanation: SearchHit = {
  id: 'h2',
  type: 'fact',
  text: 'no explanation on this one (older daemon)',
  score: 0.1,
  source: 'fts',
};

describe('buildAnswerPrompt — default (includeSignals unset)', () => {
  it('is byte-identical to a call with no third argument at all', () => {
    const hits = [hitWithExplanation, hitWithoutExplanation];
    const withoutOpts = buildAnswerPrompt('when was the meeting?', hits);
    const withEmptyOpts = buildAnswerPrompt('when was the meeting?', hits, {});
    const withExplicitFalse = buildAnswerPrompt('when was the meeting?', hits, { includeSignals: false });
    expect(withoutOpts).toBe(withEmptyOpts);
    expect(withoutOpts).toBe(withExplicitFalse);
  });

  it('never mentions signal/top_signal formatting when unset', () => {
    const prompt = buildAnswerPrompt('when was the meeting?', [hitWithExplanation]);
    expect(prompt).not.toContain('top signal');
    expect(prompt).not.toContain('cosine=');
  });
});

describe('buildAnswerPrompt — includeSignals:true (ANSWERER_SIGNALS=1)', () => {
  it('appends each hit\'s signal breakdown after its text', () => {
    const prompt = buildAnswerPrompt('when was the meeting?', [hitWithExplanation], { includeSignals: true });
    expect(prompt).toContain('1. the meeting was rescheduled to Tuesday [top signal: cosine');
    expect(prompt).toContain('cosine=0.30');
    expect(prompt).toContain('bm25=0.10');
  });

  it('degrades gracefully for a hit with no explanation (older daemon)', () => {
    const prompt = buildAnswerPrompt('q', [hitWithoutExplanation], { includeSignals: true });
    expect(prompt).toContain('(no signal breakdown available)');
  });

  it('empty hits list is unaffected by the flag either way', () => {
    const on = buildAnswerPrompt('q', [], { includeSignals: true });
    const off = buildAnswerPrompt('q', []);
    expect(on).toBe(off);
    expect(on).toContain('(no memories were retrieved for this question)');
  });
});

describe('formatSignalBreakdown', () => {
  it('sorts signals highest-.final-first and includes top_signal', () => {
    const out = formatSignalBreakdown(hitWithExplanation);
    expect(out).toBe('[top signal: cosine | cosine=0.30, bm25=0.10, importance=0.02]');
  });

  it('falls back cleanly when explanation is absent', () => {
    expect(formatSignalBreakdown(hitWithoutExplanation)).toBe('(no signal breakdown available)');
  });
});
