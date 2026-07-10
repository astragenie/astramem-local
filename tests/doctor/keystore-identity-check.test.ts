// FEAT-466 AC-5 — doctor surfaces which OS credential-store identity
// (scoped vs legacy) the running daemon is currently reading its db-key /
// bearer from. Exercised via the real "Encryption at rest" and "Bearer
// token location" doctor checks, with the Entry constructor stubbed so
// this never touches the real OS credential store.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { Entry } from '@napi-rs/keyring';
import { getChecks, type Check } from '../../src/doctor/checks.js';
import { __setEntryCtorForTests, storeBearer } from '../../src/storage/keystore.js';
import { defaultConfigDir } from '../../src/config/datadir.js';

function stubWorkingCredentialStore(): Map<string, string> {
  const store = new Map<string, string>();
  __setEntryCtorForTests(class {
    private key: string;
    constructor(service: string, account: string) {
      this.key = `${service}:${account}`;
    }
    getPassword(): string | null {
      return store.get(this.key) ?? null;
    }
    setPassword(p: string): void {
      store.set(this.key, p);
    }
    deleteCredential(): boolean {
      return store.delete(this.key);
    }
    deletePassword(): boolean {
      return store.delete(this.key);
    }
  } as unknown as typeof Entry);
  return store;
}

function findCheck(checks: Check[], name: string): Check {
  const c = checks.find(x => x.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

const ENV_KEY = platform() === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';

describe('doctor: keystore identity reporting (FEAT-466 AC-5)', () => {
  let savedEnv: string | undefined;
  let envDir: string;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    envDir = mkdtempSync(join(tmpdir(), 'astra-doctor-identity-'));
    process.env[ENV_KEY] = envDir;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    rmSync(envDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    __setEntryCtorForTests(undefined);
  });

  it('"Encryption at rest" reports the scoped identity for a fresh install', async () => {
    stubWorkingCredentialStore();
    const checks = getChecks({ dataDir: envDir, encryptionEnabled: true });
    const result = await findCheck(checks, 'Encryption at rest').run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('identity: scoped');
  });

  it('"Encryption at rest" reports the legacy identity when only a legacy db-key entry exists', async () => {
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:db-key', 'a'.repeat(64));

    const checks = getChecks({ dataDir: envDir, encryptionEnabled: true });
    const result = await findCheck(checks, 'Encryption at rest').run();
    expect(result.message).toContain('identity: legacy');
  });

  it('"Bearer token location" reports the scoped identity when a bearer is stored', async () => {
    stubWorkingCredentialStore();
    storeBearer('some-bearer-token', defaultConfigDir());

    const checks = getChecks({ dataDir: envDir, encryptionEnabled: true });
    const result = await findCheck(checks, 'Bearer token location').run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('identity: scoped');
  });

  it('"Bearer token location" reports the legacy identity when only a legacy bearer entry exists', async () => {
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:bearer', 'legacy-bearer-token');

    const checks = getChecks({ dataDir: envDir, encryptionEnabled: true });
    const result = await findCheck(checks, 'Bearer token location').run();
    expect(result.message).toContain('identity: legacy');
  });
});
