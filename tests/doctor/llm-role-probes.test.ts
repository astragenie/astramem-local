/**
 * tests/doctor/llm-role-probes.test.ts
 *
 * Wave 1 (BYO providers): doctor's LLM chat probe loop (checks/index.ts) was
 * hardcoded to exactly two roles (compaction, extraction) — a BYO provider
 * assigned to the judge/extractionPassB/atomTriage role (FEAT-456/534/533
 * overrides) never got probed at all, even though `getProviders` always
 * builds all five. This file proves the generalized role loop: every role
 * supplied on `opts.llmProviders` gets its own "LLM chat probe (<role>)"
 * check, in a fixed order, with same-provider (name+model) roles deduped —
 * and that the pre-Wave-1 two-role shape is byte-identical to before.
 */
import { describe, it, expect } from 'vitest';
import { getChecks } from '../../src/doctor/checks.js';
import type { LLMProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth } from '../../src/contracts/llm.js';

function mockProvider(name: LLMProvider['name'], model: string): LLMProvider {
  return {
    name,
    model,
    async chat(_msgs: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
      return { text: '{"ok":true}', usage: { in: 1, out: 1, usd: 0 } };
    },
    async health(): Promise<LLMHealth> {
      return { ok: true, model, latency_ms: 0 };
    },
  };
}

function chatProbeNames(checks: { name: string }[]): string[] {
  return checks.filter((c) => c.name.startsWith('LLM chat probe')).map((c) => c.name);
}

describe('doctor LLM chat probe — per-role loop (Wave 1)', () => {
  it('pre-Wave-1 shape: compaction + extraction (different models) both get probed, in order', () => {
    const checks = getChecks({
      dataDir: ':memory:',
      llmProviders: {
        compaction: mockProvider('ollama', 'model-a'),
        extraction: mockProvider('ollama', 'model-b'),
      },
    });
    expect(chatProbeNames(checks)).toEqual([
      'LLM chat probe (compaction)',
      'LLM chat probe (extraction)',
    ]);
  });

  it('pre-Wave-1 shape: compaction + extraction sharing the same provider+model only probes once (unchanged dedup)', () => {
    const shared = mockProvider('codex-subscription', 'gpt-5.4-mini');
    const checks = getChecks({
      dataDir: ':memory:',
      llmProviders: { compaction: shared, extraction: shared },
    });
    expect(chatProbeNames(checks)).toEqual(['LLM chat probe (compaction)']);
  });

  it('probes judge, extractionPassB, and atomTriage when all five roles are configured with distinct providers', () => {
    const checks = getChecks({
      dataDir: ':memory:',
      llmProviders: {
        compaction: mockProvider('codex-subscription', 'gpt-5.4-mini'),
        extraction: mockProvider('ollama', 'qwen2.5:7b'),
        judge: mockProvider('anthropic', 'claude-sonnet-4-5-20250929'),
        extractionPassB: mockProvider('openai-compatible', 'llama-3.3-70b-versatile'),
        atomTriage: mockProvider('azure-openai', 'gpt-4.1'),
      },
    });
    expect(chatProbeNames(checks)).toEqual([
      'LLM chat probe (compaction)',
      'LLM chat probe (extraction)',
      'LLM chat probe (judge)',
      'LLM chat probe (extractionPassB)',
      'LLM chat probe (atomTriage)',
    ]);
  });

  it('dedupes a role sharing the same provider name+model as an earlier-listed role, keeping the earliest label', () => {
    const anthropicKey = mockProvider('anthropic', 'claude-sonnet-4-5-20250929');
    const checks = getChecks({
      dataDir: ':memory:',
      llmProviders: {
        compaction: mockProvider('ollama', 'qwen2.5:7b'),
        extraction: mockProvider('ollama', 'qwen2.5:7b'), // same as compaction -> deduped
        judge: anthropicKey,
        extractionPassB: anthropicKey, // same instance as judge -> deduped
        atomTriage: mockProvider('anthropic', 'claude-sonnet-4-5-20250929'), // same name+model, different instance -> still deduped
      },
    });
    expect(chatProbeNames(checks)).toEqual([
      'LLM chat probe (compaction)',
      'LLM chat probe (judge)',
    ]);
  });

  it('omits judge/extractionPassB/atomTriage probes entirely when those overrides are not configured', () => {
    const checks = getChecks({
      dataDir: ':memory:',
      llmProviders: {
        compaction: mockProvider('ollama', 'model-a'),
        extraction: mockProvider('ollama', 'model-b'),
        // judge/extractionPassB/atomTriage left undefined — mirrors every
        // pre-Wave-1 caller (serve.ts still only forwards these two today).
      },
    });
    expect(chatProbeNames(checks)).toEqual([
      'LLM chat probe (compaction)',
      'LLM chat probe (extraction)',
    ]);
  });
});
