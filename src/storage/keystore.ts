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
 * Credential-store identity is SCOPED by configDir (FEAT-466): the service
 * name is `astramem-local:<hash-of-configDir>`, not the bare `astramem-local`
 * used pre-FEAT-466. This closes a 2026-07-10 incident where a sandboxed
 * `init` run (pointed at a throwaway configDir) overwrote the PRODUCTION
 * daemon's bearer, because the OS credential store is keyed globally by
 * service+account, not by configDir — two independent installs collided on
 * the exact same entry. Reads fall back read-only to the legacy unscoped
 * identity (service `'astramem-local'`, account `'db-key'`/`'bearer'`) so
 * pre-FEAT-466 installs keep working after upgrade with no re-init or
 * migration step; new writes always go to the scoped identity.
 *
 * The key is a 32-byte cryptographically random value, hex-encoded (64 chars),
 * used as the SQLCipher passphrase via `PRAGMA key='<hex>'` — the exact
 * PRAGMA form validated end-to-end (open/reopen/wrong-key) by the 1a spike
 * (tests/security/cipher-spike.test.ts).
 *
 * getOrCreateKey() is idempotent: a second call against the same configDir
 * (and, for the credential-store path, the same machine/user) returns the
 * same key rather than minting a new one.
 *
 * ASTRA_MEMORY_TEST_FORCE_KEYFILE=1 (FEAT-415, extended by FEAT-466 to also
 * cover the bearer): test-only bypass that skips the credential-store
 * attempt entirely and goes straight to a file fallback under configDir
 * (`db.key` / `bearer.key`). Exists because the encrypted-restart smoke
 * suite spawns the daemon as a separate child process — the in-process
 * __setEntryCtorForTests stub below has no effect across a process
 * boundary — and because a sandboxed/test `init` must have a way to NEVER
 * touch the real OS credential store even though scoping alone (above)
 * cannot fully prevent that when the test runs on the same machine/user as
 * the real daemon. Never set by real serving; no config.yaml/CLI surface
 * exposes it.
 */
import { Entry } from '@napi-rs/keyring';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SERVICE = 'astramem-local';
const ACCOUNT = 'db-key';
const BEARER_ACCOUNT = 'bearer';

export type KeySource = 'credential-store' | 'key-file';
export type KeyIdentity = 'scoped' | 'legacy';

export interface KeyResult {
  key: string;
  source: KeySource;
  /** Only meaningful when source === 'credential-store'. */
  identity?: KeyIdentity;
}

/**
 * Scoped OS credential-store service name for a given configDir — the
 * FEAT-466 fix for the machine-global identity collision. Deterministic:
 * the same configDir always hashes to the same service name, so
 * getOrCreateKey()/storeBearer() stay idempotent per install.
 */
function scopedService(configDir: string): string {
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 16);
  return `${SERVICE}:${hash}`;
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
  if (process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE === '1') {
    console.warn(
      '[astramem-local] WARNING: TEST-ONLY key-file bypass active ' +
      '(ASTRA_MEMORY_TEST_FORCE_KEYFILE=1) — skipping the OS credential store. ' +
      'Real serving environments must never set this variable.',
    );
    return getOrCreateKeyFile(configDir);
  }
  try {
    return getOrCreateCredentialStoreKey(configDir);
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

function getOrCreateCredentialStoreKey(configDir: string): KeyResult {
  // Scoped identity first (FEAT-466) — this is what every post-upgrade
  // install reads and writes.
  const entry = new EntryCtor(scopedService(configDir), ACCOUNT);

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
    return { key: existing, source: 'credential-store', identity: 'scoped' };
  }

  // Read-fallback (AC-2): a pre-FEAT-466 install wrote its key under the
  // legacy unscoped identity. Read-only — never write here, so this never
  // silently duplicates or migrates the secret; the install just keeps
  // reading the same entry it always has.
  let legacyExisting: string | null;
  try {
    const legacyEntry = new EntryCtor(SERVICE, ACCOUNT);
    legacyExisting = legacyEntry.getPassword();
  } catch {
    legacyExisting = null;
  }
  if (legacyExisting) {
    return { key: legacyExisting, source: 'credential-store', identity: 'legacy' };
  }

  // Neither identity has a key yet — mint one under the scoped identity.
  // New installs (and upgraded ones that never had a legacy key) never
  // write to the legacy identity again.
  const key = generateKeyHex();
  entry.setPassword(key);
  return { key, source: 'credential-store', identity: 'scoped' };
}

// ─── Provider (b): key-file fallback ──────────────────────────────────────

function getOrCreateKeyFile(configDir: string): KeyResult {
  mkdirSync(configDir, { recursive: true });
  const keyPath = join(configDir, 'db.key');

  if (existsSync(keyPath)) {
    const key = readFileSync(keyPath, 'utf8').trim();
    restrictKeyFileAcl(keyPath); // heal ACLs on files created by older builds
    return { key, source: 'key-file' };
  }

  const key = generateKeyHex();
  writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    // Belt-and-braces: writeFileSync's mode option is honored on creation on
    // POSIX; chmodSync is a no-op on Windows (no POSIX bits) — Windows gets a
    // real ACL below via icacls instead.
    chmodSync(keyPath, 0o600);
  } catch {
    /* best-effort on platforms without POSIX permission bits */
  }
  restrictKeyFileAcl(keyPath);

  return { key, source: 'key-file' };
}

/**
 * Windows: apply a real ACL to the key file — strip inheritance, grant only
 * the current user. Without this, chmod is a no-op and the DB encryption key
 * sits world-readable next to the database it protects (SEC OQ-1).
 * Best-effort but LOUD on failure: a key file without an ACL is a real
 * security downgrade the user must know about.
 */
function restrictKeyFileAcl(keyPath: string): void {
  if (process.platform !== 'win32') return;
  const user = process.env['USERNAME'];
  if (!user) return;
  try {
    execFileSync(
      'icacls',
      [keyPath, '/inheritance:r', '/grant:r', `${user}:F`],
      { stdio: 'pipe', timeout: 10_000 },
    );
  } catch (err) {
    console.warn(
      `[astramem-local] WARNING: could not restrict ACL on key file ${keyPath} ` +
      `(icacls failed: ${errMessage(err)}). The DB encryption key is readable by other ` +
      `local accounts — fix manually: icacls "${keyPath}" /inheritance:r /grant:r ${user}:F`,
    );
  }
}

export function keyFilePath(configDir: string): string {
  return join(configDir, 'db.key');
}

// ─── Bearer token (SEC-10, Wave 1 task 1d; scoped per FEAT-466) ───────────
//
// Same scoped-service scheme, a distinct account ('bearer'), and the same
// EntryCtor test seam as the db-key above — one stub controls both. Unlike
// the db-key, the bearer has no "always needs a value" contract: the caller
// (token.ts/init.ts) generates the token, then asks the store to hold it;
// the resolution side (bearer-keystore.ts) reads it back. secrets.env
// remains the fallback persistence layer, exactly mirroring getOrCreateKey's
// credential-store -> key-file degradation. Reads fall back read-only to
// the legacy unscoped identity (AC-2); writes always target the scoped
// identity for `configDir` (AC-1) — never the legacy one.

export interface BearerStoreResult {
  stored: boolean;
  source: 'credential-store' | 'secrets-env-fallback' | 'key-file';
  /** Only meaningful when source === 'credential-store'. */
  identity?: KeyIdentity;
}

export function bearerFilePath(configDir: string): string {
  return join(configDir, 'bearer.key');
}

/** ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass, bearer flavor — see file header. */
function storeBearerFile(token: string, configDir: string): BearerStoreResult {
  mkdirSync(configDir, { recursive: true });
  const filePath = bearerFilePath(configDir);
  writeFileSync(filePath, token, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* best-effort on platforms without POSIX permission bits */
  }
  restrictKeyFileAcl(filePath);
  return { stored: true, source: 'key-file' };
}

/** ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass, bearer flavor — see file header. */
function readBearerFile(configDir: string): string | null {
  const filePath = bearerFilePath(configDir);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf8').trim();
}

/**
 * Store `token` in the OS credential store, under the identity scoped to
 * `configDir` (FEAT-466). On failure (no credential store / no
 * secret-service session), WARNs and returns a fallback marker so the
 * caller persists the bearer into secrets.env instead (SEC-10).
 *
 * ASTRA_MEMORY_TEST_FORCE_KEYFILE=1 skips the OS credential store entirely
 * (AC-3) — a sandboxed/test caller that sets this never touches the real
 * store, writing to `<configDir>/bearer.key` instead.
 */
export function storeBearer(token: string, configDir: string): BearerStoreResult {
  if (process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE === '1') {
    console.warn(
      '[astramem-local] WARNING: TEST-ONLY key-file bypass active ' +
      '(ASTRA_MEMORY_TEST_FORCE_KEYFILE=1) — skipping the OS credential store for the bearer. ' +
      'Real serving environments must never set this variable.',
    );
    return storeBearerFile(token, configDir);
  }
  try {
    const entry = new EntryCtor(scopedService(configDir), BEARER_ACCOUNT);
    entry.setPassword(token);
    return { stored: true, source: 'credential-store', identity: 'scoped' };
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
 * Read the bearer token from the OS credential store, if present: the
 * identity scoped to `configDir` first, then a read-only fallback to the
 * legacy unscoped identity (AC-2). Returns null on any error (store
 * unavailable, or no entry under either identity) — same "throw and
 * getPassword()->null are both just 'no key yet'" tolerance as
 * getOrCreateCredentialStoreKey above. Callers fall back to secrets.env.
 *
 * Honors the same ASTRA_MEMORY_TEST_FORCE_KEYFILE=1 bypass as storeBearer —
 * reads from `<configDir>/bearer.key` instead of the OS store (AC-4: this is
 * what makes the bypass's "OS store untouched" guarantee provable, since a
 * before/after OS-store read never even attempts the scoped/legacy lookup).
 */
export function readBearer(configDir: string): string | null {
  return lookupBearer(configDir)?.token ?? null;
}

/**
 * Doctor-facing variant of readBearer(): reports which identity (scoped vs
 * legacy vs the test-only key-file bypass) the bearer was actually read
 * from, or 'none' when no bearer is stored under any of them (AC-5).
 */
export function getBearerIdentity(configDir: string): KeyIdentity | 'key-file' | 'none' {
  const result = lookupBearer(configDir);
  if (!result) return 'none';
  return result.identity ?? 'key-file'; // source lacks identity only for the key-file bypass
}

function lookupBearer(configDir: string): { token: string; source: 'credential-store' | 'key-file'; identity?: KeyIdentity } | null {
  if (process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE === '1') {
    const token = readBearerFile(configDir);
    return token ? { token, source: 'key-file' } : null;
  }

  try {
    const scopedEntry = new EntryCtor(scopedService(configDir), BEARER_ACCOUNT);
    const scoped = scopedEntry.getPassword();
    if (scoped) return { token: scoped, source: 'credential-store', identity: 'scoped' };
  } catch {
    // fall through to the legacy read below
  }

  try {
    const legacyEntry = new EntryCtor(SERVICE, BEARER_ACCOUNT);
    const legacy = legacyEntry.getPassword();
    if (legacy) return { token: legacy, source: 'credential-store', identity: 'legacy' };
  } catch {
    // store unavailable, or no legacy entry — both mean "nothing to read"
  }

  return null;
}

// ─── Cloud sync device token ───────────────────────────────────────────────
//
// NOTE (FEAT-466 scope): unlike the db-key and bearer above, the sync device
// token identity is intentionally left unscoped for now — FEAT-466's ACs
// cover storeBearer()/getOrCreateKey() only. It carries the same theoretical
// collision risk; scoping it is a natural follow-up if a similar incident
// ever touches sync auth.

const SYNC_TOKEN_ACCOUNT = 'sync-device-token';

/** Store the cloud sync device token (ADR-003 auth) in the credential store. */
export function storeSyncToken(token: string): BearerStoreResult {
  try {
    const entry = new EntryCtor(SERVICE, SYNC_TOKEN_ACCOUNT);
    entry.setPassword(token);
    return { stored: true, source: 'credential-store' };
  } catch (err) {
    console.warn(
      `[astramem-local] WARNING: OS credential store unavailable (${errMessage(err)}); ` +
      `sync device token was NOT stored. Set ASTRA_SYNC_TOKEN in the environment instead.`,
    );
    return { stored: false, source: 'secrets-env-fallback' };
  }
}

/** Read the cloud sync device token; null when absent/unavailable. */
export function readSyncToken(): string | null {
  try {
    const entry = new EntryCtor(SERVICE, SYNC_TOKEN_ACCOUNT);
    return entry.getPassword();
  } catch {
    return null;
  }
}
