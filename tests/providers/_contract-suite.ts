/**
 * Shared contract test suite for all LLM + Embed providers.
 *
 * Usage:
 *   import { runLLMContractSuite } from './_contract-suite.js';
 *   runLLMContractSuite('ollama', () => myOllamaProvider);
 */
import { describe, it, expect } from 'vitest';
import type { LLMProvider, EmbedProvider } from '../../src/contracts/index.js';

export function runLLMContractSuite(
  providerName: string,
  factory: () => LLMProvider,
) {
  describe(`LLMProvider contract — ${providerName}`, () => {
    it('has correct name', () => {
      const p = factory();
      expect(['ollama', 'azure-openai']).toContain(p.name);
    });

    it('has non-empty model', () => {
      const p = factory();
      expect(typeof p.model).toBe('string');
      expect(p.model.length).toBeGreaterThan(0);
    });

    it('chat() returns {text: string, usage: {in, out, usd}}', async () => {
      const p = factory();
      const result = await p.chat([{ role: 'user', content: 'hello' }]);
      expect(typeof result.text).toBe('string');
      expect(typeof result.usage.in).toBe('number');
      expect(typeof result.usage.out).toBe('number');
      expect(typeof result.usage.usd).toBe('number');
      expect(result.usage.in).toBeGreaterThanOrEqual(0);
      expect(result.usage.out).toBeGreaterThanOrEqual(0);
      expect(result.usage.usd).toBeGreaterThanOrEqual(0);
    });

    it('health() returns {ok, model, latency_ms}', async () => {
      const p = factory();
      const h = await p.health();
      expect(typeof h.ok).toBe('boolean');
      expect(typeof h.model).toBe('string');
      expect(typeof h.latency_ms).toBe('number');
      expect(h.latency_ms).toBeGreaterThanOrEqual(0);
    });
  });
}

export function runEmbedContractSuite(
  providerName: string,
  factory: () => EmbedProvider,
) {
  describe(`EmbedProvider contract — ${providerName}`, () => {
    it('has correct name', () => {
      const p = factory();
      expect(['ollama', 'azure-openai']).toContain(p.name);
    });

    it('has non-empty model', () => {
      const p = factory();
      expect(typeof p.model).toBe('string');
      expect(p.model.length).toBeGreaterThan(0);
    });

    it('dim is exactly 1024', () => {
      const p = factory();
      expect(p.dim).toBe(1024);
    });

    it('embed() returns Float32Array[] each length 1024', async () => {
      const p = factory();
      const results = await p.embed(['hello world', 'second text']);
      expect(Array.isArray(results)).toBe(true);
      expect(results).toHaveLength(2);
      for (const arr of results) {
        expect(arr).toBeInstanceOf(Float32Array);
        expect(arr.length).toBe(1024);
      }
    });

    it('embed() handles single text', async () => {
      const p = factory();
      const results = await p.embed(['single']);
      expect(results).toHaveLength(1);
      expect(results[0]).toBeInstanceOf(Float32Array);
      expect(results[0].length).toBe(1024);
    });

    it('health() returns {ok, model, dim}', async () => {
      const p = factory();
      const h = await p.health();
      expect(typeof h.ok).toBe('boolean');
      expect(typeof h.model).toBe('string');
      expect(typeof h.dim).toBe('number');
    });
  });
}
