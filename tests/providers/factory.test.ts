import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getProviders } from '../../src/providers/index.js';
import { defaultConfig } from '../../src/config/config.js';
import type { Config } from '../../src/config/config.js';
import { OllamaLLMProvider } from '../../src/providers/llm/ollama.js';
import { OllamaEmbedProvider } from '../../src/providers/embed/ollama.js';
import { AzureOpenAILLMProvider } from '../../src/providers/llm/azure-openai.js';
import { AzureOpenAIEmbedProvider } from '../../src/providers/embed/azure-openai.js';

function azureConfig(overrides: Partial<Config> = {}): Config {
  const base = defaultConfig();
  return {
    ...base,
    azure: {
      endpoint: 'https://test.openai.azure.com',
      deployment: 'gpt-4.1',
      apiVersion: '2024-10-21',
    },
    ...overrides,
  };
}

describe('getProviders factory', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Set a fake key so Azure providers can be constructed without throwing
    process.env.AZURE_OPENAI_API_KEY = 'fake-key-for-test';
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
  });

  it('returns OllamaLLMProvider for compaction when config.llm.compaction.provider=ollama', () => {
    const cfg = defaultConfig();
    cfg.llm.compaction.provider = 'ollama';
    const { llm } = getProviders(cfg);
    expect(llm.compaction).toBeInstanceOf(OllamaLLMProvider);
  });

  it('returns OllamaLLMProvider for extraction when config.llm.extraction.provider=ollama', () => {
    const cfg = defaultConfig();
    cfg.llm.extraction.provider = 'ollama';
    const { llm } = getProviders(cfg);
    expect(llm.extraction).toBeInstanceOf(OllamaLLMProvider);
  });

  it('returns OllamaEmbedProvider when config.embedding.provider=ollama', () => {
    const cfg = defaultConfig();
    cfg.embedding.provider = 'ollama';
    const { embed } = getProviders(cfg);
    expect(embed).toBeInstanceOf(OllamaEmbedProvider);
  });

  it('returns AzureOpenAILLMProvider for compaction when config.llm.compaction.provider=azure-openai', () => {
    const cfg = azureConfig();
    cfg.llm.compaction.provider = 'azure-openai';
    cfg.llm.compaction.model = 'gpt-4.1';
    cfg.llm.extraction.provider = 'ollama'; // keep extraction as ollama to avoid embed config needed
    const { llm } = getProviders(cfg);
    expect(llm.compaction).toBeInstanceOf(AzureOpenAILLMProvider);
    expect(llm.compaction.name).toBe('azure-openai');
  });

  it('returns AzureOpenAILLMProvider for extraction when config.llm.extraction.provider=azure-openai', () => {
    const cfg = azureConfig();
    cfg.llm.extraction.provider = 'azure-openai';
    cfg.llm.extraction.model = 'gpt-4.1-mini';
    const { llm } = getProviders(cfg);
    expect(llm.extraction).toBeInstanceOf(AzureOpenAILLMProvider);
    expect(llm.extraction.model).toBe('gpt-4.1-mini');
  });

  it('returns AzureOpenAIEmbedProvider when config.embedding.provider=azure-openai', () => {
    const cfg = azureConfig();
    cfg.embedding.provider = 'azure-openai';
    cfg.embedding.model = 'text-embedding-3-small';
    const { embed } = getProviders(cfg);
    expect(embed).toBeInstanceOf(AzureOpenAIEmbedProvider);
    expect(embed.name).toBe('azure-openai');
  });

  it('compaction and extraction can be different providers', () => {
    const cfg = azureConfig();
    cfg.llm.compaction.provider = 'ollama';
    cfg.llm.extraction.provider = 'azure-openai';
    cfg.llm.extraction.model = 'gpt-4.1-mini';
    const { llm } = getProviders(cfg);
    expect(llm.compaction).toBeInstanceOf(OllamaLLMProvider);
    expect(llm.extraction).toBeInstanceOf(AzureOpenAILLMProvider);
  });

  it('provider models match config', () => {
    const cfg = defaultConfig();
    cfg.llm.compaction.model = 'llama3:8b';
    cfg.llm.extraction.model = 'phi3:mini';
    cfg.embedding.model = 'nomic-embed-text-v2-moe';
    const providers = getProviders(cfg);
    expect(providers.llm.compaction.model).toBe('llama3:8b');
    expect(providers.llm.extraction.model).toBe('phi3:mini');
    expect(providers.embed.model).toBe('nomic-embed-text-v2-moe');
  });

  it('throws when azure-openai selected but AZURE_OPENAI_API_KEY missing', () => {
    delete process.env.AZURE_OPENAI_API_KEY;
    const cfg = azureConfig();
    cfg.llm.compaction.provider = 'azure-openai';
    expect(() => getProviders(cfg)).toThrow(/AZURE_OPENAI_API_KEY/);
  });

  it('throws when azure-openai selected but no endpoint configured', () => {
    const cfg = defaultConfig(); // no azure.endpoint set
    cfg.llm.compaction.provider = 'azure-openai';
    cfg.llm.compaction.model = 'gpt-4.1';
    delete process.env.AZURE_OPENAI_ENDPOINT;
    expect(() => getProviders(cfg)).toThrow(/endpoint/i);
  });

  it('embed dim is 1024 regardless of provider', () => {
    const ollamaCfg = defaultConfig();
    const { embed: ollamaEmbed } = getProviders(ollamaCfg);
    expect(ollamaEmbed.dim).toBe(1024);

    const azureCfg2 = azureConfig();
    azureCfg2.embedding.provider = 'azure-openai';
    const { embed: azureEmbed } = getProviders(azureCfg2);
    expect(azureEmbed.dim).toBe(1024);
  });
});
