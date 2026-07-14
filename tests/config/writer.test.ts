import { describe, it, expect, vi, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { configToYaml, writeConfig, findMissingConfigKeys } from '../../src/config/writer.js';
import { defaultConfig, type Config } from '../../src/config/config.js';
import { loadConfigFromDisk } from '../../src/config/loader.js';
import { logger } from '../../src/log/logger.js';

/**
 * FEAT-461 AC-1: a fully-populated `Config` built field-by-field with a
 * non-default value for EVERY field (including `archival`,
 * `ingestIdempotency`, `distill`, `memoryHealth`, `ingest`, and
 * `consolidation.contradictionDetection` — the fields the original bug
 * silently dropped). Deliberately NOT derived from `defaultConfig()` with
 * fields mutated in place: a still-missing emitter block must not be able to
 * round-trip "successfully" by accident (default in, default out).
 */
function buildFullyPopulatedConfig(): Config {
  return {
    port: 8765,
    dataDir: 'C:\\custom\\astra-data',
    network: { host: '0.0.0.0' },
    auth: { devNoAuth: true },
    llm: {
      compaction: { provider: 'azure-openai', model: 'gpt-4o-compact' },
      extraction: { provider: 'openai-compatible', model: 'gpt-4o-extract' },
    },
    embedding: { provider: 'azure-openai', model: 'text-embed-3-large', dim: 1536 },
    vector: { store: 'lancedb' },
    budget: { daily_usd: 42 },
    ollama: { baseUrl: 'http://192.168.1.50:11434' },
    azure: { endpoint: 'https://my.openai.azure.com', deployment: 'gpt41', apiVersion: '2025-01-01' },
    openaiCompatible: { baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'MY_CUSTOM_KEY_ENV' },
    codexSubscription: { authPath: '/home/user/.codex/auth.json' },
    search: {
      alpha: 0.25, beta: 0.35, gamma: 0.15, delta: 0.05, epsilon: 0.2, zeta: 0.05, eta: 0.03,
      governance: { maxComponentWeight: 0.8 },
    },
    crossEncoder: {
      enabled: true, provider: 'http', topK: 77, timeoutMs: 450,
      sidecarUrl: 'http://sidecar:8080/rerank', model: 'rerank-v2',
    },
    multiHop: {
      enabled: true, provider: 'llm', minQueryWords: 4, maxSubQueries: 4,
      maxSupplemental: 8, supplementalWeight: 0.6, timeoutMs: 900, model: 'decompose-model',
    },
    recallPack: {
      enabled: true,
      budgetTokens: 2200,
      policy: { enabled: false, minScore: 0.35, minPromptChars: 20 },
    },
    sync: { enabled: true, url: 'https://sync.example.com', workspaceId: 'ws-123', batchSize: 500, intervalMs: 60_000, experimental: true },
    security: {
      redaction: { enabled: false, entropyThreshold: 3.5, customPatterns: ['SECRET-\\d+', 'sk-[a-zA-Z0-9]{20,}'] },
      encryption: { enabled: false },
    },
    tagHygiene: { tier2Enabled: true, tier2ConfidenceThreshold: 0.85 },
    archival: { enabled: true, ageThresholdDays: 90, usefulnessFloor: 0.1 },
    retention: {
      mode: 'dry-run',
      ageThresholdDays: 30,
      heavyArtifact: { minSizeBytes: 2_097_152, types: ['audio-raw', 'transcript-raw'] },
      tierScope: { media: ['audio-raw'], lean: ['audio-raw', 'transcript-raw'] },
    },
    ingestIdempotency: { retentionDays: 14 },
    pipeline: { concurrency: 4 },
    consolidation: {
      autoAcceptThreshold: 0.95,
      contradictionDetection: { mode: 'enabled', minSimilarity: 0.5, minConfidence: 0.8, maxPerRun: 50, maxWallClockMs: 120_000 },
    },
    memoryHealth: { llmJudgedJunkSample: { enabled: true } },
    ingest: { spoolMaxBytes: 1_048_576 },
    distill: {
      durabilityGate: 'strict', extractProfile: 'conversational', chunkConcurrency: 5, compaction: 'never',
      maxChunkChars: 2400, extractionPasses: 1, costCap: { enabled: true, maxCallsPerJob: 40, maxWallClockMs: 180_000 },
    },
    capture: {
      autoCapture: {
        enabled: true,
        relevanceGate: { minChars: 20, maxBytes: 131_072, dedupWindow: 40 },
      },
      purge: { restoreWindowDays: 45 },
    },
    audio: { mode: 'dry-run', modelPath: '/custom/model/path.bin' },
    proxy: {
      enabled: true,
      experimental: true,
      port: 9001,
      upstream: 'https://api.openai.com/v1',
      upstreamTimeoutMs: 45_000,
      capture: { enabled: true },
    },
  };
}

// Wrap the real implementations in vi.fn() so every existing test keeps
// hitting the real filesystem by default — only the tmp-cleanup tests below
// override writeFileSync/renameSync with mockImplementationOnce.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
  };
});

import { readFileSync, mkdirSync, readdirSync, writeFileSync, renameSync } from 'node:fs';

function tmpPath(): string {
  const dir = join(tmpdir(), `astra-writer-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'config.yaml');
}

describe('configToYaml', () => {
  it('contains expected top-level keys', () => {
    const cfg = defaultConfig();
    const yaml = configToYaml(cfg);
    expect(yaml).toContain('port: 7777');
    expect(yaml).toContain('embedding:');
    expect(yaml).toContain('  provider: ollama');
    expect(yaml).toContain('vector:');
    expect(yaml).toContain('  store: sqlite-vec');
    expect(yaml).toContain('budget:');
    expect(yaml).toContain('  daily_usd: 10');
    expect(yaml).toContain('search:');
    expect(yaml).toContain('  alpha: 0.4');
  });

  it('includes azure endpoint + deployment when set', () => {
    const cfg = defaultConfig();
    cfg.azure.endpoint = 'https://my.openai.azure.com';
    cfg.azure.deployment = 'gpt41';
    const yaml = configToYaml(cfg);
    expect(yaml).toMatch(/endpoint: ['"]?https:\/\/my\.openai\.azure\.com['"]?/);
    expect(yaml).toContain('deployment: gpt41');
  });

  it('omits optional azure fields when not set', () => {
    const cfg = defaultConfig();
    const yaml = configToYaml(cfg);
    expect(yaml).not.toContain('endpoint:');
    expect(yaml).not.toContain('deployment:');
  });

  it('emits llm provider + model for compaction and extraction', () => {
    const cfg = defaultConfig();
    const yaml = configToYaml(cfg);
    expect(yaml).toContain('compaction:');
    expect(yaml).toContain('extraction:');
    expect(yaml.match(/provider: ['"]?codex-subscription['"]?/g)).toHaveLength(2);
    expect(yaml.match(/model: ['"]?gpt-5\.4-mini['"]?/g)).toHaveLength(2);
  });

  // FEAT-442: autonomous consolidation auto-accept — default null (OFF) round-trips.
  it('emits consolidation.autoAcceptThreshold: null by default', () => {
    const cfg = defaultConfig();
    const yaml = configToYaml(cfg);
    expect(yaml).toContain('consolidation:');
    expect(yaml).toContain('autoAcceptThreshold: null');
  });

  it('emits a configured consolidation.autoAcceptThreshold value', () => {
    const cfg = defaultConfig();
    cfg.consolidation.autoAcceptThreshold = 0.9;
    const yaml = configToYaml(cfg);
    expect(yaml).toContain('autoAcceptThreshold: 0.9');
  });

  // distill.costCap ships OFF for beta — see Config['distill']['costCap'].
  it('emits distill.costCap.enabled: false by default, with no maxCallsPerJob/maxWallClockMs lines under it', () => {
    const cfg = defaultConfig();
    const yaml = configToYaml(cfg);
    expect(yaml).toContain('costCap:');
    // Scope to the distill block only — consolidation.contradictionDetection
    // always emits its OWN maxWallClockMs, so a bare global
    // not.toContain('maxWallClockMs') would false-fail on that unrelated field.
    const distillBlock = yaml.slice(yaml.indexOf('\ndistill:'), yaml.indexOf('\nmemoryHealth:'));
    expect(distillBlock).toContain('costCap:');
    expect(distillBlock).toContain('enabled: false');
    expect(distillBlock).not.toContain('maxCallsPerJob');
    expect(distillBlock).not.toContain('maxWallClockMs');
  });

  it('emits a configured distill.costCap with limits', () => {
    const cfg = defaultConfig();
    cfg.distill.costCap = { enabled: true, maxCallsPerJob: 25, maxWallClockMs: 90_000 };
    const yaml = configToYaml(cfg);
    expect(yaml).toContain('maxCallsPerJob: 25');
    expect(yaml).toContain('maxWallClockMs: 90000');
  });
});

describe('writeConfig', () => {
  it('writes a parseable YAML file to disk', () => {
    const path = tmpPath();
    const cfg = defaultConfig();
    writeConfig(cfg, path);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('port: 7777');
    expect(content).toContain('embedding:');
  });

  it('creates parent directories if missing', () => {
    const dir = join(tmpdir(), `astra-writer-deep-${randomUUID()}`, 'a', 'b', 'c');
    const path = join(dir, 'config.yaml');
    const cfg = defaultConfig();
    writeConfig(cfg, path);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('port:');
  });
});

// Review round (needs_fix): the tmp cleanup only ran when renameSync threw —
// a writeFileSync failure (disk full, perms) before the rename left the tmp
// file behind. Both failure points are now covered by one try/catch.
describe('writeConfig tmp-file cleanup on failure', () => {
  afterEach(() => {
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(renameSync).mockClear();
  });

  it('removes the tmp file when writeFileSync throws', () => {
    const dir = join(tmpdir(), `astra-writer-wfail-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.yaml');

    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device');
    });

    expect(() => writeConfig(defaultConfig(), path)).toThrow('ENOSPC');
    const leftoverTmp = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftoverTmp).toEqual([]);
  });

  it('removes the tmp file when renameSync throws', () => {
    const dir = join(tmpdir(), `astra-writer-rfail-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.yaml');

    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('EPERM: operation not permitted');
    });

    expect(() => writeConfig(defaultConfig(), path)).toThrow('EPERM');
    const leftoverTmp = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftoverTmp).toEqual([]);
  });
});

// FEAT-461: configToYaml() silently dropped archival, ingestIdempotency,
// distill, memoryHealth, ingest, and consolidation.contradictionDetection
// (plus crossEncoder.model and security.redaction.customPatterns) on every
// writeConfig() call — the loader deep-merges over defaultConfig(), so any
// key the emitter failed to write silently reverted to its default on next
// load. sync's CONNECTION fields (enabled/url/workspaceId/batchSize/
// intervalMs) stay an intentional, documented exclusion (owned by
// sync.json) throughout — not part of this bug. `sync.experimental`
// (sync-experimental-gate slice) is the one sync field the emitter DOES
// own and round-trip — see Config['sync'] doc comment.
describe('FEAT-461: configToYaml emit completeness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // AC-1: exhaustive round-trip fidelity.
  it('a fully-populated Config round-trips through writeConfig -> loadConfigFromDisk unchanged (except sync connection fields)', () => {
    const cfg = buildFullyPopulatedConfig();
    const path = tmpPath();
    writeConfig(cfg, path);
    const loaded = loadConfigFromDisk(dirname(path));

    // Two pre-existing, documented, orthogonal exclusions from strict
    // round-trip equality — neither is part of the FEAT-461 emit-completeness
    // bug this test targets:
    //  - sync's connection fields (enabled/url/workspaceId/batchSize/
    //    intervalMs): never written to config.yaml (owned by sync.json).
    //    `experimental` DOES round-trip — see the dedicated assertion below.
    //  - search.eta: FEAT-428 fusion governance (applyFusionGovernance, run
    //    by loadConfigFromDisk) forces any configured eta > 0 back to 0
    //    unless a passing ADR-005 eval-harness run is recorded for it — a
    //    real value here would never survive loadConfigFromDisk regardless
    //    of whether the emitter wrote it correctly.
    const { sync: loadedSync, search: loadedSearch, ...loadedRest } = loaded;
    const { sync: cfgSync, search: cfgSearch, ...cfgRest } = cfg;
    expect(loadedRest).toEqual(cfgRest);
    expect(loadedSearch).toEqual({ ...cfgSearch, eta: 0 });

    expect(loadedSync).toEqual({ ...defaultConfig().sync, experimental: cfgSync.experimental });
    expect(cfgSync).not.toEqual(defaultConfig().sync);
  });

  // AC-2: regression guard — a structural key-diff, not a fixed field list.
  it('findMissingConfigKeys reports nothing for the current writer against a fully-populated Config (except sync)', () => {
    const cfg = buildFullyPopulatedConfig();
    const missing = findMissingConfigKeys(cfg, configToYaml(cfg));
    expect(missing).toEqual([]);
  });

  it('findMissingConfigKeys catches a top-level Config field the emitter does not know about', () => {
    // Simulates the exact regression this AC guards against: a new field
    // added to the Config type that configToYaml isn't updated to emit.
    const cfg = { ...defaultConfig(), futureField: { subKey: 'x' } } as unknown as Config;
    const missing = findMissingConfigKeys(cfg, configToYaml(cfg));
    expect(missing).toContain('futureField');
  });

  it('findMissingConfigKeys catches a nested field dropped inside an otherwise-emitted block', () => {
    const cfg = defaultConfig() as unknown as Record<string, unknown>;
    const withExtraNested = {
      ...cfg,
      consolidation: { ...(cfg['consolidation'] as Record<string, unknown>), futureNested: true },
    } as unknown as Config;
    const missing = findMissingConfigKeys(withExtraNested, configToYaml(withExtraNested));
    expect(missing).toContain('consolidation.futureNested');
  });

  it('never flags the documented sync exclusion as missing', () => {
    const missing = findMissingConfigKeys(defaultConfig(), configToYaml(defaultConfig()));
    expect(missing).not.toContain('sync');
  });

  // FEAT-461 review fix round 2 (validator finding, non-blocking severity,
  // in-scope since it's this slice's own AC-3 code): src/cli/init.ts builds
  // optional blocks as `azure: { ...base.azure, endpoint: answers.azureEndpoint,
  // deployment: answers.azureDeployment }` — when the user didn't configure
  // that provider, `endpoint`/`deployment` are explicit own properties with
  // value `undefined`, not absent keys. The naive `nestedKey in parsedChild`
  // check used to flag these as "missing" on essentially every ordinary
  // init/reembed-dim/pair run, even though configToYaml correctly omits them
  // (the pre-existing `cfg.azure.endpoint ? [...] : []` conditionals).
  it('does not flag defined-as-undefined optional fields as missing (mirrors src/cli/init.ts object-building shape)', () => {
    const base = defaultConfig();
    // Mirrors buildConfig() in src/cli/init.ts: spreading base and setting
    // optional fields to `answers.x` where the user left that provider
    // unconfigured (undefined), rather than defaultConfig()'s plain object
    // literal (which never even has the key).
    const cfg: Config = {
      ...base,
      azure: { ...base.azure, endpoint: undefined, deployment: undefined },
      openaiCompatible: { ...base.openaiCompatible, baseUrl: undefined },
      codexSubscription: { ...base.codexSubscription, authPath: undefined },
      crossEncoder: { ...base.crossEncoder, sidecarUrl: undefined, model: undefined },
    };
    const yaml = configToYaml(cfg);
    const missing = findMissingConfigKeys(cfg, yaml);
    expect(missing).toEqual([]);

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    configToYaml(cfg);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still flags a defined optional field that is absent from the emitted output', () => {
    const cfg = defaultConfig();
    cfg.azure.endpoint = 'https://my.openai.azure.com'; // defined — configToYaml does emit this
    const yaml = configToYaml(cfg);
    expect(yaml).toContain('endpoint');

    // Simulate a future regression: the emitter stops writing a field that
    // IS defined on cfg. Strip the line by hand rather than editing the
    // emitter, so this test exercises findMissingConfigKeys's own logic in
    // isolation from configToYaml's current (correct) behavior.
    const brokenYaml = yaml
      .split('\n')
      .filter((l) => !l.trim().startsWith('endpoint:'))
      .join('\n');
    const missing = findMissingConfigKeys(cfg, brokenYaml);
    expect(missing).toContain('azure.endpoint');
  });

  // AC-3: observability on incomplete emit.
  it('logs a structured warning naming the missing keys when the emit is incomplete', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    const cfg = { ...defaultConfig(), futureField: 'x' } as unknown as Config;

    configToYaml(cfg);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ missingKeys: expect.arrayContaining(['futureField']) }),
      expect.stringContaining('configToYaml: emitted config is missing known Config keys'),
    );
  });

  it('does not warn when the emit is complete', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    configToYaml(buildFullyPopulatedConfig());
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // AC-4: defaulted-undefined sub-block does not throw and emits the default.
  it('emits documented defaults instead of throwing when optional sub-blocks are undefined at emit time', () => {
    const cfg = defaultConfig();
    const degraded = {
      ...cfg,
      archival: undefined,
      ingestIdempotency: undefined,
      distill: undefined,
      memoryHealth: undefined,
      ingest: undefined,
      consolidation: { ...cfg.consolidation, contradictionDetection: undefined },
    } as unknown as Config;

    let yaml = '';
    expect(() => { yaml = configToYaml(degraded); }).not.toThrow();

    const defaults = defaultConfig();
    expect(yaml).toContain(`ageThresholdDays: ${defaults.archival.ageThresholdDays}`);
    expect(yaml).toContain(`retentionDays: ${defaults.ingestIdempotency.retentionDays}`);
    expect(yaml).toContain(`durabilityGate: ${defaults.distill.durabilityGate}`);
    expect(yaml).toContain(`spoolMaxBytes: ${defaults.ingest.spoolMaxBytes}`);
    expect(yaml).toContain(`mode: ${defaults.consolidation.contradictionDetection.mode}`);
  });

  // AC-5: no behavior change for existing valid configs.
  it('emits byte-identical YAML for the blocks already covered before this fix, for a default Config', () => {
    const yaml = configToYaml(defaultConfig());
    // Spot-check every block the pre-FEAT-461 emitter already covered
    // correctly, unchanged in shape/value by this patch.
    expect(yaml).toContain('port: 7777');
    expect(yaml).toContain("  host: '127.0.0.1'"); // quoted: yamlScalar quotes leading-digit strings
    expect(yaml).toContain('  provider: ollama');
    expect(yaml).toContain('  store: sqlite-vec');
    expect(yaml).toContain('  daily_usd: 10');
    expect(yaml).toContain('  alpha: 0.4');
    expect(yaml).toContain('  tier2Enabled: false');
    expect(yaml).toContain('  concurrency: 2'); // FEAT-482: default raised 1 -> 2
    expect(yaml).toContain('autoAcceptThreshold: null');
    expect(yaml).toContain('  enabled: false'); // capture.autoCapture.enabled (default)
  });

  it('emits a sync: block containing ONLY experimental — connection fields stay the intentional sync.json exclusion (sync-experimental-gate)', () => {
    const yaml = configToYaml(buildFullyPopulatedConfig());
    expect(yaml).toMatch(/^sync:/m);
    expect(yaml).toContain('  experimental: true');
    // Connection fields owned by sync.json must never leak into config.yaml,
    // even though buildFullyPopulatedConfig() sets non-default values for them.
    expect(yaml).not.toContain('workspaceId');
    expect(yaml).not.toContain('sync.example.com');
    expect(yaml).not.toMatch(/^\s+batchSize:/m);
    expect(yaml).not.toMatch(/^\s+intervalMs:/m);
  });
});

// FEAT-470 AC-1 (SLICE-420 re-review residual): hasNothingToEmit extended to
// treat an explicit empty string ('') the same as undefined, for
// STRING-typed optional fields only — matching the emitter's own truthy-omit
// conditionals (`cfg.azure.endpoint ? [...] : []`-style). Booleans/numbers
// have no such conditional (always emitted unconditionally), so a genuinely
// missing 0/false value must still be flagged.
describe('FEAT-470 AC-1: hasNothingToEmit matches the emitter\'s falsy-omit semantics for string fields', () => {
  it('does not flag an explicit empty-string optional field as missing', () => {
    const cfg = defaultConfig();
    cfg.azure.endpoint = '';
    const yaml = configToYaml(cfg);
    expect(yaml).not.toContain('endpoint:'); // emitter's truthy check omits it, same as undefined
    const missing = findMissingConfigKeys(cfg, yaml);
    expect(missing).not.toContain('azure.endpoint');
  });

  it('counter-test: a numeric 0 extra field is still flagged as missing (0 must not be treated as nothing-to-emit)', () => {
    const cfg = defaultConfig() as unknown as Record<string, unknown>;
    const withExtraNested = {
      ...cfg,
      consolidation: { ...(cfg['consolidation'] as Record<string, unknown>), futureNumericField: 0 },
    } as unknown as Config;
    const missing = findMissingConfigKeys(withExtraNested, configToYaml(withExtraNested));
    expect(missing).toContain('consolidation.futureNumericField');
  });

  it('counter-test: a boolean false extra field is still flagged as missing (false must not be treated as nothing-to-emit)', () => {
    const cfg = defaultConfig() as unknown as Record<string, unknown>;
    const withExtraNested = {
      ...cfg,
      consolidation: { ...(cfg['consolidation'] as Record<string, unknown>), futureBooleanField: false },
    } as unknown as Config;
    const missing = findMissingConfigKeys(withExtraNested, configToYaml(withExtraNested));
    expect(missing).toContain('consolidation.futureBooleanField');
  });
});

// FEAT-461 review fix (Finding 1, HIGH): a config.yaml written by this
// version and later read by an OLDER (pre-FEAT-461) daemon binary — e.g. via
// `reinstall --rollback`, a first-class supported path per CLAUDE.md — must
// not crash. The older `parseScalar` has no `[...]` array branch, so an
// always-emitted `customPatterns: []` would parse back as the literal string
// "[]" and crash `src/redact/index.ts`'s `.map()` call. The fix: only emit
// `customPatterns` when the user actually configured a non-empty list.
describe('FEAT-461 review fix: customPatterns omitted-when-empty (rollback compatibility)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omits the customPatterns line entirely for a default (empty-array) Config', () => {
    const yaml = configToYaml(defaultConfig());
    expect(yaml).not.toContain('customPatterns');
  });

  it('still emits and round-trips a non-empty customPatterns value', () => {
    const cfg = defaultConfig();
    cfg.security.redaction.customPatterns = ['SECRET-\\d+', 'sk-[a-zA-Z0-9]{20,}'];
    const yaml = configToYaml(cfg);
    expect(yaml).toContain(JSON.stringify(cfg.security.redaction.customPatterns));

    const path = tmpPath();
    writeConfig(cfg, path);
    const loaded = loadConfigFromDisk(dirname(path));
    expect(loaded.security.redaction.customPatterns).toEqual(cfg.security.redaction.customPatterns);
  });

  it('findMissingConfigKeys stays quiet about the empty-array omission for a default Config', () => {
    // customPatterns sits two levels deep (security -> redaction ->
    // customPatterns) — outside findMissingConfigKeys' documented one-level-
    // of-nesting scope regardless of whether it's emitted, so omitting it
    // when empty was never going to trip a false positive here. This test
    // pins that down explicitly rather than relying on the AC-2 tests above
    // to imply it.
    const missing = findMissingConfigKeys(defaultConfig(), configToYaml(defaultConfig()));
    expect(missing).toEqual([]);
  });

  it('does not warn (AC-3) about the empty-array omission for a default Config', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as never);
    configToYaml(defaultConfig());
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a populated customPatterns value is still guarded by the AC-1 exhaustive round-trip', () => {
    // buildFullyPopulatedConfig() sets a non-empty customPatterns — if a
    // future change stopped emitting it even when populated, the AC-1
    // round-trip test above would fail on a deep-equal mismatch. This test
    // just pins down that the fixture's value is indeed non-empty, so that
    // guarantee actually holds (an accidentally-emptied fixture would
    // silently stop testing anything here).
    const cfg = buildFullyPopulatedConfig();
    expect(cfg.security.redaction.customPatterns.length).toBeGreaterThan(0);
    expect(configToYaml(cfg)).toContain(JSON.stringify(cfg.security.redaction.customPatterns));
  });
});
