import { describe, it, expect } from 'vitest';
import {
  OPENAI_COMPAT_PRESETS,
  OPENAI_COMPAT_PRESET_NAMES,
  getOpenAICompatPreset,
} from '../../src/providers/llm/byo-presets.js';

describe('byo-presets (Wave 1)', () => {
  it('ships exactly the four spiked presets', () => {
    expect(OPENAI_COMPAT_PRESET_NAMES.sort()).toEqual(['deepseek', 'gemini', 'groq', 'kimi'].sort());
  });

  it.each(OPENAI_COMPAT_PRESET_NAMES)('%s has a well-formed baseUrl, defaultModel, and apiKeyEnv', (name) => {
    const preset = getOpenAICompatPreset(name);
    expect(preset.baseUrl).toMatch(/^https:\/\//);
    expect(preset.defaultModel.length).toBeGreaterThan(0);
    expect(preset.apiKeyEnv).toMatch(/^[A-Z0-9_]+$/);
    expect(preset.capabilities.auth).toBe('bearer');
    expect(['confirmed', 'partial']).toContain(preset.capabilities.jsonObjectMode);
  });

  it('every preset\'s apiKeyEnv is distinct — switching presets never silently reuses a stale key var', () => {
    const envVars = OPENAI_COMPAT_PRESET_NAMES.map((n) => OPENAI_COMPAT_PRESETS[n].apiKeyEnv);
    expect(new Set(envVars).size).toBe(envVars.length);
  });

  it('gemini is the one preset marked partial (not confirmed) for json_object mode on the sync endpoint', () => {
    expect(OPENAI_COMPAT_PRESETS.gemini.capabilities.jsonObjectMode).toBe('partial');
    for (const name of ['groq', 'kimi', 'deepseek'] as const) {
      expect(OPENAI_COMPAT_PRESETS[name].capabilities.jsonObjectMode).toBe('confirmed');
    }
  });

  it('groq and kimi are flagged as having migrated to max_completion_tokens; deepseek and gemini still use max_tokens', () => {
    expect(OPENAI_COMPAT_PRESETS.groq.capabilities.maxTokensParam).toBe('max_completion_tokens');
    expect(OPENAI_COMPAT_PRESETS.kimi.capabilities.maxTokensParam).toBe('max_completion_tokens');
    expect(OPENAI_COMPAT_PRESETS.deepseek.capabilities.maxTokensParam).toBe('max_tokens');
    expect(OPENAI_COMPAT_PRESETS.gemini.capabilities.maxTokensParam).toBe('max_tokens');
  });

  it('getOpenAICompatPreset returns the same object as the registry lookup', () => {
    expect(getOpenAICompatPreset('groq')).toBe(OPENAI_COMPAT_PRESETS.groq);
  });
});
