import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { Entry } from '@napi-rs/keyring';
import { generateToken, rotateToken } from '../../src/cli/token.js';
import { __setEntryCtorForTests, readBearer } from '../../src/storage/keystore.js';

function tmpSecretsPath(): string {
  const dir = join(tmpdir(), `astra-token-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'secrets.env');
}

/** Stub Entry that always throws — simulates an unavailable credential store
 * (headless Linux, no secret-service/dbus session). Forces rotateToken()
 * down the secrets.env fallback path deterministically. */
function stubUnavailableCredentialStore(): void {
  __setEntryCtorForTests(class {
    constructor(_service: string, _account: string) {
      throw new Error('simulated: no secret-service/dbus session (headless Linux)');
    }
    getPassword(): string | null { throw new Error('unreachable'); }
    setPassword(_p: string): void { throw new Error('unreachable'); }
    deleteCredential(): boolean { return false; }
    deletePassword(): boolean { return false; }
  } as unknown as typeof Entry);
}

/** Stub Entry backed by an in-memory Map — simulates a working credential
 * store without touching the real OS keychain. */
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

afterEach(() => {
  __setEntryCtorForTests(undefined); // restore real Entry after any stubbing
});

describe('generateToken', () => {
  it('returns a 64-character hex string', () => {
    const tok = generateToken();
    expect(tok).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(tok)).toBe(true);
  });

  it('generates unique tokens on each call', () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1).not.toBe(t2);
  });
});

// ─── rotateToken: credential-store unavailable → secrets.env fallback ───────
// (SEC-10: same degradation pattern as keystore.ts db-key.)

describe('rotateToken — credential store unavailable (secrets.env fallback)', () => {
  it('writes the new 64-char hex token to secrets.env', () => {
    stubUnavailableCredentialStore();
    const path = tmpSecretsPath();
    const token = rotateToken(path);
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain(`MEMORY_BEARER=${token}`);
  });

  it('sets file mode 0600 on Unix', () => {
    if (platform() === 'win32') return; // skip mode check on Windows
    stubUnavailableCredentialStore();
    const path = tmpSecretsPath();
    rotateToken(path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('generates a fresh token each call (invalidates old)', () => {
    stubUnavailableCredentialStore();
    const path = tmpSecretsPath();
    const t1 = rotateToken(path);
    const t2 = rotateToken(path);
    expect(t1).not.toBe(t2);
    // File contains the latest token
    const content = readFileSync(path, 'utf8');
    expect(content).toContain(`MEMORY_BEARER=${t2}`);
    expect(content).not.toContain(`MEMORY_BEARER=${t1}`);
  });

  it('preserves existing azure keys when rotating', async () => {
    stubUnavailableCredentialStore();
    const path = tmpSecretsPath();
    const { writeSecrets } = await import('../../src/config/secrets.js');
    writeSecrets({ bearer: 'oldtoken', azureKey: 'myazurekey', azureEndpoint: 'https://ep.openai.azure.com' }, path);

    const newToken = rotateToken(path);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain(`MEMORY_BEARER=${newToken}`);
    expect(content).toContain('AZURE_OPENAI_API_KEY=myazurekey');
    expect(content).toContain('AZURE_OPENAI_ENDPOINT=https://ep.openai.azure.com');
  });
});

// ─── rotateToken: credential store available (SEC-10 primary path) ──────────

describe('rotateToken — credential store available', () => {
  it('stores the bearer in the credential store and omits it from secrets.env', () => {
    const store = stubWorkingCredentialStore();
    const path = tmpSecretsPath();
    const token = rotateToken(path);

    expect(readBearer()).toBe(token);
    expect(store.get('astramem-local:bearer')).toBe(token);

    const content = readFileSync(path, 'utf8');
    expect(content).not.toContain('MEMORY_BEARER=');
  });

  it('still preserves existing azure keys in secrets.env even when the bearer moves to the store', async () => {
    stubWorkingCredentialStore();
    const path = tmpSecretsPath();
    const { writeSecrets } = await import('../../src/config/secrets.js');
    writeSecrets({ bearer: 'oldtoken', azureKey: 'myazurekey' }, path);

    rotateToken(path);
    const content = readFileSync(path, 'utf8');
    expect(content).not.toContain('MEMORY_BEARER=');
    expect(content).toContain('AZURE_OPENAI_API_KEY=myazurekey');
  });
});
