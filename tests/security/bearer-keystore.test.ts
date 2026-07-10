// Wave 1 task 1d — bearer token -> OS credential store (SEC-10).
// FEAT-466 — scoped credential-store identity per configDir, with a
// read-only fallback to the legacy unscoped identity, plus the
// ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass extended to the bearer.
//
// Mirrors the stub pattern from tests/security/encryption.test.ts: a fake
// Entry constructor installed via __setEntryCtorForTests so these tests
// exercise the real code paths (storeBearer/readBearer/resolveBearerToken)
// without touching the developer's real OS credential store.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { Entry } from '@napi-rs/keyring';

import {
  __setEntryCtorForTests,
  storeBearer,
  readBearer,
  getBearerIdentity,
  bearerFilePath,
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
  delete process.env.ASTRA_MEMORY_ISOLATED;
});

// ─────────────────────────────────────────────────────────────────────────
// storeBearer / readBearer: stubbed-Entry roundtrip
// ─────────────────────────────────────────────────────────────────────────

describe('storeBearer/readBearer: credential-store roundtrip', () => {
  it('stores and reads back a bearer, scoped to configDir, via a stubbed Entry — without touching the OS keychain', () => {
    const store = stubWorkingCredentialStore();
    const configDir = mkTmpDir('astramem-bearer-roundtrip-');
    const token = 'a'.repeat(64);

    const result = storeBearer(token, configDir);
    expect(result).toEqual({ stored: true, source: 'credential-store', identity: 'scoped' });
    // Scoped write never lands on the legacy unscoped key.
    expect(store.has('astramem-local:bearer')).toBe(false);

    expect(readBearer(configDir)).toBe(token);
    expect(getBearerIdentity(configDir)).toBe('scoped');
  });

  it('readBearer returns null when nothing has been stored yet', () => {
    stubWorkingCredentialStore();
    const configDir = mkTmpDir('astramem-bearer-empty-roundtrip-');
    expect(readBearer(configDir)).toBeNull();
    expect(getBearerIdentity(configDir)).toBe('none');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// storeBearer: fallback to secrets.env when Entry ctor throws
// ─────────────────────────────────────────────────────────────────────────

describe('storeBearer: credential store unavailable', () => {
  it('returns a fallback marker (does not throw) when the Entry constructor throws', () => {
    stubUnavailableCredentialStore();
    const configDir = mkTmpDir('astramem-bearer-unavailable-store-');
    const result = storeBearer('deadbeef'.repeat(8), configDir);
    expect(result).toEqual({ stored: false, source: 'secrets-env-fallback' });
  });

  it('readBearer returns null (rather than throwing) when the store is unavailable', () => {
    stubUnavailableCredentialStore();
    const configDir = mkTmpDir('astramem-bearer-unavailable-read-');
    expect(readBearer(configDir)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FEAT-466: scoped identity per configDir (AC-1) + legacy read-fallback (AC-2)
// ─────────────────────────────────────────────────────────────────────────

describe('FEAT-466: two-configDir scoping (AC-1) and legacy read-fallback (AC-2)', () => {
  it('two distinct configDirs write to independent scoped identities — neither clobbers the other (incident-class regression)', () => {
    const store = stubWorkingCredentialStore();
    const configA = mkTmpDir('astramem-bearer-scope-a-');
    const configB = mkTmpDir('astramem-bearer-scope-b-');

    storeBearer('token-a', configA);
    storeBearer('token-b', configB);

    expect(readBearer(configA)).toBe('token-a');
    expect(readBearer(configB)).toBe('token-b');
    // Neither write landed on the legacy key or clobbered the other's entry.
    expect(store.has('astramem-local:bearer')).toBe(false);
    expect(store.size).toBe(2);
  });

  it('reads fall back read-only to the legacy unscoped identity for pre-FEAT-466 installs', () => {
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:bearer', 'legacy-bearer'); // simulates a pre-FEAT-466 write

    const configDir = mkTmpDir('astramem-bearer-legacy-fallback-');
    expect(readBearer(configDir)).toBe('legacy-bearer');
    expect(getBearerIdentity(configDir)).toBe('legacy');

    // Read-only: the legacy entry is unchanged and nothing was written under
    // the scoped identity as a side effect of the read.
    expect(store.get('astramem-local:bearer')).toBe('legacy-bearer');
    expect(store.size).toBe(1);
  });

  it('once the scoped identity is populated, it takes priority over a stale legacy entry', () => {
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:bearer', 'legacy-bearer');

    const configDir = mkTmpDir('astramem-bearer-scoped-wins-');
    storeBearer('fresh-scoped-bearer', configDir);

    expect(readBearer(configDir)).toBe('fresh-scoped-bearer');
    expect(getBearerIdentity(configDir)).toBe('scoped');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FEAT-466: ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass for the bearer (AC-3/AC-4)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Stub Entry whose constructor throws on ANY invocation — used to prove the
 * bypass never even attempts to talk to the OS credential store, rather than
 * merely asserting the store ends up empty (which a differently-broken
 * implementation could satisfy by accident).
 */
function stubEntryThatMustNeverBeConstructed(): void {
  __setEntryCtorForTests(class {
    constructor(_service: string, _account: string) {
      throw new Error(
        'FEAT-466 regression: an OS credential-store Entry was constructed during a ' +
        'forced key-file bypass run — the bypass must never touch the real store.',
      );
    }
    getPassword(): string | null { throw new Error('unreachable'); }
    setPassword(_p: string): void { throw new Error('unreachable'); }
    deleteCredential(): boolean { return false; }
    deletePassword(): boolean { return false; }
  } as unknown as typeof Entry);
}

describe('FEAT-466: ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass for the bearer (AC-3/AC-4)', () => {
  afterEach(() => {
    delete process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE;
  });

  it('storeBearer never constructs an OS credential-store Entry when the bypass is set', () => {
    stubEntryThatMustNeverBeConstructed();
    process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE = '1';
    const configDir = mkTmpDir('astramem-bearer-bypass-store-');

    const result = storeBearer('bypassed-token', configDir);
    expect(result).toEqual({ stored: true, source: 'key-file' });
    expect(existsSync(bearerFilePath(configDir))).toBe(true);
    expect(readFileSync(bearerFilePath(configDir), 'utf8').trim()).toBe('bypassed-token');
  });

  it('readBearer never constructs an OS credential-store Entry when the bypass is set', () => {
    stubEntryThatMustNeverBeConstructed();
    process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE = '1';
    const configDir = mkTmpDir('astramem-bearer-bypass-read-');

    expect(readBearer(configDir)).toBeNull(); // nothing written yet; still no Entry constructed
    storeBearer('bypassed-token-2', configDir);
    expect(readBearer(configDir)).toBe('bypassed-token-2');
    expect(getBearerIdentity(configDir)).toBe('key-file');
  });

  it('AC-4: a before/after read of the (stubbed) "production" OS store is byte-identical across a bypassed sandboxed run', () => {
    // Reproduces the 2026-07-10 incident scenario: a "production" identity
    // already holds a real bearer in the credential store; a sandboxed run
    // with the bypass set must leave it completely untouched.
    const store = stubWorkingCredentialStore();
    const prodConfigDir = mkTmpDir('astramem-bearer-prod-');
    storeBearer('prod-bearer-token', prodConfigDir); // pre-existing "production" entry
    const before = new Map(store);

    process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE = '1';
    const sandboxConfigDir = mkTmpDir('astramem-bearer-sandbox-');
    storeBearer('sandbox-bearer-token', sandboxConfigDir);
    readBearer(sandboxConfigDir);

    const after = new Map(store);
    expect(after).toEqual(before); // byte-identical: the sandboxed run touched nothing in the store
    delete process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE;
    expect(readBearer(prodConfigDir)).toBe('prod-bearer-token'); // still intact
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

  it('credential store (read via legacy fallback) beats secrets.env when both are populated', () => {
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:bearer', 'store-token'); // legacy-identity entry

    const baseDir = mkTmpDir('astramem-bearer-precedence-');
    writeSecretsEnvBearer(baseDir, 'file-token');
    const result = resolveBearerToken({ secretsDirs: [baseDir], configDir: baseDir });
    expect(result).toEqual({ token: 'store-token', source: 'credential-store' });
  });

  it("falls back to the 'devtok' default when nothing is configured anywhere", () => {
    stubWorkingCredentialStore(); // empty store, no throw
    const baseDir = mkTmpDir('astramem-bearer-empty-');
    const result = resolveBearerToken({ secretsDirs: [baseDir], configDir: baseDir });
    expect(result).toEqual({ token: 'devtok', source: 'default' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveBearerToken: opportunistic promotion (file-only -> credential store)
// ─────────────────────────────────────────────────────────────────────────

describe('resolveBearerToken: one-way promotion from secrets.env', () => {
  it('promotes a file-only bearer into the (stubbed) credential store under the scoped identity, and leaves the file untouched', () => {
    const store = stubWorkingCredentialStore();
    const baseDir = mkTmpDir('astramem-bearer-promote-');

    writeSecretsEnvBearer(baseDir, 'file-only-token');
    const result = resolveBearerToken({ secretsDirs: [baseDir], configDir: baseDir });

    expect(result).toEqual({ token: 'file-only-token', source: 'secrets-env' });

    // Promoted into the scoped identity, never the legacy unscoped key.
    expect(store.has('astramem-local:bearer')).toBe(false);
    expect(readBearer(baseDir)).toBe('file-only-token');
    expect(getBearerIdentity(baseDir)).toBe('scoped');

    // secrets.env itself is untouched (still readable, same content).
    expect(readBearerFromSecretsFile([baseDir])).toBe('file-only-token');
  });

  it('a second resolveBearerToken call now hits the credential-store branch (promotion took effect)', () => {
    stubWorkingCredentialStore();
    const baseDir = mkTmpDir('astramem-bearer-promote-twice-');

    writeSecretsEnvBearer(baseDir, 'promote-me');
    const first = resolveBearerToken({ secretsDirs: [baseDir], configDir: baseDir });
    expect(first.source).toBe('secrets-env');

    const second = resolveBearerToken({ secretsDirs: [baseDir], configDir: baseDir });
    expect(second).toEqual({ token: 'promote-me', source: 'credential-store' });
  });

  it('promotion is best-effort: a still-unavailable credential store does not throw or lose the resolved token', () => {
    stubUnavailableCredentialStore();
    const baseDir = mkTmpDir('astramem-bearer-promote-fail-');

    writeSecretsEnvBearer(baseDir, 'file-only-token-2');
    const result = resolveBearerToken({ secretsDirs: [baseDir], configDir: baseDir });
    expect(result).toEqual({ token: 'file-only-token-2', source: 'secrets-env' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resolveBearerToken: ASTRA_MEMORY_ISOLATED=1 gate
// ─────────────────────────────────────────────────────────────────────────

describe('resolveBearerToken: ASTRA_MEMORY_ISOLATED=1', () => {
  it('ignores a bearer planted in secrets.env (even when secretsDirs points straight at it)', () => {
    process.env.ASTRA_MEMORY_ISOLATED = '1';
    stubWorkingCredentialStore();
    const baseDir = mkTmpDir('astramem-bearer-isolated-secrets-');
    writeSecretsEnvBearer(baseDir, 'real-dir-planted-token');

    const result = resolveBearerToken({ secretsDirs: [baseDir] });

    expect(result.source).toBe('ephemeral');
    expect(result.token).not.toBe('real-dir-planted-token');
  });

  it('ignores a bearer already present in the (stubbed) OS credential store', () => {
    process.env.ASTRA_MEMORY_ISOLATED = '1';
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:bearer', 'store-token');

    const result = resolveBearerToken({});

    expect(result.source).toBe('ephemeral');
    expect(result.token).not.toBe('store-token');
  });

  it('never promotes into the credential store while isolated', () => {
    process.env.ASTRA_MEMORY_ISOLATED = '1';
    const store = stubWorkingCredentialStore();
    const baseDir = mkTmpDir('astramem-bearer-isolated-no-promote-');
    writeSecretsEnvBearer(baseDir, 'file-only-token');

    resolveBearerToken({ secretsDirs: [baseDir] });

    expect(store.get('astramem-local:bearer')).toBeUndefined();
  });

  it('generates a fresh, high-entropy ephemeral token distinct across calls', () => {
    process.env.ASTRA_MEMORY_ISOLATED = '1';
    stubWorkingCredentialStore();

    const first = resolveBearerToken({});
    const second = resolveBearerToken({});

    expect(first.source).toBe('ephemeral');
    expect(second.source).toBe('ephemeral');
    expect(first.token).toHaveLength(64);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(first.token).not.toBe(second.token);
  });

  it('CLI flag still beats isolation', () => {
    process.env.ASTRA_MEMORY_ISOLATED = '1';
    const result = resolveBearerToken({ cliToken: 'cli-token' });
    expect(result).toEqual({ token: 'cli-token', source: 'cli' });
  });

  it('env var still beats isolation', () => {
    process.env.ASTRA_MEMORY_ISOLATED = '1';
    const result = resolveBearerToken({ envToken: 'env-token' });
    expect(result).toEqual({ token: 'env-token', source: 'env' });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Review fix-round: storeBearer's writeThroughLegacy option (rollback fix)
// ─────────────────────────────────────────────────────────────────────────

describe('storeBearer: writeThroughLegacy option (rollback-safety fix)', () => {
  it('without the option, a normal store never touches the legacy identity (unchanged FEAT-466 AC-1 behavior)', () => {
    const store = stubWorkingCredentialStore();
    const configDir = mkTmpDir('astramem-bearer-no-writethrough-');

    storeBearer('scoped-only-token', configDir);

    expect(store.has('astramem-local:bearer')).toBe(false);
  });

  it('with writeThroughLegacy: true, the token lands in BOTH the scoped and legacy identities', () => {
    const store = stubWorkingCredentialStore();
    const configDir = mkTmpDir('astramem-bearer-writethrough-');

    storeBearer('rotated-token', configDir, { writeThroughLegacy: true });

    expect(readBearer(configDir)).toBe('rotated-token'); // scoped read
    expect(store.get('astramem-local:bearer')).toBe('rotated-token'); // legacy read
  });

  it('writeThroughLegacy refreshes a STALE legacy entry left over from a pre-FEAT-466 install', () => {
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:bearer', 'stale-pre-upgrade-token');
    const configDir = mkTmpDir('astramem-bearer-writethrough-refresh-');

    storeBearer('fresh-rotated-token', configDir, { writeThroughLegacy: true });

    expect(store.get('astramem-local:bearer')).toBe('fresh-rotated-token');
    expect(store.get('astramem-local:bearer')).not.toBe('stale-pre-upgrade-token');
  });

  it('the ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass still never constructs any Entry, even with writeThroughLegacy: true', () => {
    stubEntryThatMustNeverBeConstructed();
    process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE = '1';
    const configDir = mkTmpDir('astramem-bearer-bypass-writethrough-');

    const result = storeBearer('bypassed-token', configDir, { writeThroughLegacy: true });
    expect(result).toEqual({ stored: true, source: 'key-file' });

    delete process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE;
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Review fix-round: rollback simulation — a pre-FEAT-466 binary's
// resolution order (legacy OS-store identity FIRST, then secrets.env, then
// the 'devtok' default — confirmed via `git show c947310:src/storage/
// bearer-keystore.ts`) must resolve the CURRENT token after a rotate, never
// a stale one and never the hard-coded default.
// ─────────────────────────────────────────────────────────────────────────

/** Mirrors the OLD (pre-FEAT-466) binary's bearer resolution precedence:
 * unscoped OS-store identity, then secrets.env, then 'devtok'. */
function simulateOldBinaryResolve(store: Map<string, string>, secretsPath: string): string {
  const legacy = store.get('astramem-local:bearer');
  if (legacy) return legacy;
  if (existsSync(secretsPath)) {
    const line = readFileSync(secretsPath, 'utf8')
      .split('\n')
      .find(l => l.startsWith('MEMORY_BEARER='));
    const fileToken = line?.slice('MEMORY_BEARER='.length).trim();
    if (fileToken) return fileToken;
  }
  return 'devtok';
}

describe('review fix-round: pre-FEAT-466 binary rollback simulation', () => {
  it('upgraded install (stale legacy entry pre-dates this release): old-binary resolution finds the NEW token after rotate, not the stale legacy one', () => {
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:bearer', 'stale-legacy-token'); // pre-existing, pre-upgrade entry
    const configDir = mkTmpDir('astramem-bearer-rollback-upgraded-');
    const secretsPath = join(configDir, 'secrets.env');
    writeSecretsEnvBearer(configDir, 'stale-legacy-token'); // secrets.env also stale pre-rotate

    storeBearer('rotated-token', configDir, { writeThroughLegacy: true }); // what rotateToken() does
    writeSecretsEnvBearer(configDir, 'rotated-token'); // what rotateToken()'s writeSecrets call does

    expect(simulateOldBinaryResolve(store, secretsPath)).toBe('rotated-token');
    expect(simulateOldBinaryResolve(store, secretsPath)).not.toBe('stale-legacy-token');
  });

  it('fresh install (no pre-existing legacy entry): old-binary resolution finds the NEW token via secrets.env, never falls through to the devtok default', () => {
    const store = stubWorkingCredentialStore(); // empty — no legacy entry ever existed
    const configDir = mkTmpDir('astramem-bearer-rollback-fresh-');
    const secretsPath = join(configDir, 'secrets.env');

    storeBearer('rotated-token', configDir, { writeThroughLegacy: true });
    writeSecretsEnvBearer(configDir, 'rotated-token');

    expect(simulateOldBinaryResolve(store, secretsPath)).toBe('rotated-token');
    expect(simulateOldBinaryResolve(store, secretsPath)).not.toBe('devtok');
  });

  it('devtok fall-through is impossible post-rotate even when the OS credential store is completely unavailable (secrets.env alone rescues it)', () => {
    stubUnavailableCredentialStore();
    const configDir = mkTmpDir('astramem-bearer-rollback-store-down-');
    const secretsPath = join(configDir, 'secrets.env');

    const result = storeBearer('rotated-token', configDir, { writeThroughLegacy: true });
    expect(result.stored).toBe(false); // OS store unavailable; caller falls back to secrets.env
    writeSecretsEnvBearer(configDir, 'rotated-token'); // what rotateToken() always does now

    const noLegacyEntry = new Map<string, string>(); // OS store was never reachable at all
    expect(simulateOldBinaryResolve(noLegacyEntry, secretsPath)).toBe('rotated-token');
    expect(simulateOldBinaryResolve(noLegacyEntry, secretsPath)).not.toBe('devtok');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Review fix-round: configDir normalization before hashing
// ─────────────────────────────────────────────────────────────────────────

describe('review fix-round: configDir normalization (scopedService)', () => {
  it('a trailing separator does not change the scoped identity', () => {
    const store = stubWorkingCredentialStore();
    const configDir = mkTmpDir('astramem-bearer-normalize-trailing-');

    storeBearer('normalized-token', configDir);
    expect(readBearer(configDir + (platform() === 'win32' ? '\\' : '/'))).toBe('normalized-token');
    expect(store.size).toBe(1);
  });

  it('Windows-only: case and forward/backward slash variants of the same directory all resolve to one identity', () => {
    if (platform() !== 'win32') return;
    const store = stubWorkingCredentialStore();
    const configDir = mkTmpDir('astramem-bearer-normalize-winforms-');

    storeBearer('normalized-token', configDir);

    const spellings = [
      configDir.toUpperCase(),
      configDir.toLowerCase(),
      configDir.replace(/\\/g, '/'),
      configDir + '\\',
    ];
    for (const spelling of spellings) {
      expect(readBearer(spelling)).toBe('normalized-token');
    }
    expect(store.size).toBe(1); // only one scoped entry, not five
  });
});
