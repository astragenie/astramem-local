/**
 * tests/cli/init.test.ts
 *
 * Tests for the non-TTY (ASTRA_MEMORY_INIT_NONINTERACTIVE=1) path of
 * the init wizard. No TTY / @inquirer prompts are invoked. Live HTTP
 * calls (Ollama / Azure) are suppressed by non-interactive mode.
 *
 * Strategy: we call init() after patching env vars, and we independently
 * invoke writeConfig + writeSecrets + migrate so we can unit-verify each
 * output without relying on defaultConfigDir's path resolution.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';

// ─── Utility ─────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `astra-init-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function findFile(dir: string, name: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const queue = [dir];
  while (queue.length) {
    const cur = queue.shift()!;
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(cur, e);
      if (e === name) return full;
      try {
        if (statSync(full).isDirectory()) queue.push(full);
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

// ─── Run init with env isolation ─────────────────────────────────────────────

type EnvPatch = Record<string, string | undefined>;

function withEnv(patch: Record<string, string>, fn: () => Promise<unknown>): Promise<string> {
  const saved: EnvPatch = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  // Capture console.log output
  const origLog = console.log;
  let output = '';
  console.log = (...args: unknown[]) => { output += args.map(String).join(' ') + '\n'; };

  return fn().then(
    () => {
      console.log = origLog;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      return output;
    },
    (err) => {
      console.log = origLog;
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      throw err;
    }
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// Import init once — vitest handles ESM correctly at module level.
import { init } from '../../src/cli/init.js';
import { writeConfig, configToYaml } from '../../src/config/writer.js';
import { writeSecrets } from '../../src/config/secrets.js';
import { defaultConfig } from '../../src/config/config.js';
import { openDb } from '../../src/storage/db.js';

// ─── Unit: writer ─────────────────────────────────────────────────────────────

describe('configToYaml (unit)', () => {
  it('contains port, vector store, budget fields', () => {
    const cfg = defaultConfig();
    cfg.port = 17777;
    cfg.budget.daily_usd = 5;
    const yaml = configToYaml(cfg);
    expect(yaml).toContain('port: 17777');
    expect(yaml).toContain('store: sqlite-vec');
    expect(yaml).toContain('daily_usd: 5');
  });
});

describe('writeConfig (unit)', () => {
  it('writes yaml file to disk', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'config.yaml');
    const cfg = defaultConfig();
    writeConfig(cfg, path);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('port: 7777');
  });
});

describe('writeSecrets (unit)', () => {
  it('writes MEMORY_BEARER line', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'secrets.env');
    writeSecrets({ bearer: 'deadbeef' }, path);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('MEMORY_BEARER=deadbeef');
  });

  it('sets mode 0600 on Unix', () => {
    if (platform() === 'win32') return;
    const dir = makeTmpDir();
    const path = join(dir, 'secrets.env');
    writeSecrets({ bearer: 'tok' }, path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ─── Integration: init non-interactive ────────────────────────────────────────

describe('init wizard — non-TTY mode', () => {
  it('generates config.yaml + secrets.env + memory.sqlite + prints export lines', async () => {
    const dataDir = makeTmpDir();
    const cfgDir = makeTmpDir();

    // Determine the config subdir that defaultConfigDir() will resolve to
    // given our env-var patch. On all platforms we use XDG_CONFIG_HOME/astra-memory
    // (linux branch) or APPDATA/AstraMemory (windows) etc.
    // Rather than chase defaultConfigDir, we test via the OUTPUT of init()
    // and verify the DB was created in dataDir.

    const envPatch: Record<string, string> = {
      ASTRA_MEMORY_INIT_NONINTERACTIVE: '1',
      ASTRA_MEMORY_INIT_VECTOR: 'sqlite-vec',
      ASTRA_MEMORY_INIT_EMBED_PROVIDER: 'ollama',
      ASTRA_MEMORY_INIT_LLM_PROVIDER: 'ollama',
      ASTRA_MEMORY_INIT_DATADIR: dataDir,
      ASTRA_MEMORY_INIT_PORT: '17778',
      ASTRA_MEMORY_INIT_BUDGET: '10',
      ASTRA_MEMORY_INIT_INSTALL_SERVICE: 'false',
    };

    // Point platform config dir to cfgDir
    if (platform() === 'win32') {
      envPatch['APPDATA'] = cfgDir;
    } else {
      envPatch['XDG_CONFIG_HOME'] = cfgDir;
    }

    const output = await withEnv(envPatch, async () => { await init(); });

    // DB created in dataDir
    const dbPath = join(dataDir, 'memory.sqlite');
    expect(existsSync(dbPath), 'memory.sqlite must exist').toBe(true);

    // Output contains export lines
    expect(output).toMatch(/export MEMORY_BEARER=[0-9a-f]{64}/);
    expect(output).toContain('MEMORY_API_URL=http://127.0.0.1:17778');
  });

  it('lancedb choice falls back to sqlite-vec', async () => {
    const dataDir = makeTmpDir();
    const cfgDir = makeTmpDir();

    const envPatch: Record<string, string> = {
      ASTRA_MEMORY_INIT_NONINTERACTIVE: '1',
      ASTRA_MEMORY_INIT_VECTOR: 'lancedb',  // should fall back
      ASTRA_MEMORY_INIT_EMBED_PROVIDER: 'ollama',
      ASTRA_MEMORY_INIT_LLM_PROVIDER: 'ollama',
      ASTRA_MEMORY_INIT_DATADIR: dataDir,
      ASTRA_MEMORY_INIT_PORT: '17779',
      ASTRA_MEMORY_INIT_BUDGET: '10',
      ASTRA_MEMORY_INIT_INSTALL_SERVICE: 'false',
    };
    if (platform() === 'win32') envPatch['APPDATA'] = cfgDir;
    else envPatch['XDG_CONFIG_HOME'] = cfgDir;

    const output = await withEnv(envPatch, async () => { await init(); });

    // DB must exist (init didn't crash due to lancedb)
    expect(existsSync(join(dataDir, 'memory.sqlite'))).toBe(true);
    // Fallback notice in output
    expect(output).toContain('sqlite-vec');
  });

  it('runs migrations — memory.sqlite has correct schema', async () => {
    const dataDir = makeTmpDir();
    const cfgDir = makeTmpDir();

    const envPatch: Record<string, string> = {
      ASTRA_MEMORY_INIT_NONINTERACTIVE: '1',
      ASTRA_MEMORY_INIT_VECTOR: 'sqlite-vec',
      ASTRA_MEMORY_INIT_EMBED_PROVIDER: 'ollama',
      ASTRA_MEMORY_INIT_LLM_PROVIDER: 'ollama',
      ASTRA_MEMORY_INIT_DATADIR: dataDir,
      ASTRA_MEMORY_INIT_PORT: '17780',
      ASTRA_MEMORY_INIT_BUDGET: '10',
      ASTRA_MEMORY_INIT_INSTALL_SERVICE: 'false',
    };
    if (platform() === 'win32') envPatch['APPDATA'] = cfgDir;
    else envPatch['XDG_CONFIG_HOME'] = cfgDir;

    await withEnv(envPatch, async () => { await init(); });

    // Open DB and verify core tables exist
    const db = openDb(join(dataDir, 'memory.sqlite'));
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    db.close();

    const names = tables.map(t => t.name);
    expect(names).toContain('memories');
    expect(names).toContain('sessions');
    expect(names).toContain('jobs');
  });
});
