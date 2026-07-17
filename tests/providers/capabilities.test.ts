import { describe, it, expect } from 'vitest';
import { LLM_PROVIDER_NAMES } from '../../src/contracts/llm.js';
import { LLM_STRUCTURED_OUTPUT_CAPABILITY, supportsJsonSchema } from '../../src/providers/llm/capabilities.js';

describe('LLM structured-output capability registry (FEAT-536 AC-4)', () => {
  it('has exactly one entry per LLM_PROVIDER_NAMES — no drift, no gap', () => {
    const registryKeys = Object.keys(LLM_STRUCTURED_OUTPUT_CAPABILITY).sort();
    expect(registryKeys).toEqual([...LLM_PROVIDER_NAMES].sort());
  });

  it('ollama and anthropic support jsonSchema; azure-openai/openai-compatible/codex-subscription do not', () => {
    expect(supportsJsonSchema('ollama')).toBe(true);
    expect(supportsJsonSchema('anthropic')).toBe(true);
    expect(supportsJsonSchema('azure-openai')).toBe(false);
    expect(supportsJsonSchema('openai-compatible')).toBe(false);
    expect(supportsJsonSchema('codex-subscription')).toBe(false);
  });

  it('classifies each provider into the correct capability bucket', () => {
    expect(LLM_STRUCTURED_OUTPUT_CAPABILITY.ollama).toBe('strict-schema');
    expect(LLM_STRUCTURED_OUTPUT_CAPABILITY.anthropic).toBe('tool-use');
    expect(LLM_STRUCTURED_OUTPUT_CAPABILITY['azure-openai']).toBe('json_object');
    expect(LLM_STRUCTURED_OUTPUT_CAPABILITY['openai-compatible']).toBe('json_object');
    expect(LLM_STRUCTURED_OUTPUT_CAPABILITY['codex-subscription']).toBe('json_object');
  });
});
