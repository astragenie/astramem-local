/**
 * Mock providers for CI / integration testing.
 *
 * Used when ASTRA_MEMORY_MOCK_PROVIDERS=1 is set (or injected directly in tests).
 *
 * - MockLLMProvider: compaction returns the input text unchanged;
 *   extraction checks a small deterministic keyword table (see below) and
 *   returns one atom per matched keyword, or an empty atoms list if none match.
 * - MockEmbedProvider: deterministic vector (dim defaults to
 *   DEFAULT_EMBED_DIM = 1024, configurable) seeded from text hash. No
 *   network, no Ollama required.
 *
 * These mocks satisfy the LLMProvider / EmbedProvider contracts and make
 * the full 8-stage distillation pipeline runnable in CI.
 *
 * TEST-ONLY deterministic extraction vocabulary (SLICE-SMOKE-1 orchestrator
 * decision, 2026-07-04: extending this file additively was approved as a
 * relaxation of "no product-code changes" for test-double code specifically
 * — see the smoke-suite run brief. Exclusively consumed by
 * tests/smoke/_fixtures/session-canonical.json; fixture and this table must
 * stay in lockstep, and this file is never reachable outside
 * ASTRA_MEMORY_MOCK_PROVIDERS=1 (CI/test only — real serving never sets it).
 * Each row is an independent case-insensitive substring match against the
 * full extraction input; matching keywords each append one fixed atom (no
 * parsing, no branching beyond the match itself):
 *
 *   trigger keyword              -> atom type -> entity emitted
 *   ---------------------------------------------------------------------
 *   "sqlite-vec" / "sqlite_vec"  -> decision   -> none (ORIGINAL, unchanged
 *                                                 byte-for-byte since before
 *                                                 SLICE-SMOKE-1)
 *   "priya nair"                 -> fact       -> person: "Priya Nair"
 *   "astramemory-local"          -> fact       -> repo: "astramemory-local"
 *   "typescript"                 -> fact       -> tech: "TypeScript"
 *   "todo:"                      -> todo       -> none
 *   "prefers markdown summaries" -> note       -> none (closest valid
 *                                                 MemoryType — the schema
 *                                                 has no 'preference' type)
 */

import { createHash } from 'node:crypto';
import type { LLMProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth } from '../contracts/llm.js';
import type { EmbedProvider, EmbedHealth } from '../contracts/embed.js';
import { DEFAULT_EMBED_DIM } from '../contracts/embed.js';
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
      // Return a valid ExtractionSchema JSON that the Zod validator will accept.
      // See the file-header keyword table — each check below is independent
      // and additive; the sqlite-vec case is byte-identical to the original.
      const lower = userContent.toLowerCase();
      const atoms: Array<{
        type: string; text: string; importance: number; confidence: number;
        evidence?: string; entities?: Array<{ name: string; kind: string }>;
      }> = [];

      // ORIGINAL — unchanged since before SLICE-SMOKE-1.
      if (lower.includes('sqlite-vec') || lower.includes('sqlite_vec')) {
        atoms.push({
          type: 'decision',
          text: 'use sqlite-vec for v1 vector storage',
          importance: 0.9,
          confidence: 0.9,
          evidence: 'OK let\'s go with sqlite-vec',
        });
      }

      if (lower.includes('priya nair')) {
        atoms.push({
          type: 'fact',
          text: 'Priya Nair is the designated reviewer for this work',
          importance: 0.5,
          confidence: 0.8,
          entities: [{ name: 'Priya Nair', kind: 'person' }],
        });
      }

      if (lower.includes('astramemory-local')) {
        atoms.push({
          type: 'fact',
          text: 'This work belongs to the astramemory-local repo',
          importance: 0.5,
          confidence: 0.8,
          entities: [{ name: 'astramemory-local', kind: 'repo' }],
        });
      }

      if (lower.includes('typescript')) {
        atoms.push({
          type: 'fact',
          text: 'This project is written in TypeScript',
          importance: 0.5,
          confidence: 0.8,
          entities: [{ name: 'TypeScript', kind: 'tech' }],
        });
      }

      if (lower.includes('todo:')) {
        atoms.push({
          type: 'todo',
          text: 'Write a migration guide before shipping',
          importance: 0.6,
          confidence: 0.8,
        });
      }

      if (lower.includes('prefers markdown summaries')) {
        atoms.push({
          type: 'note',
          text: 'Prefers markdown-formatted memory summaries',
          importance: 0.4,
          confidence: 0.7,
        });
      }

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
  readonly dim: number;

  constructor(dim: number = DEFAULT_EMBED_DIM) {
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(t => makeDeterministicVec(t, this.dim));
  }

  async health(): Promise<EmbedHealth> {
    return { ok: true, model: this.model, dim: this.dim };
  }
}

/**
 * Deterministic vector seeded by text content hash, dim defaults to
 * DEFAULT_EMBED_DIM (1024) — pass `dim` for a non-default schema (FEAT-409
 * AC-2). Matches the approach used in search.ts makeFakeVec but uses
 * SHA-256 for better distribution across similar texts.
 */
function makeDeterministicVec(text: string, dim: number = DEFAULT_EMBED_DIM): Float32Array {
  const hash = createHash('sha256').update(text, 'utf8').digest();
  const v = new Float32Array(dim);
  // Seed each float from hash bytes cycling
  for (let i = 0; i < dim; i++) {
    const b0 = hash[i % 32] ?? 0;
    const b1 = hash[(i + 1) % 32] ?? 0;
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
 * `dim` defaults to DEFAULT_EMBED_DIM (1024); pass e.g. cfg.embedding.dim
 * to exercise a non-default dim under ASTRA_MEMORY_MOCK_PROVIDERS=1
 * (FEAT-409 AC-2).
 */
export function makeMockProviders(dim: number = DEFAULT_EMBED_DIM): MockProviderSet {
  const llm = new MockLLMProvider();
  return {
    llm: {
      compaction: llm,
      extraction: llm,
    },
    embed: new MockEmbedProvider(dim),
  };
}
