// Wave 1 task 1d — bearer token -> OS credential store (SEC-10).
//
// Mirrors the stub pattern from tests/security/encryption.test.ts: a fake
// Entry constructor installed via __setEntryCtorForTests so these tests
// exercise the real code paths (storeBearer/readBearer/resolveBearerToken)
// without touching the developer's real OS credential store.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Entry } from '@napi-rs/keyring';

import {
  __setEntryCtorForTests,
  storeBearer,
  readBearer,
} from '../../src/storage/keystore.js';
import {
  resolveBearerToken,
  readBearerFromSecretsFile,
} from '../../src/storage/bearer-keystore.js';

let tmpDirs: string[] = [];

function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** Stub Entry backed by an in-memory Map — simulates a working credential store. */
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

/** Stub Entry that always throws — simulates an unavailable credential store. */
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

// Isolation strategy: resolveBearerToken/readBearerFromSecretsFile accept an
// explicit `secretsDirs` list, so tests point them at a tmp dir directly.
// (Env-var stubbing does NOT isolate on darwin — defaultConfigDir() ignores
// XDG_CONFIG_HOME there and the tests would read/write the REAL config dir.)

function writeSecretsEnvBearer(resolvedConfigDir: string, bearer: string): void {
  mkdirSync(resolvedConfigDir, { recursive: true });
  writeFileSync(join(resolvedConfigDir, 'secrets.env'), `MEMORY_BEARER=${bearer}\n`, 'utf8');
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  tmpDirs = [];
  __setEntryCtorForTests(undefined); // restore real Entry after any stubbing
});

// ─────────────────────────────────────────────────────────────────────────
// storeBearer / readBearer: stubbed-Entry roundtrip
// ─────────────────────────────────────────────────────────────────────────

describe('storeBearer/readBearer: credential-store roundtrip', () => {
  it('stores and reads back a bearer via a stubbed Entry, without touching the OS keychain', () => {
    const store = stubWorkingCredentialStore();
    const token = 'a'.repeat(64);

    const result = storeBearer(token);
    expect(result).toEqual({ stored: true, source: 'credential-store' });
    expect(store.get('astramem-local:bearer')).toBe(token);

    expect(readBearer()).toBe(token);
  });

  it('readBearer returns null when nothing has been stored yet', () => {
    stubWorkingCredentialStore();
    expect(readBearer()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// storeBearer: fallback to secrets.env when Entry ctor throws
// ─────────────────────────────────────────────────────────────────────────

describe('storeBearer: credential store unavailable', () => {
  it('returns a fallback marker (does not throw) when the Entry constructor throws', () => {
    stubUnavailableCredentialStore();
    const result = storeBearer('deadbeef'.repeat(8));
    expect(result).toEqual({ stored: false, source: 'secrets-env-fallback' });
  });

  it('readBearer returns null (rather than throwing) when the store is unavailable', () => {
    stubUnavailableCredentialStore();
    expect(readBearer()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveBearerToken: resolution precedence
// ─────────────────────────────────────────────────────────────────────────

describe('resolveBearerToken: precedence', () => {
  it('CLI flag beats everything else', () => {
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:bearer', 'store-token');
    const result = resolveBearerToken({ cliToken: 'cli-token', envToken: 'env-token' });
    expect(result).toEqual({ token: 'cli-token', source: 'cli' });
  });

  it('env var beats the credential store', () => {
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:bearer', 'store-token');
    const result = resolveBearerToken({ envToken: 'env-token' });
    expect(result).toEqual({ token: 'env-token', source: 'env' });
  });

  it('credential store beats secrets.env when both are populated', () => {
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:bearer', 'store-token');

    const baseDir = mkTmpDir('astramem-bearer-precedence-');
    writeSecretsEnvBearer(baseDir, 'file-token');
    const result = resolveBearerToken({ secretsDirs: [baseDir] });
    expect(result).toEqual({ token: 'store-token', source: 'credential-store' });
  });

  it("falls back to the 'devtok' default when nothing is configured anywhere", () => {
    stubWorkingCredentialStore(); // empty store, no throw
    const baseDir = mkTmpDir('astramem-bearer-empty-');
    const result = resolveBearerToken({ secretsDirs: [baseDir] });
    expect(result).toEqual({ token: 'devtok', source: 'default' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveBearerToken: opportunistic promotion (file-only -> credential store)
// ─────────────────────────────────────────────────────────────────────────

describe('resolveBearerToken: one-way promotion from secrets.env', () => {
  it('promotes a file-only bearer into the (stubbed) credential store, and leaves the file untouched', () => {
    const store = stubWorkingCredentialStore();
    const baseDir = mkTmpDir('astramem-bearer-promote-');

    writeSecretsEnvBearer(baseDir, 'file-only-token');
    const result = resolveBearerToken({ secretsDirs: [baseDir] });

    expect(result).toEqual({ token: 'file-only-token', source: 'secrets-env' });

    // After the read, the stubbed store now holds the promoted token.
    expect(store.get('astramem-local:bearer')).toBe('file-only-token');
    expect(readBearer()).toBe('file-only-token');

    // secrets.env itself is untouched (still readable, same content).
    expect(readBearerFromSecretsFile([baseDir])).toBe('file-only-token');
  });

  it('a second resolveBearerToken call now hits the credential-store branch (promotion took effect)', () => {
    stubWorkingCredentialStore();
    const baseDir = mkTmpDir('astramem-bearer-promote-twice-');

    writeSecretsEnvBearer(baseDir, 'promote-me');
    const first = resolveBearerToken({ secretsDirs: [baseDir] });
    expect(first.source).toBe('secrets-env');

    const second = resolveBearerToken({ secretsDirs: [baseDir] });
    expect(second).toEqual({ token: 'promote-me', source: 'credential-store' });
  });

  it('promotion is best-effort: a still-unavailable credential store does not throw or lose the resolved token', () => {
    stubUnavailableCredentialStore();
    const baseDir = mkTmpDir('astramem-bearer-promote-fail-');

    writeSecretsEnvBearer(baseDir, 'file-only-token-2');
    const result = resolveBearerToken({ secretsDirs: [baseDir] });
    expect(result).toEqual({ token: 'file-only-token-2', source: 'secrets-env' });
  });
});
