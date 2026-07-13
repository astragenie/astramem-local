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
  /** Dev no-auth mode — token-free local access for the operator's own daemon,
   *  covering BOTH the API and `/dashboard` (+ its sub-pages). `dashboard`
   *  keeps its own independent Bearer/cookie/?token= auth ONLY while this
   *  flag is off. `devNoAuth: false` (default, and the field's ABSENCE on an
   *  existing config.yaml) is byte-identical to pre-this-FEAT behavior.
   *  Deliberately config-file-only, NOT settable via env var — a bearer
   *  bypass should be an explicit, inspectable choice sitting in
   *  config.yaml, not something a stray env var can flip silently.
   *
   *  When active, `src/server/app.ts`'s auth `preHandler` hook skips Bearer/
   *  cookie enforcement for API routes, and the same boot-computed
   *  `devNoAuthActive` condition is threaded into every dashboard route
   *  factory (dashboard.ts + the dashboard-*-html.ts siblings), which use it
   *  via the shared `checkDashboardAuth` helper (dashboard-auth.ts) — but
   *  every route, API or dashboard, still requires the request's `Host`
   *  header to resolve to loopback (`isLoopbackHostHeader`,
   *  `src/server/lib/network.ts`) — the bearer token was ALSO the
   *  DNS-rebinding defense (a malicious page loaded in the operator's own
   *  browser can `fetch('http://127.0.0.1:7777/...')`; without a Host guard
   *  every local process — and every website via rebinding — could read/write
   *  the whole memory store, dashboard included). It is also refused (forced
   *  back to `false`, loud log, daemon keeps booting) whenever `network.host`
   *  resolves non-loopback: devNoAuth + a LAN/remote bind would mean
   *  credential-free exposure to the whole network, which must be
   *  structurally impossible, not just discouraged. See
   *  docs/configuration.md / README "Dev no-auth mode" before enabling. */
  auth: { devNoAuth: boolean };
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
    /**
     * RECALL-S1: explicit override for the query-side embedding instruction
     * prefix (see `EmbedProvider.queryPrefix` / `resolveEmbedQueryPrefix`,
     * src/contracts/embed.ts). Undefined (the default, and what
     * `defaultConfig()` ships) means "use the built-in prefix for `model`
     * if one is registered, else no prefix" — the single source of truth
     * for per-model defaults lives in `QUERY_PREFIX_BY_MODEL`, not here or
     * in the search path. Set explicitly (including `''`) only to override
     * that default for a model, e.g. a new/unlisted model that also wants
     * an instruction prefix, or to force no prefix for a listed one. Never
     * applied to document embedding (08-embed-index.ts) — query-side only.
     */
    queryPrefix?: string;
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
      /** Org-specific regex sources applied as detector type 'custom'.
       * A literal `#` in these patterns is safe: the hand-rolled config.yaml
       * parser (loader.ts) is quote-aware, so a `#` inside a quoted scalar
       * or a quoted flow-sequence entry round-trips as content, not a
       * comment delimiter (FEAT-465). */
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
  /** Autonomous consolidation auto-accept (FEAT-442). `null` (default) is
   * OFF — the current propose/accept human-gate behavior in
   * `src/consolidate/consolidate.ts` is byte-identical to pre-FEAT-442 when
   * unset. When set, a propose-tier pair (proposeThreshold <= similarity <
   * mergeThreshold) whose similarity is ALSO >= this value is accepted
   * immediately via the same code path a human accept uses
   * (`ProposalRepo.accept`), with an `auto_accepted` provenance marker on
   * the resulting `supersede` event so the merge stays auditable — findable
   * via `GET /consolidation/proposals?status=accepted` — and reversible via
   * `MemoryEventRepo.unsupersede()` / `POST /memory/:id/unsupersede`.
   *
   * Must be >= the `proposeThreshold` in effect for a given run and <= 1;
   * an out-of-range value is treated as unset for that run (logged,
   * non-fatal — matches the "never block a run on a bad config value"
   * governance pattern this repo already uses for search weights, see
   * `applyFusionGovernance`). */
  consolidation: {
    autoAcceptThreshold: number | null;
    /** Propose-only contradiction detection (FEAT-456 SLICE-1). `mode: 'off'`
     * (default) is BYTE-IDENTICAL to pre-FEAT-456 behavior — the judge
     * (`src/consolidate/contradiction-judge.ts`) is never called from
     * `runConsolidation`. `'dry-run'` runs the judge and records verdicts in
     * `ConsolidateSummary.contradictionsPreviewed` without writing a row —
     * the safe-rollout mode. `'enabled'` writes `kind:'contradiction'`
     * `consolidation_proposals` rows for confident `contradicts` verdicts;
     * resolution reuses `ProposalRepo.accept`/`reject` unchanged (same
     * non-destructive, reversible supersede path a 'merge' proposal uses).
     * Mirrors the `distill.durabilityGate` 3-state-enum precedent rather
     * than two independent booleans (avoids the ambiguous
     * `enabled:false, dryRun:true` combination). Opt-in only until eval'd —
     * do not change this default casually (same caveat durabilityGate
     * carries). `minSimilarity`/`minConfidence` bounds are validated
     * per-run inside `runConsolidation` (mirrors
     * `resolveAutoAcceptThreshold` — they depend on the run's
     * `mergeThreshold`, so they can't be governed here at config-load
     * time); only `mode` itself is validated here, see
     * `applyContradictionDetectionGovernance`. */
    contradictionDetection: {
      /** Cosine floor for judge eligibility — deliberately lower/decoupled
       * from `proposeThreshold`: contradicting facts about the same entity
       * can sit well below the near-duplicate paraphrase band. Must be in
       * `[0, mergeThreshold)` for the run in effect. */
      minSimilarity: number;
      /** Judge confidence floor to act on a 'contradicts' verdict. Must be
       * in `[0, 1]`. */
      minConfidence: number;
      /** Cap on judge calls per `runConsolidation()` call (cost/latency
       * guard) — bounds the ENTIRE run, not per group. Once exhausted,
       * remaining judge-eligible pairs fall through to the existing
       * merge-tier classification unchanged (`contradictionCapReached`
       * distinguishes "no contradictions found" from "ran out of budget"). */
      maxPerRun: number;
      mode: 'off' | 'dry-run' | 'enabled';
    };
  };
  /** Distillation durability quality gate (FEAT-441). `off` (default) is
   * BYTE-IDENTICAL to pre-FEAT-441 behavior — the gate
   * (`src/distill/durability-gate.ts`) is never even evaluated at the
   * persist call site (`src/distill/stages/08-embed-index.ts`). `strict`
   * gates all 5 low-durability taxonomy reasons; `lenient` gates only the
   * 3 lowest-false-positive-risk reasons (see durability-gate.ts doc
   * comment). Opt-in only until eval'd — do not change this default. Read
   * once at boot like every other config value (CLAUDE.md "Config reload"
   * section) — no hot reload. */
  distill: {
    durabilityGate: 'strict' | 'lenient' | 'off';
    /** FEAT-482: how many chunks stage 4 (compact) / stage 5 (extract) fan
     *  out to the LLM provider at once within a single pipeline run — see
     *  `mapWithConcurrency` / `resolveChunkConcurrency`
     *  (src/distill/concurrency.ts) for the dispatch/budget/ordering
     *  invariants this controls. Default 2 matches the operator's measured
     *  `OLLAMA_NUM_PARALLEL=2` sweet spot (1.67x speedup) — UNLIKE most flags
     *  in this file, this default is NOT byte-identical to the pre-FEAT-482
     *  behavior; set to 1 for the exact old sequential loop (the documented
     *  safety valve, see resolveChunkConcurrency). Clamped to [1, 8] at
     *  resolution time — a bad/hand-edited value never blocks a run. Pair a
     *  value > 1 with the Ollama server's own `OLLAMA_NUM_PARALLEL` env var,
     *  same caveat as `pipeline.concurrency` above. */
    chunkConcurrency: number;
    /** FEAT-479 (D3 §3.2): which extraction prompt profile stage 5 (`05-
     *  extract.ts`) resolves per-run. `'engineering'` (default) is the
     *  existing shipped prompt (EXTRACTION_SYSTEM_PROMPT/_V2/_V3) — BYTE-
     *  IDENTICAL to pre-FEAT-479 behavior when no override is configured
     *  anywhere. `'conversational'` selects the mem0/Graphiti-pattern
     *  liberal-extraction profile (AC-9/AC-10, SLICE-434 —
     *  EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL in src/distill/prompts/
     *  extract.ts): self-contained personal-fact sentences, possessor
     *  qualification, banned vague-summary/meta-commentary abstractions.
     *
     *  Redaction-posture disclosure (AC-10): switching to 'conversational'
     *  does NOT change what gets redacted. `src/redact/index.ts` still only
     *  strips SECRETS (tokens, keys, passwords, high-entropy strings) —
     *  never non-secret personal content. The whole point of this profile is
     *  to extract MORE personal detail (names, relationships, life events)
     *  into stored memories, all of which stays on-device in the local
     *  SQLite store like every other profile's output; it is never sent
     *  anywhere except to whichever LLM provider is configured for
     *  extraction itself (local Ollama by default, or a configured BYO cloud
     *  provider — see docs/providers.md). Operators who want personal
     *  content to never leave the box at all should keep the LLM provider
     *  on Ollama; the redaction gate provides no privacy boundary for
     *  ordinary personal facts under either profile.
     *
     *  Precedence at resolution time (`runPipeline`, src/distill/
     *  pipeline.ts): `ASTRA_EXTRACT_PROMPT` env var (highest — existing
     *  a/b-lever semantics, selects v2 of whichever profile resolves)
     *  > per-transcript `extract_profile` envelope field (PipelineContext.
     *  extractProfile, plumbed from the transcripts row via distillHandler
     *  the same way captureSource is) > this config default > 'engineering'. */
    extractProfile: 'engineering' | 'conversational';
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
  /** Durable ingest spool (FEAT-449). `capture claude` writes captured
   * transcript CONTENT here at close time (tmp+rename, keyed by a content
   * hash) so the daemon's spool-drain worker (src/ingest/spool-drain.ts) can
   * run it through the same ingest->distill path `/ingest/transcript` uses,
   * decoupled from the client read racing worktree/subagent cleanup — see
   * FEAT-449 for the starvation this closes. */
  ingest: {
    /** A spool file larger than this is quarantined unread rather than
     * parsed — guards the drain worker against OOM on a runaway transcript.
     * Default 32MB comfortably exceeds the measured p99 main-session size
     * (28.9MB, FEAT-449 triage). */
    spoolMaxBytes: number;
  };
  /** Automatic memory capture (FEAT-455, ADR-012). `enabled: false` (default)
   * is BYTE-IDENTICAL to pre-FEAT-455 behavior — the hook-tap trigger never
   * fires and the ingest spool sees nothing new. Enabling requires an
   * explicit opt-in disclosed by the `init` wizard prompt (ADR-012 decision
   * 4) — never flipped on by an upgrade or a default-config write. v1 =
   * hook-tap only (ADR-012 decision 1); MCP-tap/LLM-proxy are out of scope
   * and have no config surface here. */
  capture: {
    autoCapture: {
      enabled: boolean;
      /** Source-side relevance gate (ADR-012 decision 2,
       * `src/capture/relevance-gate.ts`) — distinct config surface from
       * `distill.durabilityGate`, kept fully separate per that module's
       * AC-6. */
      relevanceGate: {
        minChars: number;
        maxBytes: number;
        dedupWindow: number;
      };
    };
    /** Purge-batch reversible soft-delete (FEAT-467, ADR-013 Decision 4 —
     *  hard prerequisite for FEAT-458's proxy capture tier). Governs the
     *  default bounded restore window `MemoryEventRepo.purgeBatch()` opens
     *  when a disable flow (auto-capture today, proxy capture later) purges
     *  its capture-source-scoped atoms: reversible via restorePurgeBatch()
     *  until `restoreWindowDays` elapses, after which finalizePurgeBatch()
     *  hard-erases whatever is still unrestored (ADR-006 "erasure always
     *  wins, eventually"). 30 days balances "long enough to notice
     *  unexpected captured content" against "not an indefinite soft-deleted
     *  shadow copy" — see docs/specs/FEAT-458-S1-design.md §1.3. */
    purge: {
      restoreWindowDays: number;
    };
  };
  /** LLM proxy / auto-capture Tier 3 (FEAT-458, ADR-013). `enabled: false`
   *  (default, and the field's ABSENCE on an existing config.yaml) means no
   *  proxy process is ever started implicitly — the daemon's own boot path
   *  never reads this block at all. Unlike `capture.autoCapture`, there is
   *  no `init` wizard prompt (ADR-013 §5): the proxy is invoked only via its
   *  own explicit subcommand, `astramem-local proxy serve --port <N>
   *  --upstream <url>`, which can override `port`/`upstream` at the CLI
   *  without ever touching config.yaml. This block exists so a user who DOES
   *  want a persistent config-driven default doesn't have to pass flags
   *  every time, and so `doctor` has something to read (FEAT-458 S4).
   *  S2 ships zero capture code — `capture.enabled` here is plumbing for S3
   *  only, always false and unread until then. */
  proxy: {
    enabled: boolean;
    port: number;
    upstream: string;
    /** Idle deadline for an upstream request, in ms (FEAT-458 S4a). Armed at
     *  request-creation time — NOT via `upstreamReq.setTimeout()`, which only
     *  arms once a socket is connected and so leaves a hung DNS lookup or a
     *  stuck TCP handshake entirely uncovered. Reset on every genuine byte of
     *  activity in either direction. `0` or negative disables it.
     *
     *  A hung proxy hangs every agent turn routed through it — "proxy down !=
     *  agent down" (ADR-013 Decision 2) is why this exists. */
    upstreamTimeoutMs: number;
    capture: {
      /** Default false EVEN WHEN proxy.enabled is true — capture is a
       *  second, independent opt-in on top of running the proxy at all
       *  (ADR-013 §5). A user can run the transparent-forward-only proxy
       *  (FEAT-458 S2) with zero capture surface. */
      enabled: boolean;
    };
  };
}

export function defaultConfig(): Config {
  return {
    port: 7777,
    dataDir: defaultDataDir(),
    network: { host: '127.0.0.1' },
    auth: { devNoAuth: false },
    llm: {
      compaction: { provider: 'ollama', model: 'qwen3:8b' },
      extraction: { provider: 'ollama', model: 'qwen3:8b' }
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
    consolidation: {
      // autoAcceptThreshold stays NULL — deliberately, and against the obvious
      // instinct to just pick 0.92. Measured against the live store 2026-07-13:
      // cosine similarity on short atomic memories measures sentence SHAPE, not
      // meaning, so there is no safe numeric threshold. Real proposals found:
      //
      //   sim 0.920  "bun test .../grade-writer-telemetry.test.mts"
      //          vs  "bun test .../grade-writer-learnings.test.mts"   <- DIFFERENT FILES
      //   sim 0.872  "Compliance with COLORADO AI regulations is expensive"
      //          vs  "Compliance with EU AI regulations is expensive"  <- DIFFERENT LAWS
      //
      // Those differ by ONE WORD, and that word is the entire fact. No threshold
      // separates them from a true paraphrase, because the embedding cannot see
      // the difference. Raising the bar to 0.95 merges nothing (0 proposals
      // qualify); lowering it to 0.92 already merges two different test files.
      // The knob is the wrong instrument.
      autoAcceptThreshold: null,

      // 'enabled', not 'off' (2026-07-13). THIS is the right instrument: an LLM
      // judge that reads the pair and asks whether they actually say the same
      // thing. It catches Colorado-vs-EU in one cheap local call, which cosine
      // never will at any threshold. Shipped 'off' pending eval (FEAT-456
      // SLICE-1); the eval has now happened — see tests/consolidate/
      // contradiction-e2e.test.ts, which pins the exact false-merge pairs found
      // in the live store.
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200 },
    },
    memoryHealth: { llmJudgedJunkSample: { enabled: false } },
    ingest: { spoolMaxBytes: 32 * 1024 * 1024 },
    // 'lenient', not 'off' (2026-07-13). FEAT-441 shipped this gate disabled
    // pending an eval; the eval has now happened. Measured against the live
    // store: 8.0% of stored atoms are junk (task echoes like "deploy the changes
    // to production", shell fragments like "$ bun run test"), and they are
    // over-represented in what an agent actually SEES — 24% of top-5 search hits.
    //
    // 'lenient' rather than 'strict' because gate rejection is NOT reversible:
    // the atom is never persisted at all, unlike archive()/restore(). Lenient
    // gates 4 of the 5 reasons and holds back only `git_derivable`, which carries
    // the highest false-positive risk (a terse commit reference can still be
    // meaningful in a way a bare imperative cannot).
    distill: { durabilityGate: 'lenient', extractProfile: 'engineering', chunkConcurrency: 2 },
    capture: {
      autoCapture: {
        enabled: false,
        relevanceGate: { minChars: 8, maxBytes: 65536, dedupWindow: 20 },
      },
      purge: { restoreWindowDays: 30 },
    },
    proxy: {
      enabled: false,
      port: 7778,
      upstream: '',
      upstreamTimeoutMs: 30_000,
      capture: { enabled: false },
    },
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

/**
 * FEAT-441 fix pass (2026-07-09 review MEDIUM): `distill.durabilityGate` is
 * a closed 3-value enum, but config.yaml is hand-parsed scalars with no
 * schema (see loader.ts's doc comment) — an invalid/typo'd value (e.g.
 * 'strcit') would otherwise pass straight through `deepMerge` unchecked.
 * That is not a silent no-op: `gateDurability`'s `mode === 'off'` /
 * `mode === 'strict'` checks fall through to the `lenient` branch for ANY
 * other string, so a typo would silently start gating atoms under lenient
 * rules instead of falling back to the documented 'off' default. Validated
 * here, mirroring `applyFusionGovernance`'s "never throw, degrade + log"
 * shape exactly — never fatal, config.yaml validity must never block boot.
 */
const VALID_DURABILITY_GATE_MODES: ReadonlySet<Config['distill']['durabilityGate']> =
  new Set(['strict', 'lenient', 'off']);

export function applyDurabilityGateGovernance(
  distill: Config['distill'],
  opts: { log?: (message: string) => void } = {},
): Config['distill'] {
  const log = opts.log ?? ((message: string) => console.warn(message));
  if (!VALID_DURABILITY_GATE_MODES.has(distill.durabilityGate)) {
    log(
      `[durability-gate-governance] distill.durabilityGate=${JSON.stringify(distill.durabilityGate)} is not one ` +
      "of 'strict'|'lenient'|'off' — falling back to 'off' (the documented default). " +
      'See FEAT-441 / src/distill/durability-gate.ts.',
    );
    return { ...distill, durabilityGate: 'off' };
  }
  return distill;
}

/**
 * FEAT-456 SLICE-1: `consolidation.contradictionDetection.mode` is a closed
 * 3-value enum, same governance concern `applyDurabilityGateGovernance`
 * already documents for `distill.durabilityGate` — config.yaml is
 * hand-parsed scalars with no schema, so a typo'd mode value would
 * otherwise pass straight through `deepMerge` unchecked. Validated here,
 * never fatal; an invalid value falls back to `'off'` (the documented
 * default) and is logged. `minSimilarity`/`minConfidence` are NOT governed
 * here — they're validated per-run inside `runConsolidation` because their
 * valid range depends on the run's `mergeThreshold`, which this config
 * layer doesn't know about.
 */
const VALID_CONTRADICTION_DETECTION_MODES:
  ReadonlySet<Config['consolidation']['contradictionDetection']['mode']> =
  new Set(['off', 'dry-run', 'enabled']);

const DEFAULT_CONTRADICTION_DETECTION: Config['consolidation']['contradictionDetection'] =
  { mode: 'off', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200 };

export function applyContradictionDetectionGovernance(
  consolidation: Config['consolidation'],
  opts: { log?: (message: string) => void } = {},
): Config['consolidation'] {
  const log = opts.log ?? ((message: string) => console.warn(message));
  const cd = consolidation.contradictionDetection;
  // `loadConfig`'s top-level override merge is shallow (`{...base,
  // ...overrides}`), so an override that only sets `consolidation.
  // autoAcceptThreshold` replaces the WHOLE `consolidation` object and drops
  // `contradictionDetection` entirely — a missing object is just as
  // possible here as an invalid `mode`, so it gets the same non-fatal
  // fallback rather than a TypeError.
  if (!cd || !VALID_CONTRADICTION_DETECTION_MODES.has(cd.mode)) {
    log(
      cd
        ? `[contradiction-detection-governance] consolidation.contradictionDetection.mode=` +
          `${JSON.stringify(cd.mode)} is not one of 'off'|'dry-run'|'enabled' — falling back to ` +
          "'off' (the documented default). See FEAT-456 / src/consolidate/contradiction-judge.ts."
        : '[contradiction-detection-governance] consolidation.contradictionDetection is missing — ' +
          'falling back to defaults (mode: \'off\'). See FEAT-456 / src/consolidate/contradiction-judge.ts.',
    );
    return { ...consolidation, contradictionDetection: { ...DEFAULT_CONTRADICTION_DETECTION, ...cd, mode: 'off' } };
  }
  return consolidation;
}

/**
 * FEAT-479 (D3 §3.2): `distill.extractProfile` is a closed 2-value enum,
 * same governance concern `applyDurabilityGateGovernance` already documents
 * for `distill.durabilityGate` — config.yaml is hand-parsed scalars with no
 * schema, so a typo'd profile value would otherwise pass straight through
 * `deepMerge` unchecked and silently reach `runPipeline`'s precedence
 * resolution as an unrecognized string. Validated here, never fatal; an
 * invalid value falls back to `'engineering'` (the documented default,
 * BYTE-IDENTICAL to pre-FEAT-479 behavior) and is logged. Applied AFTER
 * `applyDurabilityGateGovernance` at every call site below — both functions
 * take and return the whole `distill` object, and each only touches its own
 * field, so composing them in either order is safe.
 */
const VALID_EXTRACT_PROFILES: ReadonlySet<Config['distill']['extractProfile']> =
  new Set(['engineering', 'conversational']);

export function applyExtractProfileGovernance(
  distill: Config['distill'],
  opts: { log?: (message: string) => void } = {},
): Config['distill'] {
  const log = opts.log ?? ((message: string) => console.warn(message));
  if (!VALID_EXTRACT_PROFILES.has(distill.extractProfile)) {
    log(
      `[extract-profile-governance] distill.extractProfile=${JSON.stringify(distill.extractProfile)} is not one ` +
      "of 'engineering'|'conversational' — falling back to 'engineering' (the documented default). " +
      'See FEAT-479 / src/distill/prompts/extract.ts.',
    );
    return { ...distill, extractProfile: 'engineering' };
  }
  return distill;
}

export function loadConfig(overrides: Partial<Config> | undefined): Config {
  const base = defaultConfig();
  const merged = overrides ? { ...base, ...overrides } : base;
  return {
    ...merged,
    search: applyFusionGovernance(merged.search),
    distill: applyExtractProfileGovernance(applyDurabilityGateGovernance(merged.distill)),
    consolidation: applyContradictionDetectionGovernance(merged.consolidation),
  };
}
