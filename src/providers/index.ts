import { join } from 'node:path';
import type { LLMProvider } from '../contracts/llm.js';
import type { EmbedProvider } from '../contracts/embed.js';
import { resolveEmbedQueryPrefix } from '../contracts/embed.js';
import type { Config } from '../config/config.js';
import { resolveExtractionPassBTuning } from '../config/config.js';
import { OllamaLLMProvider } from './llm/ollama.js';
import { AzureOpenAILLMProvider } from './llm/azure-openai.js';
import { OpenAICompatibleLLMProvider } from './llm/openai-compatible.js';
import { CodexSubscriptionLLMProvider } from './llm/codex-subscription.js';
import { AnthropicLLMProvider } from './llm/anthropic.js';
import { rateLimitLLMProvider } from './llm/rate-limited.js';
import { trackProviderHealth } from './llm/health-tracking.js';
import { wrapWithQuotaBreaker } from './llm/quota-breaker.js';
import { OllamaEmbedProvider } from './embed/ollama.js';
import { AzureOpenAIEmbedProvider } from './embed/azure-openai.js';
import { OnnxWorkerHostProvider } from './embed/onnx-worker-host.js';

export interface ProviderSet {
  llm: {
    compaction: LLMProvider;
    extraction: LLMProvider;
    /** Contradiction judge (FEAT-456). `getProviders` ALWAYS sets it: the
     * SAME INSTANCE as `extraction` when no override is configured
     * (identity — shared rate-limit bucket, byte-identical pre-override
     * behavior), or a distinct provider built from
     * `consolidation.contradictionDetection.{provider,model}`. Optional in
     * the TYPE only so hand-built test ProviderSets stay valid — consumers
     * fall back with `judge ?? extraction`, which is exactly the
     * pre-override behavior. */
    judge?: LLMProvider;
    /** Per-pass extraction provider override (FEAT-534). `getProviders`
     * ALWAYS sets it, mirroring `judge` above exactly: the SAME INSTANCE as
     * `extraction` when no `distill.extractionPassB` override is configured
     * (identity — shared rate-limit bucket, byte-identical pre-override
     * behavior), or a distinct provider built from
     * `distill.extractionPassB.{provider,model}`. Optional in the TYPE only
     * so hand-built test ProviderSets stay valid — consumers fall back with
     * `extractionPassB ?? extraction`, exactly the pre-override behavior.
     * Only meaningful when `distill.extractionPasses: 2` — pipeline.ts
     * ignores it entirely on single-pass. */
    extractionPassB?: LLMProvider;
    /** LLM atom-triage tier (FEAT-533). `getProviders` ALWAYS sets it,
     * mirroring `judge`/`extractionPassB` above exactly: the SAME INSTANCE
     * as `extraction` when no `distill.atomTriage.{provider,model}`
     * override is configured (identity — shared rate-limit bucket,
     * byte-identical pre-override behavior), or a distinct provider built
     * from that override. Optional in the TYPE only so hand-built test
     * ProviderSets stay valid — consumers fall back with
     * `atomTriage ?? extraction`, exactly the pre-override behavior. Only
     * meaningful when `distill.atomTriage.mode !== 'off'` — embedAndIndex
     * never calls it on the shipped default. */
    atomTriage?: LLMProvider;
    /** Batched dup-judge over pending consolidation proposals (FEAT-549).
     *  `getProviders` ALWAYS sets it, mirroring `judge`/`extractionPassB`/
     *  `atomTriage` above exactly: the SAME INSTANCE as `extraction` when no
     *  `consolidation.dupJudge.{provider,model}` override is configured
     *  (identity — shared rate-limit bucket, byte-identical pre-override
     *  behavior), or a distinct provider built from that override. Optional
     *  in the TYPE only so hand-built test ProviderSets stay valid —
     *  consumers fall back with `dupJudge ?? extraction`, exactly the
     *  pre-override behavior. Only meaningful when
     *  `consolidation.dupJudge.mode !== 'off'` — `runConsolidation` never
     *  calls it on the shipped default. */
    dupJudge?: LLMProvider;
    /** Ingest gatekeeper (FEAT-548). `getProviders` ALWAYS sets it, mirroring
     *  `judge`/`extractionPassB`/`atomTriage`/`dupJudge` above exactly: the
     *  SAME INSTANCE as `extraction` when no `distill.gatekeeper.{provider,
     *  model}` override is configured (identity — shared rate-limit bucket,
     *  byte-identical pre-override behavior), or a distinct provider built
     *  from that override. Optional in the TYPE only so hand-built test
     *  ProviderSets stay valid — consumers fall back with
     *  `gatekeeper ?? extraction`, exactly the pre-override behavior. Only
     *  meaningful when `distill.gatekeeper.mode !== 'off'` — runPipeline
     *  never calls it on the shipped default. */
    gatekeeper?: LLMProvider;
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
  /** Ollama-only per-instance tuning (clerk seats); ignored by every other
   *  provider — see OllamaLLMConfig.numCtxCap. */
  opts?: { numCtxCap?: number },
): LLMProvider {
  // Apply the optional daemon-side call-rate limiter around whichever concrete
  // provider we build (token bucket SHARED per provider name — see
  // rateLimitLLMProvider). Disabled (pass-through) unless llm.rateLimit is set.
  //
  // P0-1: quota circuit breaker wraps the rate-limited provider (see
  // src/providers/llm/quota-breaker.ts's file doc comment) — placed OUTSIDE
  // rateLimitLLMProvider so a tripped breaker short-circuits before even
  // acquiring a rate-limit token, and INSIDE trackProviderHealth so the
  // health registry keeps observing real chat() outcomes (a tripped
  // breaker's own synthetic error still classifies as 'quota', which is an
  // accurate reflection of "still down for quota reasons"). Same single
  // wiring point as the other two decorators — every role built through this
  // function is covered with zero extra plumbing.
  //
  // FEAT-538: also wrap in the chat()-observing health tracker, unconditionally
  // (unlike rate limiting, this is always on — there's no opt-out config, the
  // same way embed/worker health always report). trackProviderHealth resolves
  // the SHARED entry for this provider's `.name` from a process-wide registry
  // (src/providers/llm/health-tracking.ts) — the single wiring point that
  // covers every role built through this function (compaction, extraction,
  // judge, extractionPassB, atomTriage, and one-off callers like
  // src/search/decompose.ts) without any daemon-boot (serve.ts) changes.
  return trackProviderHealth(
    wrapWithQuotaBreaker(
      rateLimitLLMProvider(
        buildRawLLMProvider(providerName, model, config, opts),
        config.llm.rateLimit?.callsPerMinute,
      ),
      config.llm.quotaBreaker,
    ),
  );
}

function buildRawLLMProvider(
  providerName: Config['llm']['compaction']['provider'],
  model: string,
  config: Config,
  opts?: { numCtxCap?: number },
): LLMProvider {
  if (providerName === 'ollama') {
    return new OllamaLLMProvider({ baseUrl: config.ollama.baseUrl, model, numCtxCap: opts?.numCtxCap });
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

  if (providerName === 'anthropic') {
    const apiKeyEnv = config.anthropic.apiKeyEnv || 'ANTHROPIC_API_KEY';
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `Anthropic LLM provider selected but ${apiKeyEnv} env var is not set. ` +
          'Set config.anthropic.apiKeyEnv or export the key directly.',
      );
    }
    return new AnthropicLLMProvider({ apiKey, model });
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
  const extraction = buildLLMProvider(
    config.llm.extraction.provider,
    config.llm.extraction.model,
    config,
  );
  // Judge override (consolidation.contradictionDetection.{provider,model}):
  // only build a SECOND provider when at least one half is actually set —
  // otherwise reuse the extraction INSTANCE (shared rate-limit bucket,
  // byte-identical pre-override behavior). An invalid provider value was
  // already dropped by applyContradictionDetectionGovernance, so this can
  // never hit buildLLMProvider's throwing Azure fall-through on a typo.
  const cd = config.consolidation?.contradictionDetection;
  const judge =
    cd?.provider !== undefined || cd?.model !== undefined
      ? buildLLMProvider(
          cd.provider ?? config.llm.extraction.provider,
          cd.model ?? config.llm.extraction.model,
          config,
        )
      : extraction;
  // Pass-B extraction override (FEAT-534): same identity-default shape as
  // the judge resolution just above — only build a SECOND provider when at
  // least one half is actually set, otherwise reuse the extraction INSTANCE.
  // An invalid `provider` value was already dropped by
  // applyExtractionPassBGovernance on the boot path, so this can never hit
  // buildLLMProvider's throwing Azure fall-through on a typo.
  const passB = config.distill?.extractionPassB;
  const extractionPassB =
    passB?.provider !== undefined || passB?.model !== undefined
      ? buildLLMProvider(
          passB.provider ?? config.llm.extraction.provider,
          passB.model ?? config.llm.extraction.model,
          config,
          // Clerk-seat num_ctx ceiling (ollama-only; other providers ignore
          // it) — resolved through the ONE central tuning resolver, never a
          // literal here. Applied only on this explicit-override branch: the
          // identity default below reuses the pass-A instance, which must
          // keep author-seat sizing.
          { numCtxCap: resolveExtractionPassBTuning(config.distill).numCtxCap },
        )
      : extraction;
  // Atom-triage provider override (FEAT-533): same identity-default shape
  // as judge/extractionPassB above — only build a SECOND provider when at
  // least one half is actually set, otherwise reuse the extraction
  // INSTANCE. An invalid `provider` value was already dropped by
  // applyAtomTriageGovernance on the boot path, so this can never hit
  // buildLLMProvider's throwing Azure fall-through on a typo.
  const at = config.distill?.atomTriage;
  const atomTriage =
    at?.provider !== undefined || at?.model !== undefined
      ? buildLLMProvider(
          at.provider ?? config.llm.extraction.provider,
          at.model ?? config.llm.extraction.model,
          config,
        )
      : extraction;
  // Dup-judge provider override (FEAT-549): same identity-default shape as
  // judge/extractionPassB/atomTriage above — only build a SECOND provider
  // when at least one half is actually set, otherwise reuse the extraction
  // INSTANCE. An invalid `provider` value was already dropped by
  // applyDupJudgeGovernance on the boot path, so this can never hit
  // buildLLMProvider's throwing Azure fall-through on a typo.
  const dj = config.consolidation?.dupJudge;
  const dupJudge =
    dj?.provider !== undefined || dj?.model !== undefined
      ? buildLLMProvider(
          dj.provider ?? config.llm.extraction.provider,
          dj.model ?? config.llm.extraction.model,
          config,
        )
      : extraction;
  // Gatekeeper provider override (FEAT-548): same identity-default shape as
  // judge/extractionPassB/atomTriage/dupJudge above — only build a SECOND
  // provider when at least one half is actually set, otherwise reuse the
  // extraction INSTANCE. An invalid `provider` value was already dropped by
  // applyGatekeeperGovernance on the boot path, so this can never hit
  // buildLLMProvider's throwing Azure fall-through on a typo.
  const gk = config.distill?.gatekeeper;
  const gatekeeper =
    gk?.provider !== undefined || gk?.model !== undefined
      ? buildLLMProvider(
          gk.provider ?? config.llm.extraction.provider,
          gk.model ?? config.llm.extraction.model,
          config,
        )
      : extraction;
  return {
    llm: {
      compaction: buildLLMProvider(
        config.llm.compaction.provider,
        config.llm.compaction.model,
        config,
      ),
      extraction,
      judge,
      extractionPassB,
      atomTriage,
      dupJudge,
      gatekeeper,
    },
    embed: buildEmbedProvider(config),
  };
}
