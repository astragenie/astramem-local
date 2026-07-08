import { defaultDataDir } from './datadir.js';
import { DEFAULT_EMBED_DIM } from '../contracts/embed.js';
import { hasPassingEvalEvidence } from '../eval/eval-evidence.js';

export interface Config {
  port: number;
  dataDir: string;
  /** FEAT-406: HTTP bind + the derived auth boundary for /health + /version.
   * Default host is loopback-only — changing it is a deliberate opt-in, not
   * a two-flag combination that can drift out of sync (see
   * `isLoopbackHost` in server/lib/network.ts, the single predicate that
   * decides both bind exposure and whether /health + /version require a
   * Bearer token). */
  network: { host: string };
  llm: {
    compaction: { provider: 'ollama' | 'azure-openai' | 'openai-compatible' | 'codex-subscription'; model: string };
    extraction: { provider: 'ollama' | 'azure-openai' | 'openai-compatible' | 'codex-subscription'; model: string };
  };
  embedding: {
    provider: 'ollama' | 'azure-openai';
    model: string;
    /** FEAT-409: parameterized — single source of truth is
     * DEFAULT_EMBED_DIM (src/contracts/embed.ts). Changing this for a
     * fresh DB is a plain config edit; changing it against an existing DB
     * with live data requires `astramem-local reembed-dim`
     * (docs/embed-dim-migration.md). */
    dim: number;
  };
  vector: { store: 'sqlite-vec' | 'lancedb' };
  budget: { daily_usd: number };
  ollama: { baseUrl: string };
  azure: { endpoint?: string; deployment?: string; apiVersion: string };
  /** Generic OpenAI-`/v1/chat/completions`-compatible provider (OpenAI API,
   * Groq, vLLM, LM Studio, ...). `apiKeyEnv` names the env var read for the
   * key (secrets.env-style, mirrors AZURE_OPENAI_API_KEY) — left unset it
   * defaults to OPENAI_COMPAT_API_KEY. Some self-hosted endpoints need no
   * key at all; in that case leave the env var unset and no Authorization
   * header is sent (see providers/llm/openai-compatible.ts). */
  openaiCompatible: { baseUrl?: string; apiKeyEnv: string };
  /** EXPERIMENTAL — reuses the user's `codex login` ("Sign in with ChatGPT")
   * session instead of an API key. See providers/llm/codex-subscription.ts
   * and docs/providers.md for the ToS-gray-zone warning before enabling. */
  codexSubscription: { authPath?: string };
  /** Fusion weights — α bm25, β cosine, γ importance, δ freshness,
   * ε usefulness (ADR-010 v1.x: recall_used/memory_corrected events feed
   * ranking; atoms with no signal score a neutral 0.5, so ε never reshuffles
   * an unsignaled corpus), ζ entity-relevance bonus (FEAT-402 AC-6: DEFAULT
   * 0 = OFF; a candidate entity-linked to an entity mentioned in the query
   * text gets +ζ. At zeta=0 ranking is byte-identical to no-entity ranking —
   * see the AC-6 snapshot test in tests/eval/retrieval-eval.test.ts), η
   * agent-match soft-boost (FEAT-426: DEFAULT 0 = OFF; when a caller opts a
   * `SearchFilters.agent` value into `agentMode: 'boost'` instead of the
   * default hard filter, a candidate whose provenance.agent matches gets
   * +η instead of having non-matches excluded outright. At eta=0 ranking is
   * byte-identical to pre-FEAT-426 behavior).
   *
   * FEAT-428 (fusion-model governance, arch-review of FEAT-426 findings 1+3):
   * `governance` is a guard over these weights, not a ranking behavior —
   * `applyFusionGovernance` below enforces it once at config-load time
   * (`loadConfig`), so every downstream consumer of `config.search` already
   * sees governed weights. See that function's doc comment for the two
   * guards (component ceiling, η eval-evidence gate). */
  search: {
    alpha: number; beta: number; gamma: number; delta: number; epsilon: number; zeta: number; eta: number;
    governance: {
      /** No individual component weight may exceed this. Over-ceiling
       * weights are clamped (not rejected — a bad config value must not
       * block an otherwise-healthy daemon from booting) and logged. Default
       * (1.0) sits well above every shipped default weight (max 0.4) so it
       * only ever guards a runaway/typo'd value, never a normal config. */
      maxComponentWeight: number;
    };
  };
  /** Cross-encoder rerank stage (issue #26, ADR-005). OFF by default — ADR-005
   * ruled "no reranker in v1 (CPU budget)" for local, so this is a
   * config-flagged, opt-in seam (mirrors the cloud engine's stub-by-default
   * `ICrossEncoderRanker`), not a default-on capability. When disabled the
   * search pipeline is byte-identical to pre-rerank behavior — the stage is
   * never invoked, not merely a no-op weight (see src/search/rerank.ts).
   *
   * `provider: 'mock'` is a deterministic lexical-overlap scorer — fully
   * testable, no network/model dependency. `provider: 'http'` calls a real
   * cross-encoder sidecar over HTTP (see docs/runbooks/cross-encoder-rerank.md
   * for the endpoint contract, cost/latency notes, and how to run one) —
   * requires `sidecarUrl`; `buildCrossEncoderProvider` throws at
   * provider-build time if it's unset.
   *
   * `topK` bounds how many post-fusion candidates are sent through the
   * reranker (cost/latency control — mirrors cloud's TopK=50 default).
   * `timeoutMs` is a hard cap (mirrors cloud's 300ms DEC-011/012 budget): a
   * slow/failed rerank call falls back to the un-reranked fused order rather
   * than blocking the request — degrades quality, never availability. */
  crossEncoder: {
    enabled: boolean;
    provider: 'mock' | 'http';
    topK: number;
    timeoutMs: number;
    /** Required when provider === 'http'. Base URL of the cross-encoder
     * sidecar's rerank endpoint (e.g. a TEI `/rerank` deployment). */
    sidecarUrl?: string;
    /** Optional model identifier forwarded in the request body when the
     * sidecar hosts more than one model (provider === 'http' only). */
    model?: string;
  };
  recallPack: {
    enabled: boolean;
    budgetTokens: number;
    /** Injection-policy v1 (ADR-005 when-to-recall, Wave 4d). */
    policy: {
      enabled: boolean;
      /** Minimum selection score a memory needs to be injected. */
      minScore: number;
      /** Prompts shorter than this get no injection (unless they reference memory). */
      minPromptChars: number;
    };
  };
  /** One-way log shipping to the cloud ledger (ADR-003). Off by default;
   * requires url + workspaceId + a device token in the keystore
   * (or ASTRA_SYNC_TOKEN). private-scoped atoms never ship (ADR-009). */
  sync: {
    enabled: boolean;
    url: string;
    workspaceId: string | null;
    batchSize: number;
    intervalMs: number;
  };
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
  /** Repo/project tag-hygiene backfill (FEAT-403, W4.3). */
  tagHygiene: {
    /** Tier-2 prompt-assisted inference is opt-in — a data-mutating heuristic
     * pass over legacy rows carries real mis-tag risk (PM pre-mortem), so it
     * never runs silently. Enable via config or the CLI's `--tier2` flag. */
    tier2Enabled: boolean;
    /** Minimum tier-2 confidence required to apply an inferred tag; below
     * this the memory is left untagged rather than risk a mis-tag (AC-4). */
    tier2ConfidenceThreshold: number;
  };
  /** Memory TTL / archival tiers (FEAT-404, W4.4). Both conditions are
   * required to archive an atom: older than ageThresholdDays AND its
   * trailing-7-day usefulness rate at/below usefulnessFloor. Off by default
   * — the PM pre-mortem risk is silently archiving a rarely-used-but-
   * critical memory, so enabling is a deliberate opt-in. Runs on the
   * cleanup job's cadence (src/pipeline/handlers/cleanup.ts). */
  archival: {
    enabled: boolean;
    /** Age is measured from created_at (how old the atom itself is), not
     * valid_from (which supersede() can advance). Default 183 days (~6
     * months), per the FEAT-404 AC-6 proposal. */
    ageThresholdDays: number;
    /** rate_7d <= this floor makes an atom archival-eligible (combined
     * with the age check). Default 0.0 — no explicit recall_used signal
     * in the trailing 7 days. */
    usefulnessFloor: number;
  };
  /** Retention for `ingest_idempotency` rows (FEAT-432, HARD hardening pass).
   * The table exists so a retried `POST /ingest/transcript` with the same
   * `Idempotency-Key` + body replays a 200 instead of double-writing; nothing
   * pruned it before this, so it grew forever on an always-on daemon. Runs on
   * the same cleanup-job cadence as the `jobs` prune / archival pass
   * (src/pipeline/handlers/cleanup.ts). Default 7 days is a large multiple of
   * any realistic client retry window (seconds-to-minutes backoff, or an
   * offline client replaying on next launch) — pruning a row a client still
   * retries against turns a would-be idempotent replay into a fresh
   * double-write, so this must stay comfortably above real retry windows. */
  ingestIdempotency: {
    /** Rows older than this (by created_at) are pruned. Must stay well above
     * any realistic client retry window — see rationale above. */
    retentionDays: number;
  };
  /** Distill-job worker pool (FEAT throughput hardening). A single serial
   * claim-execute loop was the daemon's throughput ceiling under parallel
   * ingest (measured 45-60s/session serial). `concurrency` controls how many
   * independent claim-execute lanes `startWorker` (src/pipeline/worker.ts)
   * runs; every lane shares the same atomic pending→running claim
   * (`JobRepo.claimPending`), so raising this is safe from double-execution
   * by construction — see that method's doc comment.
   *
   * Default 1 is BYTE-IDENTICAL to pre-concurrency behavior (a single lane
   * is exactly the old single-loop worker). Clamped to [1, 8] wherever it is
   * consumed (`resolveWorkerConcurrency` in worker.ts) — never fatal, a bad
   * config value must not block daemon boot.
   *
   * WARNING: concurrency > 1 multiplies local Ollama load (each lane can
   * have an in-flight LLM/embed call simultaneously) — pair with
   * `OLLAMA_NUM_PARALLEL` (Ollama server env var) set to at least this value,
   * or lanes will simply queue behind Ollama's own single-slot default and
   * you will not see the expected throughput gain. */
  pipeline: {
    concurrency: number;
  };
  /** Memory-health score (FEAT-444). `llmJudgedJunkSample` is the ONLY
   *  memory-health metric that ever calls an LLM — off by default (AC-5):
   *  with `enabled: false` (default), `estimateLlmJudgedJunk()`
   *  (server/queries/memory-health-deep.ts) returns immediately with zeros
   *  and makes no provider call. The heuristic-only junk rate and the rest
   *  of the memory-health report are computed unconditionally and never
   *  gated by this flag. CLI-only (`astramem-local memory health --deep`) —
   *  never consulted by `doctor`'s default pass or `GET /health`. */
  memoryHealth: {
    llmJudgedJunkSample: {
      enabled: boolean;
    };
  };
}

export function defaultConfig(): Config {
  return {
    port: 7777,
    dataDir: defaultDataDir(),
    network: { host: '127.0.0.1' },
    llm: {
      compaction: { provider: 'ollama', model: 'qwen2.5:7b' },
      extraction: { provider: 'ollama', model: 'qwen2.5:7b' }
    },
    embedding: { provider: 'ollama', model: 'mxbai-embed-large', dim: DEFAULT_EMBED_DIM },
    vector: { store: 'sqlite-vec' },
    budget: { daily_usd: 10 },
    ollama: { baseUrl: 'http://127.0.0.1:11434' },
    azure: { apiVersion: '2024-10-21' },
    openaiCompatible: { apiKeyEnv: 'OPENAI_COMPAT_API_KEY' },
    codexSubscription: {},
    search: {
      alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1, epsilon: 0.1, zeta: 0, eta: 0,
      governance: { maxComponentWeight: 1.0 },
    },
    crossEncoder: { enabled: false, provider: 'mock', topK: 50, timeoutMs: 300 },
    recallPack: {
      enabled: false,
      budgetTokens: 1500,
      policy: { enabled: true, minScore: 0.15, minPromptChars: 12 },
    },
    sync: { enabled: false, url: '', workspaceId: null, batchSize: 200, intervalMs: 30_000 },
    security: {
      redaction: { enabled: true, entropyThreshold: 4.0, customPatterns: [] },
      encryption: { enabled: true }
    },
    tagHygiene: { tier2Enabled: false, tier2ConfidenceThreshold: 0.7 },
    archival: { enabled: false, ageThresholdDays: 183, usefulnessFloor: 0.0 },
    ingestIdempotency: { retentionDays: 7 },
    pipeline: { concurrency: 1 },
    memoryHealth: { llmJudgedJunkSample: { enabled: false } }
  };
}

/**
 * FEAT-428: fusion-model governance guard (arch-review of FEAT-426 findings
 * 1+3 — no ceiling on additive fusion weights, no eval evidence gating any
 * of them). Applied once here, at config-load time, so every caller that
 * gets its weights from `loadConfig` (and, transitively, `config.search`)
 * already sees governed values — there is no separate call site to wire or
 * forget downstream.
 *
 * Two independent guards, both non-fatal (a bad config value must never
 * block daemon boot — matches the rest of this config layer's "never throw,
 * degrade and log" philosophy, see loader.ts):
 *
 * 1. Component ceiling: no configured weight may exceed
 *    `search.governance.maxComponentWeight` — a runaway weight (a typo'd 40
 *    instead of 0.4, or a well-intentioned "just crank it up") can't
 *    dominate ranking. Over-ceiling weights are CLAMPED to the ceiling, not
 *    rejected, and a warning is logged.
 * 2. η eval-evidence gate: `eta` (FEAT-426 agent soft-boost) may only be
 *    nonzero if `src/eval/eval-evidence.ts` records a passing ADR-005
 *    harness run for 'eta'. With no such evidence recorded (the state as of
 *    FEAT-428 — see that module), a configured `eta > 0` is forced back to
 *    0 (the safe, byte-identical-ranking default) and a warning is logged,
 *    instead of silently shipping an unvalidated ranking change.
 *
 * `checkEvalEvidence` is an injectable seam for tests; production always
 * uses the real `hasPassingEvalEvidence` lookup. `log` defaults to
 * `console.warn`; tests can inject a collector instead of spying on the
 * console.
 */
export function applyFusionGovernance(
  search: Config['search'],
  opts: {
    log?: (message: string) => void;
    checkEvalEvidence?: (component: 'eta') => boolean;
  } = {},
): Config['search'] {
  const log = opts.log ?? ((message: string) => console.warn(message));
  const checkEvalEvidence = opts.checkEvalEvidence ?? hasPassingEvalEvidence;
  const ceiling = search.governance.maxComponentWeight;

  const governed: Config['search'] = { ...search };
  const componentKeys = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'] as const;
  for (const key of componentKeys) {
    const value = governed[key];
    if (value > ceiling) {
      log(
        `[fusion-governance] search.${key}=${value} exceeds the component ceiling ` +
        `(${ceiling}); clamping to ${ceiling}. See FEAT-428 / applyFusionGovernance.`,
      );
      governed[key] = ceiling;
    }
  }

  if (governed.eta > 0 && !checkEvalEvidence('eta')) {
    log(
      `[fusion-governance] search.eta=${governed.eta} is configured but no passing ADR-005 ` +
      "eval-harness evidence is recorded for 'eta' (src/eval/eval-evidence.ts) — forcing " +
      'eta=0 for this config. Record a passing tests/eval/retrieval-eval.test.ts run before ' +
      'shipping a nonzero eta.',
    );
    governed.eta = 0;
  }

  return governed;
}

export function loadConfig(overrides: Partial<Config> | undefined): Config {
  const base = defaultConfig();
  const merged = overrides ? { ...base, ...overrides } : base;
  return { ...merged, search: applyFusionGovernance(merged.search) };
}
