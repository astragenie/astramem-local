import { describe, it, expect } from 'vitest';
import { locateEvidence } from '../../src/distill/locate-evidence.js';

describe('locateEvidence', () => {
  describe('no evidence / no transcript', () => {
    it('returns null for empty evidence', () => {
      expect(locateEvidence('user: hello there', '')).toBeNull();
    });

    it('returns null for null/undefined evidence', () => {
      expect(locateEvidence('user: hello there', null)).toBeNull();
      expect(locateEvidence('user: hello there', undefined)).toBeNull();
    });

    it('returns null for an empty transcript', () => {
      expect(locateEvidence('', 'some evidence text here')).toBeNull();
      expect(locateEvidence('   ', 'some evidence text here')).toBeNull();
    });
  });

  describe('tier 1 — exact substring match', () => {
    it('locates a verbatim excerpt on the first line', () => {
      const transcript = [
        'user: My daughter Alice is starting kindergarten in September.',
        'assistant: That is wonderful!',
      ].join('\n');
      const loc = locateEvidence(transcript, 'Alice is starting kindergarten');
      expect(loc).not.toBeNull();
      expect(loc!.matchTier).toBe('exact');
      expect(loc!.turnIndex).toBe(0);
      expect(transcript.slice(loc!.charStart, loc!.charEnd)).toBe('Alice is starting kindergarten');
      expect(loc!.span).toBe('Alice is starting kindergarten');
    });

    it('locates an excerpt on a later line and reports the correct turnIndex', () => {
      const transcript = [
        'user: hi there',
        'assistant: hello!',
        'user: She went to Sunny Days for two years.',
      ].join('\n');
      const loc = locateEvidence(transcript, 'She went to Sunny Days for two years');
      expect(loc).not.toBeNull();
      expect(loc!.matchTier).toBe('exact');
      expect(loc!.turnIndex).toBe(2);
    });

    it('offsets are relative to the FULL transcript, not the line', () => {
      const transcript = 'user: [Alice Chen] should we ship it today?';
      const loc = locateEvidence(transcript, 'ship it today');
      expect(loc).not.toBeNull();
      expect(transcript.slice(loc!.charStart, loc!.charEnd)).toBe('ship it today');
    });
  });

  describe('tier 2 — fuzzy fallback', () => {
    it('locates the best-matching whole turn when the evidence is paraphrased', () => {
      const transcript = [
        'user: [Alice Chen] should we cut the caption capture over to the new consent gate today?',
        'assistant: [Bob Okafor] yeah, I think so — ADR-017 landed and the disclosure copy is ready.',
        'assistant: [Priya Nair] one thing though, we still need the doctor WARN row before this ships.',
      ].join('\n');
      const evidence = 'We still need the doctor WARN row before this ships.';
      const loc = locateEvidence(transcript, evidence);
      expect(loc).not.toBeNull();
      expect(loc!.matchTier).toBe('fuzzy');
      expect(loc!.turnIndex).toBe(2);
      expect(loc!.span).toContain('doctor WARN row');
    });

    it('returns null when no turn clears the fuzzy threshold', () => {
      const transcript = [
        'user: what is the weather like today?',
        'assistant: it is sunny and warm.',
      ].join('\n');
      const loc = locateEvidence(transcript, 'completely unrelated evidence about database migrations');
      expect(loc).toBeNull();
    });

    it('returns null for a short evidence excerpt (below the fuzzy token floor) with no exact match', () => {
      const transcript = 'user: [Alice Chen] sure thing, sounds good to me';
      const loc = locateEvidence(transcript, 'ok cool');
      expect(loc).toBeNull();
    });

    it('returns null on an ambiguous near-tie between two different turns', () => {
      const transcript = [
        'assistant: [Alice] one thing though, we still need the doctor WARN row before this ships.',
        'assistant: [Bob] one thing though, we still need the doctor ERROR row before this ships.',
      ].join('\n');
      // Paraphrase that drops the one differentiating word (WARN/ERROR) —
      // both lines score identically, same worst-case attribute-speaker.ts
      // was calibrated against.
      const evidence = 'we still need the doctor row before this ships';
      const loc = locateEvidence(transcript, evidence);
      expect(loc).toBeNull();
    });
  });
});
