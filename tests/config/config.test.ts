import { describe, it, expect } from 'vitest';
import { loadConfig, defaultConfig } from '../../src/config/config.js';

describe('loadConfig', () => {
  it('returns defaults when no file present', () => {
    const cfg = loadConfig(undefined);
    expect(cfg.port).toBe(7777);
    expect(cfg.embedding.provider).toBe('ollama');
    expect(cfg.budget.daily_usd).toBe(10);
  });

  it('overrides defaults from passed object', () => {
    const cfg = loadConfig({ port: 8888 } as any);
    expect(cfg.port).toBe(8888);
    expect(cfg.embedding.provider).toBe('ollama');
  });
});
