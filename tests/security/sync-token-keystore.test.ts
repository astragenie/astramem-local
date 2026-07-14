// FEAT-472 — sync device token: per-configDir scoped credential-store
// identity, read-only legacy fallback, and the ASTRA_MEMORY_TEST_FORCE_KEYFILE
// bypass — mirrors the FEAT-466 bearer scoping 1:1 (tests/security/
// bearer-keystore.test.ts). Kept as a sibling file rather than appended to
// that one since bearer-keystore.test.ts already covers a second concern
// (resolveBearerToken precedence) that has no sync-token analog.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Entry } from '@napi-rs/keyring';

import {
  __setEntryCtorForTests,
  storeSyncToken,
  readSyncToken,
  getSyncTokenIdentity,
  syncTokenFilePath,
} from '../../src/storage/keystore.js';

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

/**
 * Stub Entry whose constructor throws on ANY invocation — proves the
 * ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass never even attempts to talk to the
 * OS credential store, rather than merely asserting the store ends up empty.
 */
function stubEntryThatMustNeverBeConstructed(): void {
  __setEntryCtorForTests(class {
    constructor(_service: string, _account: string) {
      throw new Error(
        'FEAT-472 regression: an OS credential-store Entry was constructed during a ' +
        'forced key-file bypass run — the bypass must never touch the real store.',
      );
    }
    getPassword(): string | null { throw new Error('unreachable'); }
    setPassword(_p: string): void { throw new Error('unreachable'); }
    deleteCredential(): boolean { return false; }
    deletePassword(): boolean { return false; }
  } as unknown as typeof Entry);
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  tmpDirs = [];
  __setEntryCtorForTests(undefined); // restore real Entry after any stubbing
  delete process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE;
});

// ─────────────────────────────────────────────────────────────────────────
// storeSyncToken / readSyncToken: stubbed-Entry roundtrip
// ─────────────────────────────────────────────────────────────────────────

describe('storeSyncToken/readSyncToken: credential-store roundtrip', () => {
  it('stores and reads back a sync device token, scoped to configDir, via a stubbed Entry — without touching the OS keychain', () => {
    const store = stubWorkingCredentialStore();
    const configDir = mkTmpDir('astramem-synctoken-roundtrip-');
    const token = 'ak_' + 'a'.repeat(40);

    const result = storeSyncToken(token, configDir);
    expect(result).toEqual({ stored: true, source: 'credential-store', identity: 'scoped' });
    // Scoped write never lands on the legacy unscoped key.
    expect(store.has('astramem-local:sync-device-token')).toBe(false);

    expect(readSyncToken(configDir)).toBe(token);
    expect(getSyncTokenIdentity(configDir)).toBe('scoped');
  });

  it('readSyncToken returns null when nothing has been stored yet', () => {
    stubWorkingCredentialStore();
    const configDir = mkTmpDir('astramem-synctoken-empty-');
    expect(readSyncToken(configDir)).toBeNull();
    expect(getSyncTokenIdentity(configDir)).toBe('none');
  });
});

describe('storeSyncToken: credential store unavailable', () => {
  it('returns a fallback marker (does not throw) when the Entry constructor throws', () => {
    stubUnavailableCredentialStore();
    const configDir = mkTmpDir('astramem-synctoken-unavailable-store-');
    const result = storeSyncToken('deadbeef'.repeat(8), configDir);
    expect(result).toEqual({ stored: false, source: 'secrets-env-fallback' });
  });

  it('readSyncToken returns null (rather than throwing) when the store is unavailable', () => {
    stubUnavailableCredentialStore();
    const configDir = mkTmpDir('astramem-synctoken-unavailable-read-');
    expect(readSyncToken(configDir)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FEAT-472: two-configDir no-cross-clobber (incident-class regression)
// ─────────────────────────────────────────────────────────────────────────

describe('FEAT-472: two-configDir scoping — no cross-clobber', () => {
  it('two distinct configDirs write to independent scoped identities — neither clobbers the other', () => {
    const store = stubWorkingCredentialStore();
    const configA = mkTmpDir('astramem-synctoken-scope-a-');
    const configB = mkTmpDir('astramem-synctoken-scope-b-');

    storeSyncToken('token-a', configA);
    storeSyncToken('token-b', configB);

    expect(readSyncToken(configA)).toBe('token-a');
    expect(readSyncToken(configB)).toBe('token-b');
    // Neither write landed on the legacy key or clobbered the other's entry.
    expect(store.has('astramem-local:sync-device-token')).toBe(false);
    expect(store.size).toBe(2);
  });

  it('reads fall back read-only to the legacy unscoped identity for pre-FEAT-472 installs', () => {
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:sync-device-token', 'legacy-sync-token'); // simulates a pre-FEAT-472 write

    const configDir = mkTmpDir('astramem-synctoken-legacy-fallback-');
    expect(readSyncToken(configDir)).toBe('legacy-sync-token');
    expect(getSyncTokenIdentity(configDir)).toBe('legacy');

    // Read-only: the legacy entry is unchanged and nothing was written under
    // the scoped identity as a side effect of the read.
    expect(store.get('astramem-local:sync-device-token')).toBe('legacy-sync-token');
    expect(store.size).toBe(1);
  });

  it('once the scoped identity is populated, it takes priority over a stale legacy entry', () => {
    const store = stubWorkingCredentialStore();
    store.set('astramem-local:sync-device-token', 'legacy-sync-token');

    const configDir = mkTmpDir('astramem-synctoken-scoped-wins-');
    storeSyncToken('fresh-scoped-token', configDir);

    expect(readSyncToken(configDir)).toBe('fresh-scoped-token');
    expect(getSyncTokenIdentity(configDir)).toBe('scoped');
  });

  it('a production identity paired before this run is left completely untouched by a sandboxed pair() against a different configDir (2026-07-10-incident-class scenario, sync-token flavor)', () => {
    const store = stubWorkingCredentialStore();
    const prodConfigDir = mkTmpDir('astramem-synctoken-prod-');
    storeSyncToken('prod-sync-token', prodConfigDir);
    const before = new Map(store);

    const sandboxConfigDir = mkTmpDir('astramem-synctoken-sandbox-');
    storeSyncToken('sandbox-sync-token', sandboxConfigDir);

    // The prod entry is unchanged, and the sandbox write landed under its
    // own independent scoped identity rather than overwriting it.
    expect(store.get([...before.keys()][0]!)).toBe('prod-sync-token');
    expect(store.size).toBe(2);
    expect(readSyncToken(prodConfigDir)).toBe('prod-sync-token');
    expect(readSyncToken(sandboxConfigDir)).toBe('sandbox-sync-token');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// FEAT-472: ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass for the sync token
// ─────────────────────────────────────────────────────────────────────────

describe('FEAT-472: ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass for the sync token', () => {
  it('storeSyncToken never constructs an OS credential-store Entry when the bypass is set', () => {
    stubEntryThatMustNeverBeConstructed();
    process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE = '1';
    const configDir = mkTmpDir('astramem-synctoken-bypass-store-');

    const result = storeSyncToken('bypassed-token', configDir);
    expect(result).toEqual({ stored: true, source: 'key-file' });
    expect(existsSync(syncTokenFilePath(configDir))).toBe(true);
    expect(readFileSync(syncTokenFilePath(configDir), 'utf8').trim()).toBe('bypassed-token');
  });

  it('readSyncToken never constructs an OS credential-store Entry when the bypass is set', () => {
    stubEntryThatMustNeverBeConstructed();
    process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE = '1';
    const configDir = mkTmpDir('astramem-synctoken-bypass-read-');

    expect(readSyncToken(configDir)).toBeNull(); // nothing written yet; still no Entry constructed
    storeSyncToken('bypassed-token-2', configDir);
    expect(readSyncToken(configDir)).toBe('bypassed-token-2');
    expect(getSyncTokenIdentity(configDir)).toBe('key-file');
  });

  it('a before/after read of the (stubbed) "production" OS store is byte-identical across a bypassed sandboxed run — the bypass leaves the OS store untouched', () => {
    const store = stubWorkingCredentialStore();
    const prodConfigDir = mkTmpDir('astramem-synctoken-prod-bypass-');
    storeSyncToken('prod-sync-token', prodConfigDir); // pre-existing "production" entry
    const before = new Map(store);

    process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE = '1';
    const sandboxConfigDir = mkTmpDir('astramem-synctoken-sandbox-bypass-');
    storeSyncToken('sandbox-sync-token', sandboxConfigDir);
    readSyncToken(sandboxConfigDir);

    const after = new Map(store);
    expect(after).toEqual(before); // byte-identical: the sandboxed run touched nothing in the store
    delete process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE;
    expect(readSyncToken(prodConfigDir)).toBe('prod-sync-token'); // still intact
  });
});
