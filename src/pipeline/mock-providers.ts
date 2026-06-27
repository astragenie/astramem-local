/**
 * Mock providers for CI / integration testing.
 *
 * Used when ASTRA_MEMORY_MOCK_PROVIDERS=1 is set (or injected directly in tests).
 *
 * - MockLLMProvider: compaction returns the input text unchanged;
 *   extraction returns a single decision atom about 'sqlite-vec' when
 *   the text mentions it, otherwise an empty atoms list.
 * - MockEmbedProvider: deterministic 1024-float vector seeded from text hash.
 *   No network, no Ollama required.
 *
 * These mocks satisfy the LLMProvider / EmbedProvider contracts and make
 * the full 8-stage distillation pipeline runnable in CI.
 */

import { createHash } from 'node:crypto';
import type { LLMProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth } from '../contracts/llm.js';
import type { EmbedProvider, EmbedHealth } from '../contracts/embed.js';
import type { ProviderSet } from '../providers/index.js';

// ── Mock LLM ─────────────────────────────────────────────────────────────────

class MockLLMProvider implements LLMProvider {
  readonly name = 'ollama' as const;
  readonly model = 'mock-llm';

  async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
    const userContent = messages.find(m => m.role === 'user')?.content ?? '';

    // Detect extraction calls (json mode or system prompt contains "atoms")
    const systemContent = messages.find(m => m.role === 'system')?.content ?? '';
    const isExtraction = opts?.json === true || systemContent.includes('atoms');

    if (isExtraction) {
      // Return a valid ExtractionSchema JSON that the Zod validator will accept
      const mentionsSqliteVec = userContent.toLowerCase().includes('sqlite-vec') ||
        userContent.toLowerCase().includes('sqlite_vec');

      const atoms = mentionsSqliteVec
        ? [
            {
              type: 'decision',
              text: 'use sqlite-vec for v1 vector storage',
              importance: 0.9,
              confidence: 0.9,
              evidence: 'OK let\'s go with sqlite-vec'
            }
          ]
        : [];

      return {
        text: JSON.stringify({ atoms }),
        usage: { in: 10, out: 10, usd: 0 }
      };
    }

    // Compaction: return user content unchanged (preserves all decisions for extraction)
    return {
      text: userContent,
      usage: { in: 10, out: 10, usd: 0 }
    };
  }

  async health(): Promise<LLMHealth> {
    return { ok: true, model: this.model, latency_ms: 0 };
  }
}

// ── Mock Embed ────────────────────────────────────────────────────────────────

class MockEmbedProvider implements EmbedProvider {
  readonly name = 'ollama' as const;
  readonly model = 'mock-embed';
  readonly dim = 1024 as const;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(t => makeDeterministicVec(t));
  }

  async health(): Promise<EmbedHealth> {
    return { ok: true, model: this.model, dim: this.dim };
  }
}

/**
 * Deterministic 1024-dim vector seeded by text content hash.
 * Matches the approach used in search.ts makeFakeVec but uses SHA-256
 * for better distribution across similar texts.
 */
function makeDeterministicVec(text: string): Float32Array {
  const hash = createHash('sha256').update(text, 'utf8').digest();
  const v = new Float32Array(1024);
  // Seed each float from hash bytes cycling
  for (let i = 0; i < 1024; i++) {
    const b0 = hash[i % 32];
    const b1 = hash[(i + 1) % 32];
    // Normalize to [-1, 1]
    v[i] = ((b0 * 256 + b1) / 32767.5) - 1.0;
  }
  return v;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export type MockProviderSet = ProviderSet;

/**
 * Returns a ProviderSet backed entirely by mock providers.
 * Safe to call multiple times — each call returns fresh instances.
 */
export function makeMockProviders(): MockProviderSet {
  const llm = new MockLLMProvider();
  return {
    llm: {
      compaction: llm,
      extraction: llm,
    },
    embed: new MockEmbedProvider(),
  };
}
