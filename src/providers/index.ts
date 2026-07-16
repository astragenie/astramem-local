import { join } from 'node:path';
import type { LLMProvider } from '../contracts/llm.js';
import type { EmbedProvider } from '../contracts/embed.js';
import { resolveEmbedQueryPrefix } from '../contracts/embed.js';
import type { Config } from '../config/config.js';
import { OllamaLLMProvider } from './llm/ollama.js';
import { AzureOpenAILLMProvider } from './llm/azure-openai.js';
import { OpenAICompatibleLLMProvider } from './llm/openai-compatible.js';
import { CodexSubscriptionLLMProvider } from './llm/codex-subscription.js';
import { rateLimitLLMProvider } from './llm/rate-limited.js';
import { OllamaEmbedProvider } from './embed/ollama.js';
import { AzureOpenAIEmbedProvider } from './embed/azure-openai.js';
import { OnnxWorkerHostProvider } from './embed/onnx-worker-host.js';

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

// Exported (not just module-local) so WS6's query decomposer
// (src/search/decompose.ts) can build a one-off LLMProvider from
// config.llm.extraction without a second provider-selection surface —
// see resolveDecomposeOpts's doc comment.
export function buildLLMProvider(
  providerName: Config['llm']['compaction']['provider'],
  model: string,
  config: Config,
): LLMProvider {
  // Apply the optional daemon-side call-rate limiter around whichever concrete
  // provider we build (token bucket SHARED per provider name — see
  // rateLimitLLMProvider). Disabled (pass-through) unless llm.rateLimit is set.
  return rateLimitLLMProvider(
    buildRawLLMProvider(providerName, model, config),
    config.llm.rateLimit?.callsPerMinute,
  );
}

function buildRawLLMProvider(
  providerName: Config['llm']['compaction']['provider'],
  model: string,
  config: Config,
): LLMProvider {
  if (providerName === 'ollama') {
    return new OllamaLLMProvider({ baseUrl: config.ollama.baseUrl, model });
  }

  if (providerName === 'openai-compatible') {
    const baseUrl = config.openaiCompatible.baseUrl;
    if (!baseUrl) {
      throw new Error(
        'openai-compatible LLM provider selected but no base_url configured. ' +
          'Set config.openaiCompatible.baseUrl.',
      );
    }
    const apiKeyEnv = config.openaiCompatible.apiKeyEnv || 'OPENAI_COMPAT_API_KEY';
    const apiKey = process.env[apiKeyEnv] || undefined;
    return new OpenAICompatibleLLMProvider({ baseUrl, model, apiKey });
  }

  if (providerName === 'codex-subscription') {
    // No construction-time throw here — auth.json is loaded lazily on first
    // chat()/health() call (see codex-subscription.ts's ensureAuthLoaded doc
    // comment) so selecting this provider without having run `codex login`
    // yet doesn't crash daemon boot the way a missing Azure endpoint does.
    return new CodexSubscriptionLLMProvider({ model, authPath: config.codexSubscription.authPath });
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

/**
 * ADR-018 S2 (was deferred; forced by the 2026-07-16 prod embed outage):
 * default the ONNX weight cache to a STABLE per-install location
 * (`<dataDir>/models/onnx/`) instead of the library's own default, which
 * lives INSIDE the release directory's node_modules — release rotation
 * (`reinstall` keeps only the newest 2) silently discards it, and the next
 * boot re-downloads ~337MB or, offline, dies. `:memory:` (throwaway test
 * state) keeps the library default — no stable install dir exists to
 * anchor to. Exported for direct unit coverage (#363 review follow-up:
 * this conditional carried the fix's release-rotation rationale with no
 * regression guard).
 */
export function resolveOnnxCacheDir(
  config: Pick<Config, 'dataDir'> & { onnxEmbed?: { cacheDir?: string } },
): string | undefined {
  return (
    config.onnxEmbed?.cacheDir ??
    (config.dataDir === ':memory:' ? undefined : join(config.dataDir, 'models', 'onnx'))
  );
}

function buildEmbedProvider(config: Config): EmbedProvider {
  const { provider, model, dim } = config.embedding;
  // RECALL-S1: resolved once here (the ONE place an EmbedProvider is built
  // from config) — never computed ad hoc at a call site. See
  // resolveEmbedQueryPrefix's doc (src/contracts/embed.ts) for the
  // override-vs-built-in-map precedence.
  const queryPrefix = resolveEmbedQueryPrefix(model, config.embedding.queryPrefix);

  if (provider === 'ollama') {
    return new OllamaEmbedProvider({ baseUrl: config.ollama.baseUrl, model, dim, queryPrefix });
  }

  if (provider === 'onnx') {
    // ADR-018 SLICE-1 (config shape) + ADR-019 Decision 2(d) (worker
    // offload): opt-in ONNX embedder. `model`/`dim`/`queryPrefix` come from
    // config.embedding same as the other two providers; the onnx-specific
    // knobs (cache/model path, thread cap, dtype) come from the separate
    // config.onnxEmbed block since they have no Ollama/Azure equivalent.
    // `OnnxWorkerHostProvider` runs the actual ORT session.run() call on a
    // dedicated worker_thread instead of the daemon's main event loop — see
    // onnx-worker-host.ts's doc comment and
    // .claude/artifacts/crew/validations/20260715T000000Z-validation-onnx-embed-event-loop-block.md
    // for why this is required, not optional, before onnx can safely be the
    // default embedding provider.
    return new OnnxWorkerHostProvider({
      model,
      dim,
      queryPrefix,
      // Stable per-install cache — see resolveOnnxCacheDir's doc comment.
      cacheDir: resolveOnnxCacheDir(config),
      modelPath: config.onnxEmbed?.modelPath,
      numThreads: config.onnxEmbed?.numThreads,
      dtype: config.onnxEmbed?.dtype,
      // ADR-018 SLICE-5: unset defers to OnnxEmbedProvider's own
      // ONNX_MODEL_REGISTRY resolution keyed on `model` — see onnx.ts.
      pooling: config.onnxEmbed?.pooling,
    });
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
    dim,
    queryPrefix,
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
