import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { configToYaml, writeConfig } from '../../src/config/writer.js';
import { defaultConfig } from '../../src/config/config.js';

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
    expect(yaml).toMatch(/model: ['"]?qwen2\.5:7b['"]?/);
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
