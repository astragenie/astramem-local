import { describe, it, expect } from 'vitest';
import {
  LLM_PROVIDER_NAMES,
  LLM_PROVIDER_NAMES_DISPLAY,
  type LLMProviderName,
} from '../../src/contracts/llm.js';

// FEAT-536: guards the SINGLE source of truth for LLM provider names. If a
// provider is added/removed, it must happen HERE (LLM_PROVIDER_NAMES) and flow
// everywhere else automatically — this test pins the contract so a stray
// hand-copied literal re-introduction (the 9-site drift FEAT-536 removed) is
// caught, not silently diverged.
describe('LLM provider name single-source (FEAT-536)', () => {
  it('lists exactly the shipped providers', () => {
    expect([...LLM_PROVIDER_NAMES]).toEqual([
      'ollama',
      'azure-openai',
      'openai-compatible',
      'codex-subscription',
    ]);
  });

  it('derives the human-readable display string from the list (no hand-copy)', () => {
    // This is what every governance error message now interpolates — proving it
    // cannot drift from LLM_PROVIDER_NAMES.
    expect(LLM_PROVIDER_NAMES_DISPLAY).toBe(
      LLM_PROVIDER_NAMES.map((n) => `'${n}'`).join('|'),
    );
    expect(LLM_PROVIDER_NAMES_DISPLAY).toContain("'codex-subscription'");
  });

  it('every list entry is a valid LLMProviderName (type-level round-trip)', () => {
    for (const name of LLM_PROVIDER_NAMES) {
      const typed: LLMProviderName = name;
      expect(typeof typed).toBe('string');
    }
  });
});
