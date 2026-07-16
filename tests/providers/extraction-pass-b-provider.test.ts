import { describe, it, expect } from 'vitest';
import { getProviders } from '../../src/providers/index.js';
import { defaultConfig, type Config } from '../../src/config/config.js';

// FEAT-534: per-pass extraction provider override. Mirrors
// tests/providers/judge-provider.test.ts exactly — same identity-default
// resolution shape (ProviderSet.llm.judge), just for
// distill.extractionPassB instead of consolidation.contradictionDetection.
describe('getProviders — extraction pass-B resolution', () => {
  function cfgWith(passB: Config['distill']['extractionPassB']): Config {
    const cfg = defaultConfig();
    // Local providers only — the Azure fall-through throws without an
    // endpoint, and this test must never depend on env creds.
    cfg.llm.extraction = { provider: 'ollama', model: 'extract-model' };
    cfg.llm.compaction = { provider: 'ollama', model: 'compact-model' };
    cfg.distill = { ...cfg.distill, extractionPassB: passB };
    return cfg;
  }

  it('no override → extractionPassB IS the extraction instance (identity, shared rate-limit bucket)', () => {
    const p = getProviders(cfgWith(undefined));
    expect(p.llm.extractionPassB).toBe(p.llm.extraction);
  });

  it('model-only override → distinct provider, extraction provider kind, overridden model', () => {
    const p = getProviders(cfgWith({ model: 'qwen3:8b' }));
    expect(p.llm.extractionPassB).not.toBe(p.llm.extraction);
    expect(p.llm.extractionPassB!.model).toBe('qwen3:8b');
    expect(p.llm.extractionPassB!.name).toBe(p.llm.extraction.name);
  });

  it('provider+model override → fully independent pass-B provider', () => {
    const cfg = cfgWith({ provider: 'codex-subscription', model: 'gpt-5.4-mini' });
    const p = getProviders(cfg);
    expect(p.llm.extractionPassB).not.toBe(p.llm.extraction);
    expect(p.llm.extractionPassB!.name).toBe('codex-subscription');
    expect(p.llm.extractionPassB!.model).toBe('gpt-5.4-mini');
    // extraction (pass A) untouched
    expect(p.llm.extraction.name).toBe('ollama');
    expect(p.llm.extraction.model).toBe('extract-model');
  });

  it('provider-only override → overridden provider kind, extraction model name', () => {
    const p = getProviders(cfgWith({ provider: 'codex-subscription' }));
    expect(p.llm.extractionPassB!.name).toBe('codex-subscription');
    expect(p.llm.extractionPassB!.model).toBe('extract-model');
  });
});
