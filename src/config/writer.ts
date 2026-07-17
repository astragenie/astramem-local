/**
 * writeConfig — serialise a Config object to YAML and write it to disk.
 *
 * No external yaml package required. The Config shape is flat enough that
 * a purpose-built emitter is both simpler and faster to load than a full
 * YAML library — the one list field (`security.redaction.customPatterns`)
 * is handled as a flow-sequence via `arrayLine` below, not a real YAML
 * parser. Add the `yaml` package if Config ever needs nested lists of
 * objects, multi-line strings, or anchors.
 */

import { writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';
import { defaultConfig } from './config.js';
import { parseConfigYaml } from './loader.js';
import { logger } from '../log/logger.js';

/** Emit a scalar value as a YAML-safe string (no quoting for safe values). */
function yamlScalar(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    // Quote strings that contain special YAML chars or are booleans/numbers.
    if (
      v === '' ||
      /[:#{}\[\],&*?|<>=!%@`]/.test(v) ||
      /^(true|false|null|~)$/i.test(v) ||
      /^\d/.test(v)
    ) {
      return `'${v.replace(/'/g, "''")}'`;
    }
    return v;
  }
  return String(v);
}

/** Emit one YAML line with optional indent. */
function line(indent: number, key: string, value?: unknown): string {
  const pad = '  '.repeat(indent);
  if (value === undefined) return `${pad}${key}:`;
  return `${pad}${key}: ${yamlScalar(value)}`;
}

/**
 * Emit a string[] as a YAML flow-sequence (FEAT-461, security.redaction.
 * customPatterns). `JSON.stringify` of a string array is already valid YAML
 * flow-sequence syntax, so this doubles as the round-trip counterpart of
 * `parseConfigYaml`'s `[...]` handling in loader.ts — no separate quoting
 * rules to keep in sync.
 */
function arrayLine(indent: number, key: string, value: readonly string[]): string {
  const pad = '  '.repeat(indent);
  return `${pad}${key}: ${JSON.stringify(value)}`;
}

/**
 * FEAT-461 regression guard: module-level fallback values for fields that
 * may be `undefined` at emit time despite `Config` marking them required —
 * e.g. an in-memory Config assembled by older code, or a partial object a
 * caller built before a newer field's default existed (AC-4). Computed once;
 * `configToYaml` reads from here instead of throwing a `TypeError` on `cfg.x.y`.
 */
const EMIT_DEFAULTS = defaultConfig();

/**
 * Structural key-diff between a `Config` object and the YAML actually
 * emitted for it: top-level keys, plus one level of nesting for
 * object-valued top-level fields. `sync` is the one documented, intentional
 * exclusion (writer.ts below — owned by sync.json, merged separately at
 * boot). Backs both the AC-2 regression-guard test (tests/config/writer.test.ts)
 * and the AC-3 runtime warning in `configToYaml` below — a future `Config`
 * field that isn't wired into the emitter shows up here immediately instead
 * of silently reverting to its default on next load (see loader.ts's
 * deep-merge-over-defaults doc comment for why that revert is silent).
 */
const SYNC_EXCLUSION = new Set(['sync']);

/**
 * FEAT-461 review fix round 2 (validator finding, non-blocking severity but
 * user-visible AC-3 noise): a value with "nothing to emit" can't be missing.
 * `init` builds optional blocks like `azure: { ...base.azure, endpoint:
 * answers.azureEndpoint, deployment: answers.azureDeployment }`
 * (src/cli/init.ts) — when the user didn't configure that provider,
 * `endpoint`/`deployment` are explicit own properties with value
 * `undefined`, not absent keys, so the naive `nestedKey in parsedChild`
 * check below used to fire a false-positive "missing" for every ordinary
 * init run. `configToYaml` already correctly omits these (the pre-existing
 * `cfg.azure.endpoint ? [...] : []` conditionals), and the same is true for
 * an empty array (the `customPatterns` carve-out this generalizes). This
 * predicate is the single point both the top-level and nested-key loops
 * consult, so the two checks can't drift out of sync with each other. A
 * value that IS defined (or a non-empty array) but still missing from the
 * emitted output is untouched by this and still flags correctly.
 *
 * FEAT-470 quickwin (SLICE-420 re-review residual): extended to also treat
 * an explicit empty string (`''`) as "nothing to emit" for STRING-typed
 * fields. Every optional-string block above (`cfg.azure.endpoint ? [...] :
 * []`, `deployment`, `openaiCompatible.baseUrl`, `codexSubscription.authPath`,
 * `crossEncoder.sidecarUrl`/`model`) uses a plain truthy check, so `''` is
 * omitted by the emitter exactly like `undefined` is — the pre-fix predicate
 * only recognized `undefined`, so a Config with one of these set to `''`
 * (rather than the key never being set at all) produced the same
 * false-positive "missing" warning this predicate exists to prevent. Scoped
 * to `typeof value === 'string'` only: no optional field in `Config` is
 * boolean- or number-typed with a truthy-omit conditional (every
 * boolean/number field above is emitted unconditionally), so `0`/`false`
 * must keep flagging as missing when genuinely absent from the output — see
 * the counter-tests in tests/config/writer.test.ts.
 */
function hasNothingToEmit(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === 'string' && value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

export function findMissingConfigKeys(cfg: Config, emittedYaml: string): string[] {
  const parsed = parseConfigYaml(emittedYaml) as Record<string, unknown>;
  const missing: string[] = [];
  for (const [key, value] of Object.entries(cfg as unknown as Record<string, unknown>)) {
    if (SYNC_EXCLUSION.has(key)) continue;
    if (hasNothingToEmit(value)) continue;
    if (!(key in parsed)) {
      missing.push(key);
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const parsedChild = parsed[key];
      if (parsedChild === null || typeof parsedChild !== 'object' || Array.isArray(parsedChild)) {
        missing.push(key);
        continue;
      }
      for (const nestedKey of Object.keys(value as Record<string, unknown>)) {
        const nestedValue = (value as Record<string, unknown>)[nestedKey];
        if (hasNothingToEmit(nestedValue)) continue;
        if (!(nestedKey in (parsedChild as Record<string, unknown>))) {
          missing.push(`${key}.${nestedKey}`);
        }
      }
    }
  }
  return missing;
}

/**
 * Serialise Config to a YAML string.
 *
 * The emitted YAML is intentionally hand-readable and round-trippable by
 * `js-yaml` / `yaml` if the user installs one later.
 */
export function configToYaml(cfg: Config): string {
  // FEAT-461 review fix (Finding 1, HIGH): only emit customPatterns when the
  // user actually configured one. A pre-FEAT-461 daemon binary's
  // `parseScalar` has no `[...]` branch, so if config.yaml written by THIS
  // version is later read by an older binary (a `reinstall --rollback`
  // target — a first-class supported path, see CLAUDE.md), an always-present
  // `customPatterns: []` line would parse back as the literal STRING "[]"
  // instead of an array, and `src/redact/index.ts`'s
  // `(opts.customPatterns ?? []).map(...)` would then throw on the first
  // redaction-enabled request (redaction defaults on). Since `init` /
  // `reembed-dim` / `pair` never set this by default, omitting the line for
  // the empty case keeps a rolled-back binary's config.yaml identical to
  // what every prior version always produced — same "omit when unset/empty"
  // shape as the `azure.endpoint`-style conditionals below, just keyed on
  // non-empty rather than defined. A non-empty configured value still
  // round-trips fully (see tests/config/writer.test.ts).
  const customPatterns = cfg.security.redaction.customPatterns ?? EMIT_DEFAULTS.security.redaction.customPatterns;
  const lines: string[] = [
    '# AstraMemory Local — config.yaml',
    '# Generated by `astramem-local init`. Edit manually or re-run init.',
    '',
    line(0, 'port', cfg.port),
    line(0, 'dataDir', cfg.dataDir),
    '',
    // FEAT-406: leave at 127.0.0.1 unless you intend remote /health scraping.
    // Any other value requires Bearer auth on /health + /version too — see
    // docs/security/remote-health-threat-model.md before changing this.
    line(0, 'network'),
    line(1, 'host', cfg.network.host),
    '',
    // Dev no-auth mode — devNoAuth: false (default) is byte-identical to
    // pre-this-FEAT behavior. Config-file-only by design (no env var
    // override) — see Config['auth'] doc comment before enabling.
    line(0, 'auth'),
    line(1, 'devNoAuth', (cfg.auth ?? EMIT_DEFAULTS.auth).devNoAuth),
    '',
    line(0, 'llm'),
    line(1, 'compaction'),
    line(2, 'provider', cfg.llm.compaction.provider),
    line(2, 'model', cfg.llm.compaction.model),
    line(1, 'extraction'),
    line(2, 'provider', cfg.llm.extraction.provider),
    line(2, 'model', cfg.llm.extraction.model),
    '',
    line(0, 'embedding'),
    line(1, 'provider', cfg.embedding.provider),
    line(1, 'model', cfg.embedding.model),
    line(1, 'dim', cfg.embedding.dim),
    // RECALL-S1: only emitted when the operator has explicitly overridden
    // the per-model default (see Config['embedding']['queryPrefix'] doc) —
    // omitted entirely keeps a freshly-init'd config.yaml byte-identical to
    // pre-RECALL-S1 output, and lets the built-in QUERY_PREFIX_BY_MODEL
    // default apply.
    ...(cfg.embedding.queryPrefix !== undefined ? [line(1, 'queryPrefix', cfg.embedding.queryPrefix)] : []),
    '',
    line(0, 'vector'),
    line(1, 'store', cfg.vector.store),
    '',
    line(0, 'budget'),
    line(1, 'daily_usd', cfg.budget.daily_usd),
    '',
    line(0, 'ollama'),
    line(1, 'baseUrl', cfg.ollama.baseUrl),
    '',
    line(0, 'azure'),
    line(1, 'apiVersion', cfg.azure.apiVersion),
    ...(cfg.azure.endpoint ? [line(1, 'endpoint', cfg.azure.endpoint)] : []),
    ...(cfg.azure.deployment ? [line(1, 'deployment', cfg.azure.deployment)] : []),
    '',
    line(0, 'openaiCompatible'),
    line(1, 'apiKeyEnv', cfg.openaiCompatible.apiKeyEnv),
    ...(cfg.openaiCompatible.baseUrl ? [line(1, 'baseUrl', cfg.openaiCompatible.baseUrl)] : []),
    '',
    // EXPERIMENTAL (docs/providers.md) — authPath is the only non-secret
    // setting; the OAuth tokens themselves live in ~/.codex/auth.json,
    // never in config.yaml or secrets.env.
    line(0, 'codexSubscription'),
    ...(cfg.codexSubscription.authPath ? [line(1, 'authPath', cfg.codexSubscription.authPath)] : []),
    '',
    line(0, 'anthropic'),
    line(1, 'apiKeyEnv', cfg.anthropic.apiKeyEnv),
    '',
    // ADR-018 — in-process ONNX embedding provider settings. Only meaningful
    // when embedding.provider === 'onnx'; every field has an in-code default
    // (Config['onnxEmbed'] + ONNX_MODEL_REGISTRY), so the block is emitted only
    // when set (defaultConfig() ships {dtype:'q8', pooling:'cls'}). Each field
    // is emitted only when defined, matching the codexSubscription/azure blocks.
    ...(cfg.onnxEmbed ? [
      line(0, 'onnxEmbed'),
      ...(cfg.onnxEmbed.cacheDir !== undefined ? [line(1, 'cacheDir', cfg.onnxEmbed.cacheDir)] : []),
      ...(cfg.onnxEmbed.modelPath !== undefined ? [line(1, 'modelPath', cfg.onnxEmbed.modelPath)] : []),
      ...(cfg.onnxEmbed.numThreads !== undefined ? [line(1, 'numThreads', cfg.onnxEmbed.numThreads)] : []),
      ...(cfg.onnxEmbed.dtype !== undefined ? [line(1, 'dtype', cfg.onnxEmbed.dtype)] : []),
      ...(cfg.onnxEmbed.pooling !== undefined ? [line(1, 'pooling', cfg.onnxEmbed.pooling)] : []),
      '',
    ] : []),
    line(0, 'search'),
    line(1, 'alpha', cfg.search.alpha),
    line(1, 'beta', cfg.search.beta),
    line(1, 'gamma', cfg.search.gamma),
    line(1, 'delta', cfg.search.delta),
    line(1, 'epsilon', cfg.search.epsilon),
    line(1, 'zeta', cfg.search.zeta),
    line(1, 'eta', cfg.search.eta),
    // issue #352B: θ, the 8th governed fusion component (supersession/
    // correction freshness bonus — see fuse.ts). Same round-trip requirement
    // as zeta/eta above: omitting it here would silently drop a hand-set
    // `search.theta` on the next config write-back.
    line(1, 'theta', cfg.search.theta),
    // FEAT-428 governance ceiling — also dropped pre-FEAT-461 (missed by the
    // original bug report's own field list; caught by the AC-1 exhaustive
    // round-trip test instead).
    line(1, 'governance'),
    line(2, 'maxComponentWeight', cfg.search.governance.maxComponentWeight),
    // issue #190: the implicit positive-usefulness sweep's config sub-object
    // — a sibling of governance above, same reason for existing (a config.yaml
    // written before this field existed round-trips fine via defaultConfig()
    // merge; this only matters for a config that DID set it, which must not
    // be silently dropped on the next write-back).
    line(1, 'usefulness'),
    line(2, 'implicitPositive'),
    line(3, 'enabled', cfg.search.usefulness.implicitPositive.enabled),
    line(3, 'windowDays', cfg.search.usefulness.implicitPositive.windowDays),
    line(3, 'minDistinctQueries', cfg.search.usefulness.implicitPositive.minDistinctQueries),
    line(3, 'weight', cfg.search.usefulness.implicitPositive.weight),
    line(3, 'maxGrantsPerRun', cfg.search.usefulness.implicitPositive.maxGrantsPerRun),
    '',
    // Cross-encoder rerank stage (issue #26, ADR-005) — OFF by default. See
    // docs/runbooks/cross-encoder-rerank.md before flipping `enabled: true`.
    line(0, 'crossEncoder'),
    line(1, 'enabled', cfg.crossEncoder.enabled),
    line(1, 'provider', cfg.crossEncoder.provider),
    line(1, 'topK', cfg.crossEncoder.topK),
    line(1, 'timeoutMs', cfg.crossEncoder.timeoutMs),
    ...(cfg.crossEncoder.sidecarUrl ? [line(1, 'sidecarUrl', cfg.crossEncoder.sidecarUrl)] : []),
    ...(cfg.crossEncoder.model ? [line(1, 'model', cfg.crossEncoder.model)] : []),
    '',
    // Multi-hop query decomposition (WS6) — OFF by default. See
    // src/search/decompose.ts before flipping `enabled: true`.
    line(0, 'multiHop'),
    line(1, 'enabled', cfg.multiHop.enabled),
    line(1, 'provider', cfg.multiHop.provider),
    line(1, 'minQueryWords', cfg.multiHop.minQueryWords),
    line(1, 'maxSubQueries', cfg.multiHop.maxSubQueries),
    line(1, 'maxSupplemental', cfg.multiHop.maxSupplemental),
    line(1, 'supplementalWeight', cfg.multiHop.supplementalWeight),
    line(1, 'timeoutMs', cfg.multiHop.timeoutMs),
    ...(cfg.multiHop.model ? [line(1, 'model', cfg.multiHop.model)] : []),
    '',
    line(0, 'recallPack'),
    line(1, 'enabled', cfg.recallPack.enabled),
    line(1, 'budgetTokens', cfg.recallPack.budgetTokens),
    line(1, 'policy'),
    line(2, 'enabled', cfg.recallPack.policy.enabled),
    line(2, 'minScore', cfg.recallPack.policy.minScore),
    line(2, 'minPromptChars', cfg.recallPack.policy.minPromptChars),
    '',
    // sync's CONNECTION fields (enabled/url/workspaceId/batchSize/intervalMs)
    // are deliberately NOT emitted here — `astramem-local pair` owns them via
    // sync.json (single source of truth, merged at serve boot). `experimental`
    // is the one sync field config.yaml DOES own: a hand-edit-only hard gate
    // `pair` never touches, so redeeming a claim code can never by itself
    // start shipping to the (currently broken) cloud sync path — see
    // Config['sync'] doc comment and cli/serve.ts's shipper-start gate.
    line(0, 'sync'),
    line(1, 'experimental', cfg.sync.experimental),
    '',
    line(0, 'security'),
    line(1, 'redaction'),
    line(2, 'enabled', cfg.security.redaction.enabled),
    line(2, 'entropyThreshold', cfg.security.redaction.entropyThreshold),
    ...(customPatterns.length > 0 ? [arrayLine(2, 'customPatterns', customPatterns)] : []),
    line(1, 'encryption'),
    line(2, 'enabled', cfg.security.encryption.enabled),
    '',
    line(0, 'tagHygiene'),
    line(1, 'tier2Enabled', cfg.tagHygiene.tier2Enabled),
    line(1, 'tier2ConfidenceThreshold', cfg.tagHygiene.tier2ConfidenceThreshold),
    '',
    // Distill-job worker pool — concurrency > 1 multiplies local Ollama load;
    // pair with OLLAMA_NUM_PARALLEL. See Config['pipeline'] doc comment.
    line(0, 'pipeline'),
    line(1, 'concurrency', cfg.pipeline.concurrency),
    '',
    // Autonomous consolidation auto-accept (FEAT-442) — null (default) is
    // OFF, byte-identical to pre-FEAT-442 propose/accept. See
    // Config['consolidation'] doc comment before setting a value.
    // contradictionDetection (FEAT-456 SLICE-1) added under FEAT-461 — the
    // whole sub-block was previously dropped on every writeConfig() call.
    line(0, 'consolidation'),
    line(1, 'autoAcceptThreshold', cfg.consolidation.autoAcceptThreshold),
    line(1, 'contradictionDetection'),
    line(2, 'mode', (cfg.consolidation.contradictionDetection ?? EMIT_DEFAULTS.consolidation.contradictionDetection).mode),
    line(2, 'minSimilarity', (cfg.consolidation.contradictionDetection ?? EMIT_DEFAULTS.consolidation.contradictionDetection).minSimilarity),
    line(2, 'minConfidence', (cfg.consolidation.contradictionDetection ?? EMIT_DEFAULTS.consolidation.contradictionDetection).minConfidence),
    line(2, 'maxPerRun', (cfg.consolidation.contradictionDetection ?? EMIT_DEFAULTS.consolidation.contradictionDetection).maxPerRun),
    line(2, 'maxWallClockMs', (cfg.consolidation.contradictionDetection ?? EMIT_DEFAULTS.consolidation.contradictionDetection).maxWallClockMs),
    // P2.1 stabilization — k-NN candidate selection. 'full'/30/null are the
    // shipped defaults (byte-identical to pre-P2.1 behavior); wired in from
    // day one so this never joins the FEAT-461 dropped-field list.
    line(1, 'candidateSelection', (cfg.consolidation.candidateSelection ?? EMIT_DEFAULTS.consolidation.candidateSelection)),
    line(1, 'knnK', (cfg.consolidation.knnK ?? EMIT_DEFAULTS.consolidation.knnK)),
    line(1, 'maxCandidatePairsPerRun', cfg.consolidation.maxCandidatePairsPerRun ?? null),
    '',
    // Memory TTL / archival tiers (FEAT-404) — previously dropped on every
    // writeConfig() call (FEAT-461). enabled: false (default) is OFF.
    line(0, 'archival'),
    line(1, 'enabled', (cfg.archival ?? EMIT_DEFAULTS.archival).enabled),
    line(1, 'ageThresholdDays', (cfg.archival ?? EMIT_DEFAULTS.archival).ageThresholdDays),
    line(1, 'usefulnessFloor', (cfg.archival ?? EMIT_DEFAULTS.archival).usefulnessFloor),
    '',
    // Tiered disk-artifact retention (FEAT-493) — mode: 'off' (default) is a
    // hard no-op; mode: 'enabled' deletes files on disk (never `memories`
    // rows) — see Config['retention'] doc comment. heavyArtifact.types /
    // tierScope.media / tierScope.lean are string[] fields that ship empty
    // by default (no `artifacts` producer exists yet) — only emitted when
    // non-empty, same "omit when unset/empty" shape as
    // security.redaction.customPatterns above.
    line(0, 'retention'),
    line(1, 'mode', (cfg.retention ?? EMIT_DEFAULTS.retention).mode),
    // FEAT-493 (deletion un-clamped): the Media/Lean/All dial the automatic
    // cleanup-cadence sweep reads. 'media' (default) is the least
    // destructive tier — see Config['retention']['tier'] doc comment.
    line(1, 'tier', (cfg.retention ?? EMIT_DEFAULTS.retention).tier),
    line(1, 'ageThresholdDays', (cfg.retention ?? EMIT_DEFAULTS.retention).ageThresholdDays),
    ...((cfg.retention ?? EMIT_DEFAULTS.retention).artifactsDir
      ? [line(1, 'artifactsDir', (cfg.retention ?? EMIT_DEFAULTS.retention).artifactsDir)]
      : []),
    line(1, 'heavyArtifact'),
    line(2, 'minSizeBytes', (cfg.retention ?? EMIT_DEFAULTS.retention).heavyArtifact.minSizeBytes),
    ...(((cfg.retention ?? EMIT_DEFAULTS.retention).heavyArtifact.types.length > 0)
      ? [arrayLine(2, 'types', (cfg.retention ?? EMIT_DEFAULTS.retention).heavyArtifact.types)]
      : []),
    line(1, 'tierScope'),
    ...(((cfg.retention ?? EMIT_DEFAULTS.retention).tierScope.media.length > 0)
      ? [arrayLine(2, 'media', (cfg.retention ?? EMIT_DEFAULTS.retention).tierScope.media)]
      : []),
    ...(((cfg.retention ?? EMIT_DEFAULTS.retention).tierScope.lean.length > 0)
      ? [arrayLine(2, 'lean', (cfg.retention ?? EMIT_DEFAULTS.retention).tierScope.lean)]
      : []),
    '',
    // ingest_idempotency row retention (FEAT-432) — previously dropped on
    // every writeConfig() call (FEAT-461).
    line(0, 'ingestIdempotency'),
    line(1, 'retentionDays', (cfg.ingestIdempotency ?? EMIT_DEFAULTS.ingestIdempotency).retentionDays),
    '',
    // Distillation durability quality gate (FEAT-441) — previously dropped on
    // every writeConfig() call (FEAT-461). 'off' (default) is byte-identical
    // to pre-FEAT-441 behavior.
    line(0, 'distill'),
    line(1, 'durabilityGate', (cfg.distill ?? EMIT_DEFAULTS.distill).durabilityGate),
    // FEAT-479 (D3 §3.2) — extraction prompt profile. 'engineering' (default)
    // is byte-identical to pre-FEAT-479 behavior.
    line(1, 'extractProfile', (cfg.distill ?? EMIT_DEFAULTS.distill).extractProfile),
    line(1, 'compaction', (cfg.distill ?? EMIT_DEFAULTS.distill).compaction),
    // FEAT-487 — chunk-level compact()/extract() fan-out width. Default 2 is
    // NOT byte-identical to pre-FEAT-487 (sequential); set to 1 for that.
    line(1, 'chunkConcurrency', (cfg.distill ?? EMIT_DEFAULTS.distill).chunkConcurrency),
    // #273 (WS7) — stage 3's per-chunk character cap. Default 3200 matches
    // 03-chunk.ts's DEFAULT_MAX_CHUNK_CHARS.
    line(1, 'maxChunkChars', (cfg.distill ?? EMIT_DEFAULTS.distill).maxChunkChars),
    // Dual-pass extraction. Default 2 (shipped 2026-07-15) roughly doubles
    // extraction LLM calls/latency; 1 is byte-identical to pre-dual-pass
    // behavior — see Config['distill']['extractionPasses']'s own doc comment.
    line(1, 'extractionPasses', (cfg.distill ?? EMIT_DEFAULTS.distill).extractionPasses),
    // Opt-in distill compact()+extract() cost cap — enabled: false is the
    // shipped beta default (byte-identical to pre-this-field behavior).
    // See Config['distill']['costCap']'s doc comment before flipping it.
    line(1, 'costCap'),
    line(2, 'enabled', ((cfg.distill ?? EMIT_DEFAULTS.distill).costCap ?? { enabled: false }).enabled),
    ...(((cfg.distill ?? EMIT_DEFAULTS.distill).costCap?.maxCallsPerJob !== undefined)
      ? [line(2, 'maxCallsPerJob', (cfg.distill ?? EMIT_DEFAULTS.distill).costCap!.maxCallsPerJob as number)]
      : []),
    ...(((cfg.distill ?? EMIT_DEFAULTS.distill).costCap?.maxWallClockMs !== undefined)
      ? [line(2, 'maxWallClockMs', (cfg.distill ?? EMIT_DEFAULTS.distill).costCap!.maxWallClockMs as number)]
      : []),
    // LLM atom-triage tier (FEAT-533) — mode: 'off' is the shipped default,
    // byte-identical to pre-FEAT-533 behavior. Same shape as
    // consolidation.contradictionDetection above: the optional provider/
    // model override is a hand-edit-only field (consistent with that
    // block's own provider/model, and extractionPassB's, neither of which
    // this writer round-trips either — an operator who sets one on disk
    // keeps it via deepMerge; writeConfig() just never re-emits it).
    line(1, 'atomTriage'),
    line(2, 'mode', (cfg.distill ?? EMIT_DEFAULTS.distill).atomTriage.mode),
    line(2, 'batchSize', (cfg.distill ?? EMIT_DEFAULTS.distill).atomTriage.batchSize),
    line(2, 'maxPerRun', (cfg.distill ?? EMIT_DEFAULTS.distill).atomTriage.maxPerRun),
    line(2, 'maxWallClockMs', (cfg.distill ?? EMIT_DEFAULTS.distill).atomTriage.maxWallClockMs),
    '',
    // Memory-health score (FEAT-444) — previously dropped on every
    // writeConfig() call (FEAT-461). enabled: false (default) makes
    // estimateLlmJudgedJunk() a no-op, see Config['memoryHealth'] doc comment.
    line(0, 'memoryHealth'),
    line(1, 'llmJudgedJunkSample'),
    line(2, 'enabled', (cfg.memoryHealth ?? EMIT_DEFAULTS.memoryHealth).llmJudgedJunkSample.enabled),
    '',
    // Durable ingest spool (FEAT-449) — previously dropped on every
    // writeConfig() call (FEAT-461).
    line(0, 'ingest'),
    line(1, 'spoolMaxBytes', (cfg.ingest ?? EMIT_DEFAULTS.ingest).spoolMaxBytes),
    '',
    // Automatic memory capture (FEAT-455, ADR-012) — enabled: false (default)
    // is byte-identical to pre-FEAT-455 behavior. Only ever flipped to true
    // by an explicit `init` wizard opt-in or `capture auto-capture disable`
    // writing it back to false — see Config['capture'] doc comment.
    line(0, 'capture'),
    line(1, 'autoCapture'),
    line(2, 'enabled', cfg.capture.autoCapture.enabled),
    line(2, 'relevanceGate'),
    line(3, 'minChars', cfg.capture.autoCapture.relevanceGate.minChars),
    line(3, 'maxBytes', cfg.capture.autoCapture.relevanceGate.maxBytes),
    line(3, 'dedupWindow', cfg.capture.autoCapture.relevanceGate.dedupWindow),
    // Purge-batch reversible soft-delete (FEAT-467) — previously nonexistent;
    // wired in from day one so it never joins the FEAT-461 dropped-field list.
    line(1, 'purge'),
    line(2, 'restoreWindowDays', (cfg.capture.purge ?? EMIT_DEFAULTS.capture.purge).restoreWindowDays),
    '',
    // Audio-file transcription capture (FEAT-489 Slice A, ADR-017) —
    // mode: 'off' (default) means the transcribe handler and the optional
    // astramem-audio add-on are never invoked. Wired in from day one so it
    // never joins the FEAT-461 dropped-field list. modelPath is optional
    // (unset uses the add-on's own default download location) — omitted
    // entirely rather than emitted as an empty string, same as
    // retention.artifactsDir's conditional-emit pattern above.
    line(0, 'audio'),
    line(1, 'mode', (cfg.audio ?? EMIT_DEFAULTS.audio).mode),
    // ADR-017 decision 3 enforcement gate (v1 disclosure surface) — see
    // Config['audio'] doc comment. Always emitted (not conditional) so an
    // operator hand-editing config.yaml sees the key exists at all.
    line(1, 'disclosureAcknowledged', (cfg.audio ?? EMIT_DEFAULTS.audio).disclosureAcknowledged ?? false),
    ...((cfg.audio ?? EMIT_DEFAULTS.audio).modelPath
      ? [line(1, 'modelPath', (cfg.audio ?? EMIT_DEFAULTS.audio).modelPath as string)]
      : []),
    '',
    // LLM proxy (FEAT-458, ADR-013) — enabled: false (default) means no
    // proxy process starts implicitly; `upstream` is always emitted quoted
    // (yamlScalar quotes the empty-string default too) since a URL value
    // must never be emitted bare (DEC-010 precedent — mid-value special
    // characters like `://` are exactly what that quote-grammar fix was
    // for). A wholly new nested object (not a new scalar under an existing
    // key), so a pre-FEAT-458 loader encountering this block on a
    // `reinstall --rollback` sees one extra top-level key it doesn't
    // recognize — verified inert, not a crash, by
    // tests/config/proxy-downgrade.test.ts.
    line(0, 'proxy'),
    line(1, 'enabled', (cfg.proxy ?? EMIT_DEFAULTS.proxy).enabled),
    // Release no-go hard gate — default false, no wizard prompt, no CLI flag.
    // See Config['proxy']['experimental']'s doc comment (src/config/config.ts).
    line(1, 'experimental', (cfg.proxy ?? EMIT_DEFAULTS.proxy).experimental),
    line(1, 'port', (cfg.proxy ?? EMIT_DEFAULTS.proxy).port),
    line(1, 'upstream', (cfg.proxy ?? EMIT_DEFAULTS.proxy).upstream),
    line(1, 'upstreamTimeoutMs', (cfg.proxy ?? EMIT_DEFAULTS.proxy).upstreamTimeoutMs),
    line(1, 'capture'),
    line(2, 'enabled', (cfg.proxy ?? EMIT_DEFAULTS.proxy).capture.enabled),
    '',
    // Third-party-speaker capture sources (FEAT-491, ADR-017) — a wholly new
    // top-level block, same "verified inert on rollback" posture as `proxy`
    // above. `enabled: false` (default) means ingestCanonicalTranscript
    // hard-rejects every meeting_captions envelope regardless of what the
    // client sends.
    line(0, 'captureSource'),
    line(1, 'meetingCaptions'),
    line(2, 'enabled', (cfg.captureSource ?? EMIT_DEFAULTS.captureSource).meetingCaptions.enabled),
    '',
  ];
  const yaml = lines.join('\n');

  // AC-3: a future Config field not wired into the blocks above must surface
  // immediately, not silently revert to its default on next load (the bug
  // this FEAT fixes). Non-fatal — writeConfig must never fail because of it.
  const missingKeys = findMissingConfigKeys(cfg, yaml);
  if (missingKeys.length > 0) {
    logger.warn({ missingKeys }, 'configToYaml: emitted config is missing known Config keys');
  }

  return yaml;
}

/**
 * Write config.yaml to `path`, creating parent directories as needed.
 *
 * FEAT-433: writes atomically via a sibling tmp file + rename rather than
 * truncating `path` in place. A plain truncate-then-write leaves a window
 * where a concurrent reader (daemon boot's `loadConfigFromDisk`, which reads
 * config.yaml exactly once — there is no live reload) can observe a torn
 * file: empty, or a YAML fragment with only some keys written. `rename()` is
 * atomic on the same filesystem (POSIX rename(2); Windows via Node's
 * MoveFileEx binding), so a concurrent reader always sees either the
 * complete old file or the complete new one, never a partial write.
 */
export function writeConfig(cfg: Config, path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.config.yaml.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, configToYaml(cfg), 'utf8');
    renameSync(tmpPath, path);
  } catch (err) {
    // Covers both failure points: writeFileSync (disk full/perms, tmp may not
    // exist yet) and renameSync (tmp exists, rename itself failed). Either
    // way, don't leave a stray .tmp file behind in the config directory.
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup; tmp may not exist */ }
    throw err;
  }
}
