/**
 * keystore.ts — encryption-at-rest key management (SEC-1/2, Wave 1 task 1b).
 *
 * Provider chain (per spec §4.1 / OQ-1):
 *   (a) OS credential store — Windows Credential Manager / macOS Keychain /
 *       Linux libsecret, via `@napi-rs/keyring` (prebuilt N-API binding,
 *       verified to install cleanly with prebuilds for win32-x64-msvc,
 *       darwin-x64/arm64, and linux-x64-gnu — the repo's 3 CI targets).
 *   (b) key-file fallback (`<configDir>/db.key`, mode 0600) with a WARN log —
 *       used when the credential store throws (e.g. headless Linux with no
 *       secret-service/dbus session). Spec OQ-1 explicitly allows this
 *       fallback for v0.4.
 *
 * Key lookup identity is fixed: service `'astramem-local'`, account `'db-key'`.
 * The key is a 32-byte cryptographically random value, hex-encoded (64 chars),
 * used as the SQLCipher passphrase via `PRAGMA key='<hex>'` — the exact
 * PRAGMA form validated end-to-end (open/reopen/wrong-key) by the 1a spike
 * (tests/security/cipher-spike.test.ts).
 *
 * getOrCreateKey() is idempotent: a second call against the same configDir
 * (and, for the credential-store path, the same machine/user) returns the
 * same key rather than minting a new one.
 */
import { Entry } from '@napi-rs/keyring';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SERVICE = 'astramem-local';
const ACCOUNT = 'db-key';
const BEARER_ACCOUNT = 'bearer';

export type KeySource = 'credential-store' | 'key-file';

export interface KeyResult {
  key: string;
  source: KeySource;
}

// Test-only indirection so tests can simulate a credential-store outage
// (e.g. headless-Linux fallback) without needing an actual broken OS
// keychain, and so keystore tests don't have to mutate the developer's
// real OS credential store as a side effect of `npm test`.
let EntryCtor: typeof Entry = Entry;

/** Test-only hook: override (or restore) the credential-store Entry constructor. */
export function __setEntryCtorForTests(ctor: typeof Entry | undefined): void {
  EntryCtor = ctor ?? Entry;
}

/**
 * Returns the encryption key for this machine/user, creating one on first
 * use. Tries the OS credential store first; falls back to a 0600 key file
 * under `configDir` (with a WARN log) when the credential store throws.
 *
 * NOTE: deviates slightly from the originally-sketched `(configDir) => string`
 * signature — returns `{ key, source }` instead of a bare string so callers
 * (doctor, /health) can report key location (SEC-8/AC-5) without a second,
 * duplicate resolution pass. `.key` is what openDb()/migrate-encrypt need.
 */
export function getOrCreateKey(configDir: string): KeyResult {
  try {
    return getOrCreateCredentialStoreKey();
  } catch (err) {
    console.warn(
      `[astramem-local] WARNING: OS credential store unavailable (${errMessage(err)}); ` +
      `falling back to a key file with 0600 permissions. This is a weaker guarantee than ` +
      `an OS credential store — see docs/specs/2026-07-02-encryption-and-secret-redaction.md OQ-1.`,
    );
    return getOrCreateKeyFile(configDir);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function generateKeyHex(): string {
  return randomBytes(32).toString('hex');
}

// ─── Provider (a): OS credential store ────────────────────────────────────

function getOrCreateCredentialStoreKey(): KeyResult {
  const entry = new EntryCtor(SERVICE, ACCOUNT);

  // getPassword() returns null when absent on some platforms but throws a
  // NoEntry error on others (per @napi-rs/keyring docs) — treat both as
  // "no key yet", not as "credential store broken". Only the constructor
  // and setPassword() throwing should trigger the key-file fallback.
  let existing: string | null;
  try {
    existing = entry.getPassword();
  } catch {
    existing = null;
  }
  if (existing) {
    return { key: existing, source: 'credential-store' };
  }

  const key = generateKeyHex();
  entry.setPassword(key);
  return { key, source: 'credential-store' };
}

// ─── Provider (b): key-file fallback ──────────────────────────────────────

function getOrCreateKeyFile(configDir: string): KeyResult {
  mkdirSync(configDir, { recursive: true });
  const keyPath = join(configDir, 'db.key');

  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath, 'utf8').trim();
    return { key, source: 'key-file' };
  }

  const key = generateKeyHex();
  writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    // Belt-and-braces: writeFileSync's mode option is honored on creation on
    // POSIX; chmodSync is a no-op-ish best-effort on Windows (no real ACL
    // restriction there) but must never throw and block key issuance.
    chmodSync(keyPath, 0o600);
  } catch {
    /* best-effort on platforms without POSIX permission bits */
  }

  return { key, source: 'key-file' };
}

export function keyFilePath(configDir: string): string {
  return join(configDir, 'db.key');
}

// ─── Bearer token (SEC-10, Wave 1 task 1d) ────────────────────────────────
//
// Same service ('astramem-local'), a distinct account ('bearer'), and the
// same EntryCtor test seam as the db-key above — one stub controls both.
// Unlike the db-key, the bearer has no "always needs a value" contract: the
// caller (token.ts/init.ts) generates the token, then asks the store to hold
// it; the resolution side (bearer-keystore.ts) reads it back. secrets.env
// remains the fallback persistence layer, exactly mirroring getOrCreateKey's
// credential-store -> key-file degradation.

export interface BearerStoreResult {
  stored: boolean;
  source: 'credential-store' | 'secrets-env-fallback';
}

/**
 * Store `token` in the OS credential store. On failure (no credential store
 * / no secret-service session), WARNs and returns a fallback marker so the
 * caller persists the bearer into secrets.env instead (SEC-10).
 */
export function storeBearer(token: string): BearerStoreResult {
  try {
    const entry = new EntryCtor(SERVICE, BEARER_ACCOUNT);
    entry.setPassword(token);
    return { stored: true, source: 'credential-store' };
  } catch (err) {
    console.warn(
      `[astramem-local] WARNING: OS credential store unavailable (${errMessage(err)}); ` +
      `falling back to writing the bearer token into secrets.env. This is a weaker guarantee ` +
      `than an OS credential store — see docs/specs/2026-07-02-encryption-and-secret-redaction.md SEC-10.`,
    );
    return { stored: false, source: 'secrets-env-fallback' };
  }
}

/**
 * Read the bearer token from the OS credential store, if present.
 * Returns null on any error (store unavailable, or no entry yet) — same
 * "throw and getPassword()->null are both just 'no key yet'" tolerance as
 * getOrCreateCredentialStoreKey above. Callers fall back to secrets.env.
 */
export function readBearer(): string | null {
  try {
    const entry = new EntryCtor(SERVICE, BEARER_ACCOUNT);
    return entry.getPassword();
  } catch {
    return null;
  }
}
