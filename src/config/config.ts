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
   * an unsignaled corpus). issue #190 (2026-07-13) re-evaluated this default
   * given that `recall_used` never fires automatically in production and
   * `memory_corrected` is dominated by consolidation self-merge — see the PR
   * for full numbers. Evidence: running tests/eval/retrieval-eval.test.ts
   * with epsilon 0.1 vs 0 is OBSERVATIONALLY IDENTICAL on the ADR-005 floors
   * (no fixture atom carries real usefulness signal, so ε adds an identical
   * constant to every candidate — provably rank-invariant there) and
   * negligible under a synthetic worst-case (a reopened/unsupersede()'d atom
   * keeping a stale corrected-only score: recall unaffected, NDCG within
   * noise, ~0.0006). That is NEUTRAL evidence, not evidence FOR zeroing it —
   * and zeroing it has a real cost: `tests/search/usefulness-rank.test.ts`
   * ("recall_used breaks the tie...") proves the mechanism correctly
   * rewards an EXPLICIT mark_memory_used/submit_feedback call today (the
   * channel that's missing is automatic wiring, not the mechanism itself —
   * see doctor's checkUsefulnessFeedbackLoop fix message), and
   * ADR-014/FEAT-428's shipped-config gate (tests/config/fusion-governance-
   * shipped-config.test.ts) deliberately exempts epsilon's nonzero default as
   * an already-evidenced baseline. Kept at 0.1: no evidence it regresses
   * anything, and zeroing it would silence the one positive-signal path that
   * demonstrably works when actually called. Revisit once issue #190 item 2
   * (a real automatic positive-signal caller) ships — at that point ε will
   * have non-uniform signal to reflect and the eval floors will actually be
   * able to measure it, unlike today.
   * ζ entity-relevance bonus (FEAT-402 AC-6: DEFAULT
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
  /** Multi-hop query decomposition (WS6, LoCoMo multi-hop workstream,
   * src/search/decompose.ts). OFF by default — mirrors crossEncoder's
   * governance style: a config-flagged, opt-in seam, never a default-on
   * capability. When disabled, search() takes zero extra branches (same
   * contract as `rerank: undefined`).
   *
   * `provider: 'mock'` is a deterministic, network-free heuristic splitter
   * (no semantic understanding — see MockQueryDecomposer's doc comment),
   * useful for tests and for exercising the stage without an LLM. `provider:
   * 'llm'` reuses `config.llm.extraction`'s provider (`model` optionally
   * overrides just the model) — no separate provider-selection surface.
   *
   * `minQueryWords` is a cheap, network-free skip: queries shorter than
   * this never reach the decomposer (bounds cost for the common single-hop
   * case). `maxSubQueries` caps the decomposer's own output. `timeoutMs` is
   * a hard per-call budget — a slow/hung decomposer degrades to zero
   * sub-queries (single-pass behavior) rather than blocking the request,
   * same fallback posture as crossEncoder.timeoutMs.
   *
   * `maxSupplemental` and `supplementalWeight` bound the DILUTION risk
   * (fuse.ts `normalizeScores` is a min-max over whatever candidate array
   * it's given — adding candidates to the primary array would shift every
   * candidate's normalized score). Supplemental (sub-query-sourced)
   * candidates are fused in their own, separate pass and never touch the
   * primary candidates' normalization; `maxSupplemental` caps how many of
   * them can ever be added, and `supplementalWeight` (< 1) damps their
   * score so they can never outscore an equally-strong direct hit. See
   * search.ts's merge step. */
  multiHop: {
    enabled: boolean;
    provider: 'mock' | 'llm';
    minQueryWords: number;
    maxSubQueries: number;
    maxSupplemental: number;
    supplementalWeight: number;
    timeoutMs: number;
    /** Optional model override when provider === 'llm'; defaults to
     * config.llm.extraction.model on config.llm.extraction.provider. */
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
    /** Hard gate on top of `enabled` (astramem-local, sync-experimental-gate
     * slice): sync-to-astramem-cloud is currently broken (8868 events
     * failing HTTP 400, not yet root-caused). `astramem-local pair` sets
     * `enabled: true` in sync.json on a successful redeem — by itself that
     * used to be enough to start shipping to the broken path. Both `enabled`
     * (sync.json, pairing-owned) AND `experimental` (config.yaml, hand-edit
     * only — `pair` never touches this field) must be true for the shipper
     * to start. Default false so pairing alone can never ship broken data;
     * see cli/serve.ts's shipper-start gate and shouldStartShipper() in
     * sync/shipper.ts. */
    experimental: boolean;
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
  /** Tiered disk-artifact retention (FEAT-493, scaffolding slice). Reclaims
   * HEAVY BINARY/DERIVED ARTIFACTS ON DISK ONLY — never `memories` rows.
   * That axis belongs exclusively to `archival` above (FEAT-404,
   * src/storage/archival.ts); do not entangle the two (arch-review boundary,
   * 2026-07-14). Off by default, and for a different reason than most
   * config-off defaults in this file: this pass DELETES files on disk once
   * `enabled` actually ships (it does not yet — see
   * `applyRetentionGovernance`), so an operator must opt in deliberately
   * rather than discover a reclaim happened silently. `dry-run` is the safe
   * rollout step: computes and reports what WOULD be reclaimed, deletes
   * nothing. See src/storage/retention.ts. */
  retention: {
    mode: 'off' | 'dry-run' | 'enabled';
    /** Files older than this (by mtime) are candidates. Sanity-clamped to
     * [1, 3650] days at governance time (FEAT-493 acceptance hint) — an
     * unbounded value would let a typo'd config silently mean "everything is
     * a candidate" the moment `enabled` ships for real. */
    ageThresholdDays: number;
    /** Directory scanned for candidates: `<artifactsDir>/<kind>/<file>`, one
     * subdirectory per `heavyArtifact.types` entry. Defaults to
     * `<dataDir>/artifacts` (see `defaultArtifactsDir`,
     * src/storage/retention.ts) when unset — override only for tests or a
     * non-default layout. NOT a database table: the obvious-looking
     * `artifacts` SQL table (migrations/001-init.sql) was DROPPED in
     * migrations/040-drop-dead-tables.sql (zero writers ever, confirmed,
     * irreversible) — do not resurrect it or point this at a table name. */
    artifactsDir?: string;
    /** Config-driven "heavy artifact" predicate — deliberately data-driven
     * rather than a hardcoded kind list. TBD/placeholder: nothing in this
     * repo writes into `<dataDir>/artifacts/` yet, so `types` ships empty
     * until a producer exists. L1-1 (audio ingest, FEAT-489, consent-ADR
     * gated — not yet dispatched) is expected to register real kind
     * subdirectories and finalize this predicate against its actual output
     * sizes; this scaffolding is shaped so that finalization is a
     * config/data change, not a rework of retention.ts. */
    heavyArtifact: {
      /** Per-file size floor in bytes — a file below this is never a
       * candidate regardless of kind. Default 1 MiB. */
      minSizeBytes: number;
      /** Kind-subdirectory names under `artifactsDir` considered "heavy" for
       * retention purposes. */
      types: string[];
    };
    /** Per-tier delete scope on top of `heavyArtifact.types`. `media`
     * reclaims only the kinds listed here; `lean` reclaims `media`'s kinds
     * PLUS its own extra kinds (it "also strips heavy derived payloads",
     * per the FEAT description, while distilled memories/transcripts stay
     * searchable). `all` (this FEAT's disk-artifact axis only) reclaims
     * every kind in `heavyArtifact.types` — it is NOT a memory-row wipe
     * despite the FEAT-493 description's "All = wipe everything past the
     * cutoff" wording; the arch-review boundary above restricts this whole
     * feature to disk artifacts, so a literal full-wipe "All" tier over
     * memory rows remains an explicit non-goal here and would need its own
     * decision if ever built. */
    tierScope: {
      media: string[];
      lean: string[];
    };
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
   * Default 2 (raised from 1, FEAT-482, 2026-07-13) — was BYTE-IDENTICAL to
   * pre-concurrency behavior at 1 (a single lane is exactly the old
   * single-loop worker). Raised because a single lane means one long-running
   * job (e.g. a `consolidate` run's contradiction-judge sweep) starves EVERY
   * other queued job for its entire duration — the FEAT-482 incident:
   * distill sat at 32 pending / 0 running for 10+ minutes while the sole
   * lane was wedged in the judge sweep. With 2 lanes, a second lane keeps
   * draining the rest of the queue while the first is occupied; the
   * starvation mode simply does not happen. Clamped to [1, 8] wherever it is
   * consumed (`resolveWorkerConcurrency` in worker.ts) — never fatal, a bad
   * config value must not block daemon boot; set to 1 to restore the exact
   * pre-FEAT-482 single-loop behavior.
   *
   * WARNING: concurrency > 1 multiplies local Ollama load (each lane can
   * have an in-flight LLM/embed call simultaneously) — pair with
   * `OLLAMA_NUM_PARALLEL` (Ollama server env var) set to at least this value,
   * or lanes will simply queue behind Ollama's own single-slot default and
   * you will not see the expected throughput gain. At the default of 2 this
   * is a real but bounded tradeoff (2x max Ollama concurrency, not
   * unbounded) — see FEAT-482 writeup for the accepted-risk reasoning. */
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
      /** FEAT-482: wall-clock cap (ms) on the ENTIRE judge sweep within a
       * single `runConsolidation()` call — bounds worst-case run duration
       * even against a slow/rate-limited judge provider, which `maxPerRun`
       * alone cannot: `maxPerRun` bounds call COUNT, not time, and the
       * incident that motivated this field was ~245 calls at ~13/min
       * against a throttled provider (10+ minutes, not a count problem).
       * Same fall-through as `maxPerRun`: once exceeded, remaining
       * judge-eligible pairs fall through to the existing merge-tier
       * classification unchanged
       * (`ConsolidateSummary.contradictionWallClockCapReached` distinguishes
       * this from the count cap). Not governed at config-load time, same as
       * `maxPerRun` above — any positive number is a legitimate cap choice,
       * there's no "invalid range" to validate. Default 300_000 (5 min). */
      maxWallClockMs: number;
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
    /** FEAT-487: how many chunks stage 4 (compact) / stage 5 (extract) fan
     *  out to the LLM provider at once within a single pipeline run — see
     *  `mapWithConcurrency` / `resolveChunkConcurrency`
     *  (src/distill/concurrency.ts) for the dispatch/budget/ordering
     *  invariants this controls. Default 2 matches the operator's measured
     *  `OLLAMA_NUM_PARALLEL=2` sweet spot (1.67x speedup) — UNLIKE most flags
     *  in this file, this default is NOT byte-identical to the pre-FEAT-487
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
    /** Whether stage 4 (compaction) runs at all.
     *
     *  `'auto'` (the default) means: **run for engineering, SKIP for
     *  conversational.** That is not a taste call — it is a measurement.
     *
     *  WHY COMPACTION IS A NET LOSS ON CONVERSATIONAL CONTENT:
     *
     *  Compaction exists to shrink a payload. That is a BANDWIDTH concern —
     *  it made sense when the design assumed transcripts were being shipped to
     *  a SaaS backend. **Locally there is no payload.**
     *
     *  And it is compressing something already small: stage 3 caps chunks at
     *  `MAX_CHUNK_CHARS = 3200` (~800 tokens), while extraction's `num_ctx` is
     *  sized up to 16384. Compaction saves a few hundred tokens out of a budget
     *  twenty times larger — while costing **one LLM call per chunk** (a
     *  17-chunk session pays 17 extra calls, roughly half of distill's wall
     *  clock).
     *
     *  And it DESTROYS FACTS. Until this flag existed, stage 4 ran the
     *  CODING-AGENT compressor over personal conversations — a prompt whose
     *  entire PRESERVE list is "file paths, commands, error messages, stderr"
     *  (none of which exist in a chat between two people) and whose REMOVE list
     *  ("thinking-out-loud", "acknowledgment phrases", "false starts")
     *  describes most of what a personal conversation IS. Measured on five real
     *  turns, it deleted: a named person (Alice), a relationship (the sister), a
     *  place (Portland), a life event (the move), a dated plan (summer camp in
     *  June) — **and every speaker name.** Extraction is REQUIRED to attribute
     *  each fact to a named person; compaction had already deleted the names, so
     *  extraction could only drop the atom or guess. It guessed wrong.
     *
     *  Nothing errored. Fewer atoms is not a failure, so the compactor
     *  "succeeded" on every call (ADR-015: success and failure indistinguishable).
     *
     *  `'always'` / `'never'` force it either way. `'never'` is safe locally and
     *  roughly halves distill wall-clock; `'always'` restores the pre-fix
     *  behavior for anyone who needs it (e.g. a genuinely long engineering
     *  session with heavy repeated tool output, where compaction earns its keep). */
    compaction: 'auto' | 'always' | 'never';
    /** #273 (WS7): stage 3's (`03-chunk.ts`) per-chunk character cap, as an
     *  operator-facing knob instead of a hardcoded constant. Root-caused
     *  finding: a long single chunk approaching the cap systematically loses
     *  content from its first ~80% (recency bias) — measured on real
     *  conv-26/conv-44 sessions, both flagged facts sat in turns the model
     *  never attended to. Default 3200 matches stage 3's own
     *  DEFAULT_MAX_CHUNK_CHARS. Clamped to [400, 8000] at resolution time
     *  (`resolveMaxChunkChars`, `03-chunk.ts`) — a bad/hand-edited value
     *  never blocks a run. Lowering this raises extraction-call count
     *  roughly proportionally (halving the cap roughly doubles compact()/
     *  extract() calls per session) — a real latency/cost tradeoff, not a
     *  free win; see the #273 sweep evidence before changing the default. */
    maxChunkChars: number;
    /** Dual-pass extraction (opt-in). `1` (the default) is BYTE-IDENTICAL to
     *  pre-dual-pass behavior — stage 5 runs the single existing extraction
     *  prompt (resolveExtractionPrompt) and nothing else. `2` adds a SECOND
     *  extraction call per chunk, on the SAME provider (ctx.llmExtraction,
     *  no new provider config), using the narrow "specifics sweeper" prompt
     *  (EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER, src/distill/prompts/
     *  extract.ts) — targeting concrete specifics (durations, frequencies,
     *  quantities, verbatim quotes, one-off events, advice from the giving
     *  speaker) that the single-hop root-cause investigation found the
     *  primary prompt systematically drops (36-47% of gold single-hop facts
     *  never became an atom at all — docs/research/20260713-single-hop-root-
     *  cause.md). The hypothesis ledger (docs/research/20260714-locomo-
     *  hypothesis-ledger.md §2.11) never killed multi-pass extraction, only
     *  left it untested — this is that test.
     *
     *  Pass B fires ONLY after pass A completes successfully for a run (a
     *  pass-A BudgetExceeded/TransientError aborts the run before pass B is
     *  ever attempted — no doubling of retry storms). The two passes' atoms
     *  are merged/deduped per chunk (src/distill/dedup-merge.ts) BEFORE
     *  stage 6 (reduce) — string-only, deterministic, no embedding call.
     *  Doubles extraction LLM calls when on — a real cost tradeoff, not a
     *  free win. */
    extractionPasses: 1 | 2;
    /** Opt-in cost cap on stage 4 (compact) + stage 5 (extract) LLM calls,
     *  counted TOGETHER as one per-job budget — mirrors
     *  `Config['consolidation']['contradictionDetection']`'s `maxPerRun`/
     *  `maxWallClockMs` shape (see that field's doc comment for the full
     *  rationale this one reuses verbatim).
     *
     *  WHY CALL-COUNT + WALL-CLOCK, NOT A DOLLAR CAP: codex-subscription (the
     *  default compaction/extraction provider) is metered by ChatGPT
     *  subscription quota, not per-token, and reports `usage.usd: 0` on
     *  every call — exactly like `contradiction-judge.ts`'s doc comment
     *  describes. `src/budget/tracker.ts`'s `BudgetTracker`/`BudgetExceeded`
     *  already exists for a DOLLAR cap and stays in place unchanged (Ollama
     *  pricing, Azure pricing); this is a SEPARATE, additional guard for the
     *  usd-blind case, not a replacement.
     *
     *  Optional (unlike `contradictionDetection`, which is always present) —
     *  `undefined` and `{ enabled: false }` are both treated as fully off by
     *  `resolveDistillCostCap` (`src/distill/cost-cap.ts`).
     *
     *  **`enabled: false` is the shipped BETA default** (see `defaultConfig`
     *  below) — BYTE-IDENTICAL to pre-this-field behavior: no call is
     *  counted, no wall-clock timer is started, `compact()`/`extract()` never
     *  skip a chunk. Unlike `contradictionDetection` (shipped `'enabled'`
     *  after its own eval), this cap ships OFF because BYO-subscription
     *  operators own their own quota — a default-on hard pause on the
     *  hottest LLM paths in the pipeline (every distill job calls both
     *  stages) would be friction, not safety, for the common case. Opt in
     *  per-operator by setting `enabled: true` with `maxCallsPerJob` and/or
     *  `maxWallClockMs`. */
    costCap?: {
      enabled: boolean;
      /** Cap on compact()+extract() LLM calls combined, for a SINGLE
       *  distill job (not a daily/global total — see `BudgetTracker` for
       *  that). Once reached, `compactChunk`/`extractChunk` skip their LLM
       *  call for every remaining chunk in the job — compact() falls
       *  through to the pass-through-raw-chunk path it already has for a
       *  skipped/empty result, extract() returns zero atoms for that chunk
       *  (the same "fewer atoms is not an error" posture the rest of this
       *  pipeline already tolerates, see `distill.compaction`'s doc comment)
       *  — the job still completes rather than failing/pausing. Ignored
       *  when omitted (no count cap, only wall-clock if set). */
      maxCallsPerJob?: number;
      /** Wall-clock cap (ms) on the SAME per-job sweep, measured from the
       *  first compact()/extract() call — same rationale as
       *  `contradictionDetection.maxWallClockMs`: call count alone doesn't
       *  bound duration against a slow/rate-limited provider. Same graceful
       *  fall-through as the count cap. Ignored when omitted. */
      maxWallClockMs?: number;
    };
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
  /** Audio-file transcription capture (FEAT-489 Slice A, ADR-017). `mode:
   *  'off'` (default) is BYTE-IDENTICAL to no audio support at all: the
   *  `transcribe` pipeline handler is never invoked and the optional
   *  `astramem-audio` add-on is never imported (packaging design pass
   *  decision 1 — presence probe only fires when mode !== 'off'). Single
   *  `mode` enum, not a separate `enabled`/`dryRun` boolean pair — mirrors
   *  `distill.durabilityGate` / `consolidation.contradictionDetection.mode`'s
   *  own stated rationale (config.ts's own precedent, restated by the
   *  packaging design doc as the convention-compliant reading of FEAT-489's
   *  arch-review note): 'dry-run' runs the handler and produces a
   *  transcript + distill preview without persisting memories; 'enabled'
   *  persists the full pipeline output.
   *
   *  ADR-017 (third-party speaker consent): recording or transcribing a
   *  meeting captures every OTHER participant's voice too, not just the
   *  operator's — a materially different consent posture than
   *  `capture.autoCapture`'s ADR-012 gate, which only ever captures the
   *  operator's own agent sessions. Default OFF + explicit per-surface
   *  opt-in (this field is its own toggle, never bundled with any other
   *  capture surface) are this repo's ADR-017 decision-3 gate, PLUS the
   *  `disclosureAcknowledged` enforcement gate documented below.
   *
   *  **v1 disclosure surface, revised post-review (2026-07-14):** an earlier
   *  draft of this comment argued the doctor WARN row alone satisfied
   *  decision 3 (reasoning by analogy to durabilityGate/contradictionDetection,
   *  neither of which has a wizard prompt). Review (needs_fix,
   *  20260714T190303Z-review-result-l1-1-audio-slice-a.md) correctly rejected
   *  that: ADR-017's whole premise is that third-party consent is NOT the
   *  same trust class as those toggles, and decision 3's "shown at the
   *  moment of consent" bar is materially stronger than "visible on the next
   *  `doctor` run, if the operator happens to run it." Rather than retrofit
   *  surgery onto `gatherInteractive` (a large, well-tested function that
   *  doesn't otherwise collect `audio.mode` at all — real regression risk for
   *  a setting that isn't part of its flow), this ships an ENFORCEABLE
   *  acknowledgment gate instead: `disclosureAcknowledged` (below) defaults
   *  `false`; the transcribe handler (src/pipeline/handlers/transcribe.ts)
   *  REFUSES to process — with the full canonical disclosure copy
   *  (`THIRD_PARTY_SPEAKER_CONSENT_DISCLOSURE`, this file) in the error — for
   *  as long as `mode !== 'off' && !disclosureAcknowledged`. This makes the
   *  disclosure unavoidable at the moment capture would actually happen (you
   *  cannot successfully transcribe anything without having set this to
   *  `true`), which is a stronger property than a one-time wizard prompt the
   *  operator could in principle click through without reading — it satisfies
   *  the ADR's INTENT (disclosure is seen and acted on before capture) via a
   *  mechanism this repo can ship today. The interactive `init` wizard prompt
   *  ADR-017 literally asks for remains the v2 upgrade path (nicer UX, same
   *  underlying gate) — tracked as a follow-up, not built here. The doctor
   *  WARN row (src/doctor/checks/audio-addon.ts) is unchanged as the ongoing
   *  every-run reminder while the surface stays active; it now also tells the
   *  operator exactly which config key to set when unacknowledged. */
  audio: {
    mode: 'off' | 'dry-run' | 'enabled';
    /** Optional override for the downloaded whisper.cpp model path; unset
     *  uses the `astramem-audio` add-on's own default download location. */
    modelPath?: string;
    /** ADR-017 decision 3 enforcement gate — see the `audio` block's own doc
     *  comment above for the full "why not a wizard prompt" reasoning.
     *  Default `false`. The operator sets this to `true` in config.yaml only
     *  after reading `THIRD_PARTY_SPEAKER_CONSENT_DISCLOSURE` (this file) —
     *  the transcribe handler refuses to run at all while `mode !== 'off'`
     *  and this is `false`, regardless of add-on presence. */
    disclosureAcknowledged?: boolean;
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
    /** Release-scoped hard gate (release no-go): the LLM proxy relay is
     *  EXPERIMENTAL and not production-ready for the first release. Default
     *  `false`. `astramem-local proxy serve` (src/cli/proxy.ts) refuses to
     *  start the listener at all unless this is explicitly `true` in
     *  config.yaml — independent of, and checked in ADDITION to, whatever
     *  else gates the subcommand. There is no CLI flag and no `init` wizard
     *  prompt for this (matches `proxy.enabled`'s own "no one-click toggle"
     *  posture above): an operator who wants the experimental proxy has to
     *  hand-edit config.yaml, deliberately, knowing what they're opting into. */
    experimental: boolean;
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
      // v0.18.0: shipped default switched from local-ollama qwen to
      // codex-subscription (gpt-5.4-mini, the DEFAULT_MODEL cheap tier —
      // see src/providers/llm/codex-subscription.ts). Every local-ollama
      // qwen default tried here has broken in production at least once:
      // qwen3:8b returned empty output under thinking mode + format:json
      // (see "qwen3:8b breaks distill extract" in CLAUDE.md) and also blew
      // this hardware class's 8 GB VRAM ceiling once the mxbai-embed-large
      // embedder (590 MB) was resident alongside it, spilling layers to CPU
      // and timing distill jobs out into poison; qwen3.5:4b fit VRAM but
      // under-extracted atoms from real conversational transcripts (retired
      // 2026-07-14, see src/cli/init.ts's DEFAULT_OLLAMA_LLM_MODEL comment).
      // codex-subscription runs off-box against the operator's own ChatGPT
      // plan, so it is immune to this box's VRAM ceiling entirely.
      //
      // Tradeoff the operator must accept: this requires `codex login`
      // (a paid ChatGPT plan) before compaction/extraction will work at
      // all — there is no anonymous/free path. Cost is metered by the
      // ChatGPT subscription's own quota, NOT by `budget.daily_usd` above:
      // every shipped LLM provider (including this one) hardcodes
      // `usage.usd: 0`, so the daily-dollar budget guard can never see or
      // cap codex-subscription spend (see the FEAT-482 dollar-cap-guard
      // retraction in CLAUDE.md for why that guard was tried and reverted
      // instead of relied on here).
      //
      // Embedding is untouched — codex-subscription has no embeddings
      // endpoint, so embedding stays on ollama/mxbai-embed-large below.
      // Same value for both roles — mirrors src/cli/init.ts's
      // codex-subscription default, which the `init` wizard writes into
      // both this compaction key and the extraction key below from one
      // provider pick. Users who explicitly pick ollama in the wizard still
      // get DEFAULT_OLLAMA_LLM_MODEL (qwen2.5:7b) as that provider's
      // sub-default.
      compaction: { provider: 'codex-subscription', model: 'gpt-5.4-mini' },
      extraction: { provider: 'codex-subscription', model: 'gpt-5.4-mini' }
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
    multiHop: {
      enabled: false, provider: 'mock', minQueryWords: 6, maxSubQueries: 3,
      maxSupplemental: 5, supplementalWeight: 0.5, timeoutMs: 800,
    },
    recallPack: {
      enabled: false,
      budgetTokens: 1500,
      policy: { enabled: true, minScore: 0.15, minPromptChars: 12 },
    },
    sync: { enabled: false, url: '', workspaceId: null, batchSize: 200, intervalMs: 30_000, experimental: false },
    security: {
      redaction: { enabled: true, entropyThreshold: 4.0, customPatterns: [] },
      encryption: { enabled: true }
    },
    tagHygiene: { tier2Enabled: false, tier2ConfidenceThreshold: 0.7 },
    archival: { enabled: false, ageThresholdDays: 183, usefulnessFloor: 0.0 },
    retention: {
      mode: 'off',
      ageThresholdDays: 90,
      heavyArtifact: { minSizeBytes: 1_048_576, types: [] },
      tierScope: { media: [], lean: [] },
    },
    ingestIdempotency: { retentionDays: 7 },
    pipeline: { concurrency: 2 },
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
      //
      // Staying 'enabled' post-FEAT-482 (same day, hours later): the incident
      // that flag caused was an UNBOUNDED judge — no call-count cap enforced
      // against a slow provider, no wall-clock cap — not the judge being a
      // bad idea. A DOLLAR cap was tried first and reverted: every shipped
      // LLM provider (Ollama, codex-subscription) reports `usage.usd: 0`, so
      // a budget check could never trip (see contradiction-judge.ts's doc
      // comment). `maxPerRun` + `maxWallClockMs` below are the real guards —
      // 'enabled' with those two in place is a different, defensible risk
      // profile than 'enabled' without them. Reverting to 'off'/'dry-run'
      // would also throw away the whole point of this mode (see the eval
      // note above) to guard against a bug that is now fixed at its actual
      // source. NOTE: the operator has separately set `mode: 'off'` in their
      // own live config.yaml as an immediate stopgap — that override takes
      // precedence for their instance regardless of this default; this
      // comment concerns the SHIPPED default only.
      contradictionDetection: {
        mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200,
        // FEAT-482 incident (2026-07-13): mode flipped 'off' -> 'enabled' the
        // day before this shipped with NO budget/duration guard on the judge
        // call — it fired ~245 sequential LLM calls against a metered
        // endpoint (codex-subscription, billed against the operator's
        // personal ChatGPT quota) and wedged the sole worker lane for 10+
        // minutes. `maxPerRun` alone doesn't bound WALL-CLOCK time against a
        // slow/rate-limited provider (13 calls/min * 200 calls is >15min on
        // its own); this is a second, independent guard. 5 minutes is short
        // enough to keep a runaway sweep from ever repeating that incident's
        // duration, long enough that a normal local-Ollama sweep (sub-second
        // per call) never hits it in practice.
        maxWallClockMs: 300_000,
      },
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
    // costCap.enabled: false — beta default. codex-subscription (the
    // default compaction/extraction provider) reports usage.usd: 0 always,
    // so BudgetTracker's dollar cap can't see this cost (same blind spot
    // FEAT-482 hit for the contradiction judge). The call-count/wall-clock
    // cap below EXISTS as an opt-in guard but ships OFF: BYO-subscription
    // operators own their own quota, and a default-on pause on the two
    // hottest LLM paths in the pipeline (every distill job) would be
    // friction, not safety, for beta. See Config['distill']['costCap']'s
    // doc comment before flipping this default.
    // extractionPasses: 1 — dual-pass off by default, byte-identical to
    // pre-dual-pass behavior.
    distill: {
      durabilityGate: 'lenient', extractProfile: 'engineering', chunkConcurrency: 2, compaction: 'auto',
      maxChunkChars: 3200, extractionPasses: 1, costCap: { enabled: false },
    },
    capture: {
      autoCapture: {
        enabled: false,
        relevanceGate: { minChars: 8, maxBytes: 65536, dedupWindow: 20 },
      },
      purge: { restoreWindowDays: 30 },
    },
    // audio.mode: 'off' — ADR-017-required default; disclosureAcknowledged:
    // false is the shipped disposition — see Config['audio'] doc comment for
    // why this is an enforceable acknowledgment gate rather than a wizard
    // prompt in v1.
    audio: {
      mode: 'off',
      disclosureAcknowledged: false,
    },
    proxy: {
      enabled: false,
      experimental: false,
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
 * ADR-017 decision 3: canonical disclosure copy, shared verbatim across the
 * astramem-local `init` wizard (audio, FEAT-489 — v2 upgrade path, see
 * Config['audio']'s doc comment) and the astramem-plugin opt-in UI (meeting
 * captions, FEAT-491) — so an operator who has seen one recognizes the same
 * posture in the other. Exported (not inlined at the one call site) so the
 * transcribe handler's refusal error and the doctor WARN row
 * (src/doctor/checks/audio-addon.ts) read the exact same string rather than
 * two hand-copied near-duplicates drifting apart. Functional draft per
 * ADR-017's own acceptance checklist item 2 — not yet legal/marketing-
 * reviewed language. NAME AND TEXT MUST STAY IN SYNC with FEAT-491's own
 * copy of this same constant (wave/l1-2-captions, not yet merged at the time
 * this was written) — same string, same name, so a later merge is a no-op
 * rather than two divergent disclosure texts.
 */
export const THIRD_PARTY_SPEAKER_CONSENT_DISCLOSURE =
  'This will capture what other people say in your meetings/calls, not just your own words. ' +
  'Recording or transcribing someone without their knowledge is restricted or illegal in many ' +
  'places. Turning this on does not make it legal — you are responsible for informing other ' +
  'participants and getting consent where required.';

/**
 * FEAT-489 Slice A: `audio.mode` is a closed 3-value enum, same governance
 * concern `applyDurabilityGateGovernance` documents — config.yaml is
 * hand-parsed scalars with no schema, so a typo'd mode value would
 * otherwise pass straight through `deepMerge` unchecked. An invalid value
 * falls back to `'off'` (the documented, most-conservative default — ADR-017
 * requires default-OFF, so falling back to anything other than 'off' here
 * would be the one governance function in this file where "degrade to the
 * default" and "degrade to the SAFEST value" happen to be the same choice,
 * which is worth stating rather than assuming).
 */
const VALID_AUDIO_MODES: ReadonlySet<Config['audio']['mode']> = new Set(['off', 'dry-run', 'enabled']);

export function applyAudioModeGovernance(
  audio: Config['audio'],
  opts: { log?: (message: string) => void } = {},
): Config['audio'] {
  const log = opts.log ?? ((message: string) => console.warn(message));
  if (!VALID_AUDIO_MODES.has(audio.mode)) {
    log(
      `[audio-mode-governance] audio.mode=${JSON.stringify(audio.mode)} is not one of ` +
      "'off'|'dry-run'|'enabled' — falling back to 'off' (the documented, ADR-017-required default). " +
      'See FEAT-489 / src/pipeline/handlers/transcribe.ts.',
    );
    return { ...audio, mode: 'off' };
  }
  return audio;
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
  { mode: 'off', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: 300_000 };

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
 * FEAT-493 (scaffolding slice): `retention.mode` is a closed 3-value enum,
 * same governance concern `applyDurabilityGateGovernance` already documents
 * — config.yaml is hand-parsed scalars with no schema, so a typo'd mode
 * value would otherwise pass straight through `deepMerge` unchecked. An
 * invalid or missing block falls back to `'off'` (the documented default),
 * logged, never fatal.
 *
 * Also downgrades `'enabled'` to `'dry-run'` unconditionally, loudly logged.
 * This is NOT the same "invalid value" case above: `'enabled'` is a
 * documented, valid enum member, but this scaffolding slice ships mode +
 * dry-run reporting only (see src/storage/retention.ts) — no code path
 * actually deletes a file yet. Silently letting `mode: 'enabled'` sit in
 * config while the runtime quietly behaves like `dry-run` would be exactly
 * the "green check, nothing actually happened" class this repo's ADR-015
 * exists to kill; downgrading with a loud log makes the gap visible instead.
 * Remove this clamp in the follow-up slice that wires real deletion behind
 * `enabled`.
 *
 * `ageThresholdDays` is clamped to [1, RETENTION_MAX_AGE_DAYS] for the same
 * "never let a bad config value silently mean something extreme" reason
 * `applyMultiHopGovernance` clamps `supplementalWeight` — see that function.
 */
const VALID_RETENTION_MODES: ReadonlySet<Config['retention']['mode']> =
  new Set(['off', 'dry-run', 'enabled']);

/** 10 years — generous enough that no legitimate retention window ever needs
 * more, tight enough that a fat-fingered value (an extra zero) can't
 * silently mean "never reclaim anything" while still reading as configured. */
const RETENTION_MAX_AGE_DAYS = 3650;

export function applyRetentionGovernance(
  retention: Config['retention'],
  opts: { log?: (message: string) => void } = {},
): Config['retention'] {
  const log = opts.log ?? ((message: string) => console.warn(message));
  const fallback = defaultConfig().retention;

  if (!retention || !VALID_RETENTION_MODES.has(retention.mode)) {
    log(
      retention
        ? `[retention-governance] retention.mode=${JSON.stringify(retention.mode)} is not one of ` +
          "'off'|'dry-run'|'enabled' — falling back to 'off' (the documented default). See FEAT-493 / " +
          'src/storage/retention.ts.'
        : "[retention-governance] retention is missing — falling back to defaults (mode: 'off'). " +
          'See FEAT-493 / src/storage/retention.ts.',
    );
    return { ...fallback, ...retention, mode: 'off' };
  }

  let governed = retention;

  if (governed.mode === 'enabled') {
    log(
      "[retention-governance] retention.mode='enabled' is not implemented yet (FEAT-493 scaffolding ships " +
      "mode + dry-run reporting only) — running as 'dry-run' instead. No files will be deleted. See " +
      'src/storage/retention.ts.',
    );
    governed = { ...governed, mode: 'dry-run' };
  }

  const clampedAge = Math.min(RETENTION_MAX_AGE_DAYS, Math.max(1, governed.ageThresholdDays));
  if (clampedAge !== governed.ageThresholdDays) {
    log(
      `[retention-governance] retention.ageThresholdDays=${governed.ageThresholdDays} is outside ` +
      `[1, ${RETENTION_MAX_AGE_DAYS}]; clamping to ${clampedAge}.`,
    );
    governed = { ...governed, ageThresholdDays: clampedAge };
  }

  return governed;
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

/**
 * Dual-pass extraction (opt-in): `distill.extractionPasses` is a closed
 * 2-value enum (1|2), same governance concern `applyExtractProfileGovernance`
 * documents just above — config.yaml is hand-parsed scalars with no schema,
 * so a typo'd or out-of-range value (e.g. a hand-edited `3`) would otherwise
 * reach `runPipeline`'s `ctx.config?.distill.extractionPasses ?? 1` read
 * unchecked. Invalid values fall back to `1` (the documented default, BYTE-
 * IDENTICAL to pre-dual-pass behavior) and are logged, never fatal. See
 * src/distill/dedup-merge.ts for what `2` actually does.
 */
const VALID_EXTRACTION_PASSES: ReadonlySet<Config['distill']['extractionPasses']> = new Set([1, 2]);

export function applyExtractionPassesGovernance(
  distill: Config['distill'],
  opts: { log?: (message: string) => void } = {},
): Config['distill'] {
  const log = opts.log ?? ((message: string) => console.warn(message));
  if (!VALID_EXTRACTION_PASSES.has(distill.extractionPasses)) {
    log(
      `[extraction-passes-governance] distill.extractionPasses=${JSON.stringify(distill.extractionPasses)} is not ` +
      "one of 1|2 — falling back to 1 (the documented default, byte-identical to pre-dual-pass behavior). " +
      'See src/distill/dedup-merge.ts.',
    );
    return { ...distill, extractionPasses: 1 };
  }
  return distill;
}

const VALID_MULTI_HOP_PROVIDERS: ReadonlySet<Config['multiHop']['provider']> = new Set(['mock', 'llm']);

/**
 * WS6 governance (mirrors `applyContradictionDetectionGovernance`'s shape):
 * config.yaml is hand-parsed scalars with no schema, and `loadConfig`'s
 * top-level override merge is shallow, so a partial `multiHop` override (or
 * a typo'd `provider`) would otherwise pass through unchecked. Never fatal —
 * an invalid/missing block falls back to `enabled: false` (the documented
 * default) plus the rest of `defaultConfig().multiHop`, logged, rather than
 * risk booting with `enabled: true` and a broken provider selection.
 * `supplementalWeight` out of [0,1] is clamped rather than rejected (same
 * defense-in-depth `resolveDecomposeOpts` already applies at resolve time —
 * this is belt-and-suspenders against a bad value ever being logged as
 * "governed" while still being out of range downstream).
 */
export function applyMultiHopGovernance(
  multiHop: Config['multiHop'],
  opts: { log?: (message: string) => void } = {},
): Config['multiHop'] {
  const log = opts.log ?? ((message: string) => console.warn(message));
  const fallback = defaultConfig().multiHop;

  if (!multiHop || !VALID_MULTI_HOP_PROVIDERS.has(multiHop.provider)) {
    log(
      multiHop
        ? `[multi-hop-governance] multiHop.provider=${JSON.stringify(multiHop.provider)} is not one of ` +
          "'mock'|'llm' — falling back to defaults (enabled: false). See WS6 / src/search/decompose.ts."
        : '[multi-hop-governance] multiHop is missing — falling back to defaults (enabled: false). ' +
          'See WS6 / src/search/decompose.ts.',
    );
    return { ...fallback, ...multiHop, provider: fallback.provider, enabled: false };
  }

  const clampedWeight = Math.min(1, Math.max(0, multiHop.supplementalWeight));
  if (clampedWeight !== multiHop.supplementalWeight) {
    log(
      `[multi-hop-governance] multiHop.supplementalWeight=${multiHop.supplementalWeight} is outside [0,1]; ` +
      `clamping to ${clampedWeight}. See WS6 / src/search/decompose.ts.`,
    );
  }
  return { ...multiHop, supplementalWeight: clampedWeight };
}

export function loadConfig(overrides: Partial<Config> | undefined): Config {
  const base = defaultConfig();
  const merged = overrides ? { ...base, ...overrides } : base;
  return {
    ...merged,
    search: applyFusionGovernance(merged.search),
    distill: applyExtractionPassesGovernance(applyExtractProfileGovernance(applyDurabilityGateGovernance(merged.distill))),
    consolidation: applyContradictionDetectionGovernance(merged.consolidation),
    audio: applyAudioModeGovernance(merged.audio),
    multiHop: applyMultiHopGovernance(merged.multiHop),
    retention: applyRetentionGovernance(merged.retention),
  };
}
