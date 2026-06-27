import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { configToYaml, writeConfig } from '../../src/config/writer.js';
import { defaultConfig } from '../../src/config/config.js';

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
    expect(yaml).toMatch(/model: ['"]?qwen2\.5-coder:7b['"]?/);
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
