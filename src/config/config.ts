import { defaultDataDir } from './datadir.js';

export interface Config {
  port: number;
  dataDir: string;
  llm: {
    compaction: { provider: 'ollama' | 'azure-openai'; model: string };
    extraction: { provider: 'ollama' | 'azure-openai'; model: string };
  };
  embedding: {
    provider: 'ollama' | 'azure-openai';
    model: string;
    dim: 1024;
  };
  vector: { store: 'sqlite-vec' | 'lancedb' };
  budget: { daily_usd: number };
  ollama: { baseUrl: string };
  azure: { endpoint?: string; deployment?: string; apiVersion: string };
  search: { alpha: number; beta: number; gamma: number; delta: number };
  recallPack: { enabled: boolean; budgetTokens: number };
  security: {
    redaction: {
      enabled: boolean;
      /** Shannon-entropy threshold in bits/char for the fallback secret detector. */
      entropyThreshold: number;
      /** Org-specific regex sources applied as detector type 'custom'. */
      customPatterns: string[];
    };
    /** Encryption at rest (SEC-1/2/7/9). Disabling is a deliberate trust
     * trade-off — the daemon logs a prominent WARN at startup (AC-6). */
    encryption: {
      enabled: boolean;
    };
  };
}

export function defaultConfig(): Config {
  return {
    port: 7777,
    dataDir: defaultDataDir(),
    llm: {
      compaction: { provider: 'ollama', model: 'qwen2.5-coder:7b' },
      extraction: { provider: 'ollama', model: 'qwen2.5-coder:7b' }
    },
    embedding: { provider: 'ollama', model: 'mxbai-embed-large', dim: 1024 },
    vector: { store: 'sqlite-vec' },
    budget: { daily_usd: 10 },
    ollama: { baseUrl: 'http://127.0.0.1:11434' },
    azure: { apiVersion: '2024-10-21' },
    search: { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1 },
    recallPack: { enabled: false, budgetTokens: 1500 },
    security: {
      redaction: { enabled: true, entropyThreshold: 4.0, customPatterns: [] },
      encryption: { enabled: true }
    }
  };
}

export function loadConfig(overrides: Partial<Config> | undefined): Config {
  const base = defaultConfig();
  if (!overrides) return base;
  return { ...base, ...overrides };
}
