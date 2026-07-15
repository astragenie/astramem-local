/**
 * FEAT-505 — fuzzy speaker attribution.
 *
 * Threshold/margin rationale (see attribute-speaker.ts doc comment for the
 * numbers): derived from a live codex-subscription (gpt-5.4-mini) micro-
 * benchmark run 2026-07-14 — six real paraphrases of transcript-style
 * utterances scored 0.692-1.000 token-containment against their true source
 * line, while an unrelated line in the same transcript scored ~0.1. A
 * same-transcript adversarial pair (two speakers, one word apart, e.g.
 * "WARN row" vs "ERROR row") scored 1.000 vs 0.900 when the paraphrase kept
 * the differentiating word, and a dead 0.857/0.857 tie in the worst case
 * where the paraphrase dropped it — which is exactly why a bare threshold
 * is not enough and this needs a margin-over-runner-up check too.
 */
import { describe, it, expect } from 'vitest';
import { attributeSpeaker } from '../../src/distill/attribute-speaker.js';

describe('attributeSpeaker', () => {
  describe('no evidence / no transcript', () => {
    it('returns null for empty evidence', () => {
      expect(attributeSpeaker('user: [Alice] hello there', '')).toBeNull();
    });

    it('returns null for null/undefined evidence', () => {
      expect(attributeSpeaker('user: [Alice] hello there', null)).toBeNull();
      expect(attributeSpeaker('user: [Alice] hello there', undefined)).toBeNull();
    });

    it('returns null when the transcript has no speaker-labeled lines at all', () => {
      expect(attributeSpeaker('just some plain text, no role prefix', 'plain text')).toBeNull();
    });
  });

  describe('tier 1 — exact substring match (pre-existing behavior, unchanged)', () => {
    it('matches when the evidence is a verbatim substring of a labeled line', () => {
      const transcript = [
        'user: [Alice Chen] should we cut the caption capture over to the new consent gate today?',
        'assistant: [Bob Okafor] yeah, I think so.',
      ].join('\n');
      expect(attributeSpeaker(transcript, 'should we cut the caption capture over')).toBe('Alice Chen');
    });

    it('matches when the labeled line is a substring of a slightly longer evidence excerpt', () => {
      const transcript = 'assistant: [Priya Nair] one thing though, we still need the doctor WARN row before this ships.';
      const evidence = 'one thing though, we still need the doctor WARN row before this ships. (per Priya)';
      expect(attributeSpeaker(transcript, evidence)).toBe('Priya Nair');
    });

    // FEAT-506: pre-FEAT-505 tier 1 was a first-match-wins loop with no
    // ambiguity check — a literal collision between two DIFFERENT speakers'
    // lines silently picked whichever came first in the transcript. Tier 2
    // already refuses to guess on a near-tie (AMBIGUITY_MARGIN); tier 1 must
    // apply the same discipline instead of trusting substring-match order.
    it('routes an exact-substring tie between two DIFFERENT speakers to null instead of first-match-wins', () => {
      const transcript = [
        "user: [Alice Chen] sounds good, let's ship it",
        "assistant: [Bob Okafor] sounds good, let's ship it",
      ].join('\n');
      expect(attributeSpeaker(transcript, "sounds good, let's ship it")).toBeNull();
    });

    it('still attributes when multiple lines match but all belong to the SAME speaker (not a real ambiguity)', () => {
      const transcript = [
        "user: [Alice Chen] let's ship it today",
        "user: [Alice Chen] let's ship it today, for real this time",
      ].join('\n');
      expect(attributeSpeaker(transcript, "let's ship it today")).toBe('Alice Chen');
    });
  });

  describe('tier 2 — fuzzy fallback on a real-LLM-style paraphrase', () => {
    it('attributes a compressed/reordered paraphrase to the correct speaker', () => {
      const transcript = [
        "user: [Alice Chen] should we cut the caption capture over to the new consent gate today?",
        "assistant: [Bob Okafor] yeah, I think so — ADR-017 landed and the disclosure copy is ready.",
        "assistant: [Priya Nair] one thing though, we still need the doctor WARN row before this ships.",
      ].join('\n');
      // Live codex-subscription (gpt-5.4-mini) output for this exact line, 2026-07-14.
      const evidence = 'We still need the doctor WARN row before this ships.';
      expect(attributeSpeaker(transcript, evidence)).toBe('Priya Nair');
    });

    it('attributes a heavily reworded paraphrase (clause reorder + synonym swap)', () => {
      const transcript = [
        "user: [Alice Chen] should we cut the caption capture over to the new consent gate today?",
        "assistant: [Bob Okafor] yeah, I think so — ADR-017 landed and the disclosure copy is ready.",
      ].join('\n');
      // Live codex-subscription output for Bob's line, 2026-07-14.
      const evidence = 'ADR-017 has landed, and the disclosure copy is ready.';
      expect(attributeSpeaker(transcript, evidence)).toBe('Bob Okafor');
    });

    it('does not fuzzy-match a paraphrase against an unrelated line in the same transcript', () => {
      const transcript = [
        "user: [Alice Chen] should we cut the caption capture over to the new consent gate today?",
        "assistant: [Bob Okafor] yeah, I think so — ADR-017 landed and the disclosure copy is ready.",
        "assistant: [Priya Nair] one thing though, we still need the doctor WARN row before this ships.",
      ].join('\n');
      const evidence = 'We still need the doctor WARN row before this ships.';
      const speaker = attributeSpeaker(transcript, evidence);
      expect(speaker).not.toBe('Alice Chen');
      expect(speaker).not.toBe('Bob Okafor');
    });

    it('returns null rather than guessing when no line clears the match threshold', () => {
      const transcript = [
        "user: [Alice Chen] should we cut the caption capture over to the new consent gate today?",
        "assistant: [Bob Okafor] yeah, I think so — ADR-017 landed and the disclosure copy is ready.",
      ].join('\n');
      const evidence = 'completely unrelated content about a different topic entirely';
      expect(attributeSpeaker(transcript, evidence)).toBeNull();
    });

    it('does not fuzzy-match extremely short evidence (avoids spurious short-string overlap)', () => {
      const transcript = [
        "user: [Alice Chen] yes let's ship the feature today",
        "assistant: [Bob Okafor] no let's not ship it today",
      ].join('\n');
      // Not an exact substring of either line, and short enough (< 4 tokens)
      // that the fuzzy tier must refuse to guess between the two speakers.
      expect(attributeSpeaker(transcript, 'ship today')).toBeNull();
    });
  });

  describe('misattribution guard (AC-3) — near-duplicate utterances by different speakers', () => {
    it('never attributes to the WRONG speaker when the differentiating word IS preserved in the evidence', () => {
      const transcript = [
        "assistant: [Priya Nair] one thing though, we still need the doctor WARN row before this ships on Friday.",
        "assistant: [Dana Kim] one thing though, we still need the doctor ERROR row before this ships on Friday.",
      ].join('\n');
      // Real live paraphrase (WARN preserved) — must resolve to Priya or null, NEVER Dana.
      const evidence = 'We still need the doctor WARN row before this ships.';
      const speaker = attributeSpeaker(transcript, evidence);
      expect(speaker).not.toBe('Dana Kim');
      if (speaker !== null) expect(speaker).toBe('Priya Nair');
    });

    it('returns null (never a guess) when the differentiating word is dropped by the paraphrase, leaving a genuine tie', () => {
      const transcript = [
        "user: [Alice Chen] I'll handle the Stripe webhook migration by Friday.",
        "assistant: [Bob Okafor] I'll handle the Auth0 webhook migration by Friday.",
      ].join('\n');
      // Paraphrase drops which service ("Stripe"/"Auth0") entirely — the one
      // fact that actually distinguishes the two speakers' turns. Live
      // micro-benchmark measured this as an exact 0.857/0.857 tie.
      const evidence = 'will handle the webhook migration by Friday';
      expect(attributeSpeaker(transcript, evidence)).toBeNull();
    });

    it('never attributes to the wrong speaker across repeated near-duplicate pairs (property-style sweep)', () => {
      const pairs: Array<[string, string, string]> = [
        ['let\'s push the deadline to next Friday instead of Wednesday.', 'let\'s push the deadline to next Monday instead of Wednesday.', 'moving the deadline to next Friday instead of Wednesday'],
        ['the retry logic drops events when the batch exceeds two hundred rows.', 'the retry logic drops events when the batch exceeds two thousand rows.', 'retry logic drops events past two hundred rows'],
        ['I think Alice should own the migration rollout.', 'I think Priya should own the migration rollout.', 'Alice should own the migration rollout'],
      ];
      for (const [trueLine, wrongLine, evidence] of pairs) {
        const transcript = [
          `user: [SpeakerTrue] ${trueLine}`,
          `assistant: [SpeakerWrong] ${wrongLine}`,
        ].join('\n');
        const speaker = attributeSpeaker(transcript, evidence);
        expect(speaker).not.toBe('SpeakerWrong');
      }
    });
  });
});
