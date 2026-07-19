/**
 * Provider-aware distill defaults (2026-07-19, codex-only tuning): when the
 * EFFECTIVE extraction provider is codex-subscription, the loader's BASE
 * defaults become compaction 'never' + chunkConcurrency 3 (cloud extractor —
 * compaction is a wasted metered call + measured typeAcc harm; concurrency 3
 * stays under the 20/min client rate limit). An ollama provider on disk gets
 * the NEUTRAL small-model defaults, and any distill key explicitly present
 * on disk always wins over either flavor of default.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProviderAwareDistillDefaults, defaultConfig } from '../../src/config/config.js';
import { loadConfigFromDisk } from '../../src/config/loader.js';

describe('provider-aware distill defaults on the real loadConfigFromDisk boot path', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const writeCfg = (yaml: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-provider-aware-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'config.yaml'), yaml, 'utf8');
    return dir;
  };

  it('no config file at all → shipped default provider (codex) gets codex-optimized defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-provider-aware-'));
    tmpDirs.push(dir);
    const loaded = loadConfigFromDisk(dir);
    expect(defaultConfig().llm.extraction.provider).toBe('codex-subscription'); // guards the premise
    expect(loaded.distill.compaction).toBe('never');
    expect(loaded.distill.chunkConcurrency).toBe(3);
  });

  it('disk config with codex extraction and no distill keys → codex-optimized defaults', () => {
    const dir = writeCfg(['llm:', '  extraction:', '    provider: codex-subscription', "    model: 'gpt-5.4-mini'", ''].join('\n'));
    const loaded = loadConfigFromDisk(dir);
    expect(loaded.distill.compaction).toBe('never');
    expect(loaded.distill.chunkConcurrency).toBe(3);
  });

  it('disk config with OLLAMA extraction → neutral small-model defaults, NOT the codex ones', () => {
    const dir = writeCfg(['llm:', '  extraction:', '    provider: ollama', "    model: 'qwen2.5:7b'", ''].join('\n'));
    const loaded = loadConfigFromDisk(dir);
    expect(loaded.distill.compaction).toBe('auto');
    expect(loaded.distill.chunkConcurrency).toBe(2);
  });

  it('explicit distill keys on disk beat the codex-optimized defaults', () => {
    const dir = writeCfg([
      'llm:', '  extraction:', '    provider: codex-subscription', "    model: 'gpt-5.4-mini'",
      'distill:', '  compaction: always', '  chunkConcurrency: 1', '',
    ].join('\n'));
    const loaded = loadConfigFromDisk(dir);
    expect(loaded.distill.compaction).toBe('always');
    expect(loaded.distill.chunkConcurrency).toBe(1);
  });

  it('maxChunkChars default is deliberately unchanged pending the chunk-size A/B', () => {
    const dir = writeCfg(['llm:', '  extraction:', '    provider: codex-subscription', "    model: 'gpt-5.4-mini'", ''].join('\n'));
    const loaded = loadConfigFromDisk(dir);
    expect(loaded.distill.maxChunkChars).toBe(3200);
  });

  it('applyProviderAwareDistillDefaults is a no-op for non-codex providers', () => {
    const base = defaultConfig();
    expect(applyProviderAwareDistillDefaults(base, 'ollama')).toBe(base);
    expect(applyProviderAwareDistillDefaults(base, undefined)).toBe(base);
  });
});
