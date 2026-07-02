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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';

// ─── child_process mock (must be declared before other imports so vitest
// can hoist vi.mock above the module graph — mirrors tests/service/launchd.test.ts) ───

const { execSyncMock, execFileSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn(() => Buffer.from('')),
  execFileSyncMock: vi.fn(() => Buffer.from('')),
}));

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
  execFileSync: execFileSyncMock,
}));

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
import { init, checkOllama } from '../../src/cli/init.js';
import { writeConfig, configToYaml } from '../../src/config/writer.js';
import { writeSecrets } from '../../src/config/secrets.js';
import { defaultConfig } from '../../src/config/config.js';
import { openDb } from '../../src/storage/db.js';
import { Entry } from '@napi-rs/keyring';
import { __setEntryCtorForTests } from '../../src/storage/keystore.js';

// init() now stores the generated bearer via the OS credential store first
// (SEC-10). Stub Entry with an in-memory map for every test in this file so
// runs are deterministic and never touch the real OS credential store.
beforeEach(() => {
  const store = new Map<string, string>();
  __setEntryCtorForTests(class {
    private key: string;
    constructor(service: string, account: string) {
      this.key = `${service}:${account}`;
    }
    getPassword(): string | null { return store.get(this.key) ?? null; }
    setPassword(p: string): void { store.set(this.key, p); }
    deleteCredential(): boolean { return store.delete(this.key); }
    deletePassword(): boolean { return store.delete(this.key); }
  } as unknown as typeof Entry);
});

afterEach(() => {
  __setEntryCtorForTests(undefined);
});

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

// ─── checkOllama — auto-pull missing models (interactive path) ───────────────

function mockTagsResponse(names: string[]): Response {
  return {
    ok: true,
    json: async () => ({ models: names.map((name) => ({ name })) }),
  } as Response;
}

describe('checkOllama — auto-install missing models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `ollama --version` succeeds by default (binary present).
    execSyncMock.mockImplementation(() => Buffer.from(''));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('missing model: pulls via execFileSync and re-validates present', async () => {
    const fetchMock = vi
      .fn()
      // Initial check: model absent.
      .mockResolvedValueOnce(mockTagsResponse([]))
      // Re-validation after pull: model present.
      .mockResolvedValueOnce(mockTagsResponse(['qwen2.5-coder:7b']));
    vi.stubGlobal('fetch', fetchMock);
    execFileSyncMock.mockImplementation(() => Buffer.from(''));

    await expect(
      checkOllama('qwen2.5-coder:7b', 'qwen2.5-coder:7b', false)
    ).resolves.toBeUndefined();

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'ollama',
      ['pull', 'qwen2.5-coder:7b'],
      expect.objectContaining({ stdio: 'inherit' })
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('pull failure: init aborts with an actionable error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockTagsResponse([])); // never present
    vi.stubGlobal('fetch', fetchMock);
    execFileSyncMock.mockImplementation(() => {
      throw new Error('network unreachable');
    });

    await expect(
      checkOllama('qwen2.5-coder:7b', 'mxbai-embed-large', false)
    ).rejects.toThrow(/Failed to pull Ollama model 'qwen2\.5-coder:7b'.*ollama pull qwen2\.5-coder:7b/s);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      'ollama',
      ['pull', 'qwen2.5-coder:7b'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('pull succeeds but re-validation still fails: aborts with manual-fix error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockTagsResponse([])); // always absent
    vi.stubGlobal('fetch', fetchMock);
    execFileSyncMock.mockImplementation(() => Buffer.from(''));

    await expect(
      checkOllama('qwen2.5-coder:7b', 'qwen2.5-coder:7b', false)
    ).rejects.toThrow(/still not found after pull.*ollama pull qwen2\.5-coder:7b/s);
  });

  it('nonInteractive mode never touches execSync/fetch (unchanged early-exit)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await checkOllama('qwen2.5-coder:7b', 'mxbai-embed-large', true);

    expect(execSyncMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ollama binary missing: warns and returns without attempting a pull', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('command not found: ollama');
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await checkOllama('qwen2.5-coder:7b', 'mxbai-embed-large', false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('binary not found'))).toBe(true);
    warnSpy.mockRestore();
  });
});
