// FEAT-507: shared oversize-atom helpers.

import { describe, it, expect } from 'vitest';
import {
  EMBED_MAX_INPUT_CHARS,
  isOversizeText,
  truncateForEmbedding,
  isContextLengthExceededError,
  embedWithOversizeGuard,
} from '../../src/pipeline/oversize.js';
import { DeterministicError, TransientError } from '../../src/pipeline/errors.js';

describe('oversize.ts (FEAT-507)', () => {
  it('EMBED_MAX_INPUT_CHARS is a positive, sane budget (not zero, not absurdly large)', () => {
    expect(EMBED_MAX_INPUT_CHARS).toBeGreaterThan(0);
    expect(EMBED_MAX_INPUT_CHARS).toBeLessThan(10_000);
  });

  describe('isOversizeText', () => {
    it('false for text at or below the budget', () => {
      expect(isOversizeText('x'.repeat(EMBED_MAX_INPUT_CHARS))).toBe(false);
      expect(isOversizeText('short')).toBe(false);
    });

    it('true for text over the budget', () => {
      expect(isOversizeText('x'.repeat(EMBED_MAX_INPUT_CHARS + 1))).toBe(true);
    });
  });

  describe('truncateForEmbedding', () => {
    it('leaves text at or under the budget untouched', () => {
      const text = 'a short memory';
      const result = truncateForEmbedding(text);
      expect(result).toEqual({ text, truncated: false });
    });

    it('truncates oversize text to exactly the budget', () => {
      const text = 'x'.repeat(EMBED_MAX_INPUT_CHARS + 500);
      const result = truncateForEmbedding(text);
      expect(result.truncated).toBe(true);
      expect(result.text).toHaveLength(EMBED_MAX_INPUT_CHARS);
      expect(result.text).toBe(text.slice(0, EMBED_MAX_INPUT_CHARS));
    });
  });

  describe('isContextLengthExceededError', () => {
    it('matches the observed production error verbatim', () => {
      const err = new TransientError('Ollama embed failed: HTTP 500 — {"error":"the input length exceeds the context length"}');
      expect(isContextLengthExceededError(err)).toBe(true);
    });

    it('matches case-insensitively', () => {
      const err = new Error('THE INPUT LENGTH EXCEEDS THE CONTEXT LENGTH');
      expect(isContextLengthExceededError(err)).toBe(true);
    });

    it('false for an unrelated error', () => {
      expect(isContextLengthExceededError(new Error('ECONNREFUSED'))).toBe(false);
      expect(isContextLengthExceededError(new TransientError('HTTP 503 — service unavailable'))).toBe(false);
    });

    it('false for a non-Error value', () => {
      expect(isContextLengthExceededError('not an error')).toBe(false);
      expect(isContextLengthExceededError(undefined)).toBe(false);
    });
  });

  describe('embedWithOversizeGuard', () => {
    it('passes through a successful embed unchanged', async () => {
      const embed = { embed: async (texts: string[]) => texts.map(() => new Float32Array([1, 2, 3])) };
      const result = await embedWithOversizeGuard('hello', embed, 'mem-1', 5);
      expect(result).toHaveLength(1);
    });

    it('reclassifies a context-length-exceeded failure as DeterministicError', async () => {
      const embed = {
        embed: async () => {
          throw new TransientError('Ollama embed failed: HTTP 500 — {"error":"the input length exceeds the context length"}');
        },
      };
      await expect(embedWithOversizeGuard('x'.repeat(2000), embed, 'mem-1', 5000))
        .rejects.toBeInstanceOf(DeterministicError);
    });

    it('leaves a genuinely transient failure unreclassified', async () => {
      const embed = {
        embed: async () => {
          throw new TransientError('ECONNREFUSED');
        },
      };
      const promise = embedWithOversizeGuard('hello', embed, 'mem-1', 5);
      await expect(promise).rejects.toBeInstanceOf(TransientError);
      await expect(promise).rejects.not.toBeInstanceOf(DeterministicError);
    });
  });
});
