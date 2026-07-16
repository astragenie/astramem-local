import { describe, it, expect } from 'vitest';
import { getProviders } from '../../src/providers/index.js';
import { defaultConfig, type Config } from '../../src/config/config.js';

// 2026-07-16 operator request: contradiction-judge provider/model override.
// The judge previously ALWAYS rode llm.extraction (deliberate FEAT-456
// decision, revisited at explicit operator request) — these pin the new
// resolution rules in getProviders.
describe('getProviders — contradiction judge resolution', () => {
  function cfgWith(cd: Partial<Config['consolidation']['contradictionDetection']>): Config {
    const cfg = defaultConfig();
    // Local providers only — the Azure fall-through throws without an
    // endpoint, and this test must never depend on env creds.
    cfg.llm.extraction = { provider: 'ollama', model: 'extract-model' };
    cfg.llm.compaction = { provider: 'ollama', model: 'compact-model' };
    cfg.consolidation.contradictionDetection = {
      ...cfg.consolidation.contradictionDetection,
      ...cd,
    };
    return cfg;
  }

  it('no override → judge IS the extraction instance (identity, shared rate-limit bucket)', () => {
    const p = getProviders(cfgWith({}));
    expect(p.llm.judge).toBe(p.llm.extraction);
  });

  it('model-only override → distinct provider, extraction provider kind, overridden model', () => {
    const p = getProviders(cfgWith({ model: 'judge-model' }));
    expect(p.llm.judge).not.toBe(p.llm.extraction);
    expect(p.llm.judge!.model).toBe('judge-model');
    expect(p.llm.judge!.name).toBe(p.llm.extraction.name);
  });

  it('provider+model override → fully independent judge provider', () => {
    const cfg = cfgWith({ provider: 'codex-subscription', model: 'judge-model' });
    const p = getProviders(cfg);
    expect(p.llm.judge).not.toBe(p.llm.extraction);
    expect(p.llm.judge!.name).toBe('codex-subscription');
    expect(p.llm.judge!.model).toBe('judge-model');
    // extraction untouched
    expect(p.llm.extraction.name).toBe('ollama');
    expect(p.llm.extraction.model).toBe('extract-model');
  });

  it('provider-only override → overridden provider kind, extraction model name', () => {
    const p = getProviders(cfgWith({ provider: 'codex-subscription' }));
    expect(p.llm.judge!.name).toBe('codex-subscription');
    expect(p.llm.judge!.model).toBe('extract-model');
  });
});
