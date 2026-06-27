import type { LLMProvider } from '../contracts/llm.js';
import type { EmbedProvider } from '../contracts/embed.js';
import type { Config } from '../config/config.js';
import { OllamaLLMProvider } from './llm/ollama.js';
import { AzureOpenAILLMProvider } from './llm/azure-openai.js';
import { OllamaEmbedProvider } from './embed/ollama.js';
import { AzureOpenAIEmbedProvider } from './embed/azure-openai.js';

export interface ProviderSet {
  llm: {
    compaction: LLMProvider;
    extraction: LLMProvider;
  };
  embed: EmbedProvider;
}

/**
 * Resolve Azure credentials from environment if not present in config.
 * AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT are
 * the conventional env vars for Azure OpenAI.
 */
function resolveAzureApiKey(): string {
  const key = process.env.AZURE_OPENAI_API_KEY ?? '';
  if (!key) {
    throw new Error(
      'Azure OpenAI provider selected but AZURE_OPENAI_API_KEY env var is not set',
    );
  }
  return key;
}

function buildLLMProvider(
  providerName: 'ollama' | 'azure-openai',
  model: string,
  config: Config,
): LLMProvider {
  if (providerName === 'ollama') {
    return new OllamaLLMProvider({ baseUrl: config.ollama.baseUrl, model });
  }

  const endpoint = config.azure.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      'Azure OpenAI LLM provider selected but no endpoint configured. ' +
        'Set config.azure.endpoint or AZURE_OPENAI_ENDPOINT env var.',
    );
  }
  const deployment = config.azure.deployment ?? model;
  return new AzureOpenAILLMProvider({
    endpoint,
    deployment,
    apiKey: resolveAzureApiKey(),
    apiVersion: config.azure.apiVersion,
    model,
  });
}

function buildEmbedProvider(config: Config): EmbedProvider {
  const { provider, model } = config.embedding;

  if (provider === 'ollama') {
    return new OllamaEmbedProvider({ baseUrl: config.ollama.baseUrl, model });
  }

  const endpoint = config.azure.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      'Azure OpenAI embed provider selected but no endpoint configured. ' +
        'Set config.azure.endpoint or AZURE_OPENAI_ENDPOINT env var.',
    );
  }
  const deployment = config.azure.deployment ?? model;
  return new AzureOpenAIEmbedProvider({
    endpoint,
    deployment,
    apiKey: resolveAzureApiKey(),
    apiVersion: config.azure.apiVersion,
    model,
  });
}

/**
 * Factory: given config, return {llm: {compaction, extraction}, embed} instances.
 *
 * Provider selection driven by:
 *   config.llm.compaction.provider  + config.llm.compaction.model
 *   config.llm.extraction.provider  + config.llm.extraction.model
 *   config.embedding.provider       + config.embedding.model
 */
export function getProviders(config: Config): ProviderSet {
  return {
    llm: {
      compaction: buildLLMProvider(
        config.llm.compaction.provider,
        config.llm.compaction.model,
        config,
      ),
      extraction: buildLLMProvider(
        config.llm.extraction.provider,
        config.llm.extraction.model,
        config,
      ),
    },
    embed: buildEmbedProvider(config),
  };
}
