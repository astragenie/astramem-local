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
 * Credential-store identity is SCOPED by configDir (FEAT-466; extended to the
 * sync device token by FEAT-472): the service name is
 * `astramem-local:<hash-of-configDir>`, not the bare `astramem-local` used
 * pre-FEAT-466. This closes a 2026-07-10 incident where a sandboxed `init`
 * run (pointed at a throwaway configDir) overwrote the PRODUCTION daemon's
 * bearer, because the OS credential store is keyed globally by
 * service+account, not by configDir — two independent installs collided on
 * the exact same entry. Reads fall back read-only to the legacy unscoped
 * identity (service `'astramem-local'`, account `'db-key'`/`'bearer'`/
 * `'sync-device-token'`) so pre-FEAT-466/pre-FEAT-472 installs keep working
 * after upgrade with no re-init/re-pair or migration step; new writes always
 * go to the scoped identity.
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
import type { Entry } from '@napi-rs/keyring';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BoundedEntry, type EntryLike } from './keystore-bounded.js';

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
 * Normalizes configDir before hashing (review defense-in-depth): resolves
 * to an absolute path (also strips a trailing separator) and, on Windows,
 * case-folds — so `C:\Users\x`, `c:\users\x`, `C:/Users/x`, and a
 * trailing-backslash variant all hash to the SAME scoped identity instead
 * of four different ones. Every real call site in this repo already
 * derives configDir from the single `defaultConfigDir()` function, so this
 * has no effect on current behavior; it only guards a future call site
 * that constructs configDir some other way.
 *
 * `platform` is injectable (FEAT-470 quickwin, FEAT-466 re-review LOW) so
 * the non-win32 (case-preserving) branch has an executable test on every
 * CI platform, not just whichever OS happens to run the suite — it defaults
 * to `process.platform` for every real call site, so this has no effect on
 * actual behavior.
 */
export function normalizeConfigDir(configDir: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = resolve(configDir);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Scoped OS credential-store service name for a given configDir — the
 * FEAT-466 fix for the machine-global identity collision. Deterministic:
 * the same configDir always hashes to the same service name, so
 * getOrCreateKey()/storeBearer() stay idempotent per install.
 */
function scopedService(configDir: string): string {
  const hash = createHash('sha256').update(normalizeConfigDir(configDir)).digest('hex').slice(0, 16);
  return `${SERVICE}:${hash}`;
}

// Test-only indirection so tests can simulate a credential-store outage
// (e.g. headless-Linux fallback) without needing an actual broken OS
// keychain, and so keystore tests don't have to mutate the developer's
// real OS credential store as a side effect of `npm test`.
//
// DEFAULT is `BoundedEntry` (keystore-bounded.ts), NOT the raw `@napi-rs/keyring`
// `Entry` (keystore-read-timeout, 2026-08-02 incident): `Entry.getPassword()`/
// `.setPassword()` are synchronous N-API calls into the OS credential store
// with no timeout anywhere in the chain — see keystore-bounded.ts's file
// header for the incident this closes. `BoundedEntry` runs the real call in
// a killable child process with a hard wall-clock bound, then throws (same
// as a real `Entry` failure) on timeout — every credential-store touchpoint
// below (scoped + legacy identities, db-key, bearer, sync-device-token) and
// everything built on top (doctor checks, CLI commands, serve.ts's boot
// path) already funnels through `EntryCtor`, so this one swap closes the
// hang hazard everywhere at once with no other code path changes.
// `undefined` restores this bounded default, not the raw unbounded `Entry`.
//
// Typed as a narrow structural constructor (service, account) => EntryLike
// rather than `typeof Entry` — `Entry`'s full class type also requires the
// static `withTarget` method, which `BoundedEntry` deliberately does not
// implement (nothing in this repo calls it). The EXPORTED test hook below
// keeps accepting `typeof Entry | undefined` unchanged (every existing
// test-fake call site already passes `as unknown as typeof Entry`), so this
// narrowing is invisible to callers.
type EntryCtorType = new (service: string, account: string) => EntryLike;
let EntryCtor: EntryCtorType = BoundedEntry;

/** Test-only hook: override (or restore) the credential-store Entry constructor. */
export function __setEntryCtorForTests(ctor: typeof Entry | undefined): void {
  EntryCtor = (ctor as unknown as EntryCtorType | undefined) ?? BoundedEntry;
}

// Process-lifetime cache, keyed by normalized configDir (keystore-read-timeout,
// 2026-08-02 incident follow-up). getOrCreateKey() was ALREADY documented as
// "idempotent" — same key every call — but had no actual memoization: every
// call re-attempted the credential store from scratch, which cost nothing
// when that attempt was a same-thread synchronous throw. Once the bounded
// child-process boundary (keystore-bounded.ts) went in, a repeat call became
// genuinely expensive: a live count showed a SINGLE daemon boot calling
// getOrCreateKey() a dozen-plus times (`openBootDb` once, then every 'cheap'
// doctor check that touches `openProductionDbReadonly` — ~30 call sites,
// several on the frequent/boot-immediate tier — each independently re-deriving
// the same key). Against a genuinely WEDGED (not just erroring) credential
// store, each of those calls could cost the full ~3x CREDENTIAL_STORE_TIMEOUT_MS
// worst case — multiplied across a dozen callers, that is minutes of
// cumulative event-loop-blocking delay, which would have defeated the whole
// point of bounding any SINGLE call. Caching the resolved result turns every
// call after the first into a free in-memory lookup, regardless of caller
// count. Scoped per-process (a fresh `astramem-local` CLI invocation or test
// process gets its own empty cache) — the underlying credential SOURCE
// (credential-store vs key-file) is an install-time property that does not
// legitimately change mid-run, so caching it for a long-lived daemon's
// lifetime is not a behavior change, only a performance one.
const keyCache = new Map<string, KeyResult>();

/** Test-only hook: clears the process-lifetime key cache. Real callers never
 *  need this — a fresh process starts with an empty cache — but a test
 *  process that calls getOrCreateKey() against the SAME configDir twice,
 *  expecting the SECOND call to re-derive against mutated stub state (rather
 *  than reuse the first call's cached result), needs to clear it between
 *  arrangements. */
export function __resetKeyCacheForTests(): void {
  keyCache.clear();
}

/**
 * Returns the encryption key for this machine/user, creating one on first
 * use. Tries the OS credential store first; falls back to a 0600 key file
 * under `configDir` (with a WARN log) when the credential store throws.
 * Memoized per (normalized) configDir for the lifetime of this process — see
 * `keyCache`'s doc comment above for why repeat calls must be free, not just
 * bounded.
 *
 * NOTE: deviates slightly from the originally-sketched `(configDir) => string`
 * signature — returns `{ key, source }` instead of a bare string so callers
 * (doctor, /health) can report key location (SEC-8/AC-5) without a second,
 * duplicate resolution pass. `.key` is what openDb()/migrate-encrypt need.
 */
export function getOrCreateKey(configDir: string): KeyResult {
  // ASTRA_MEMORY_TEST_FORCE_KEYFILE bypasses caching entirely — it is
  // already a fast, deterministic fs read (no credential-store round trip to
  // amortize), and sandboxed tests using it may legitimately expect a fresh
  // disk read on every call.
  if (process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE === '1') {
    console.warn(
      '[astramem-local] WARNING: TEST-ONLY key-file bypass active ' +
      '(ASTRA_MEMORY_TEST_FORCE_KEYFILE=1) — skipping the OS credential store. ' +
      'Real serving environments must never set this variable.',
    );
    return getOrCreateKeyFile(configDir);
  }

  const cacheKey = normalizeConfigDir(configDir);
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  let result: KeyResult;
  try {
    result = getOrCreateCredentialStoreKey(configDir);
  } catch (err) {
    console.warn(
      `[astramem-local] WARNING: OS credential store unavailable (${errMessage(err)}); ` +
      `falling back to a key file with 0600 permissions. This is a weaker guarantee than ` +
      `an OS credential store — see docs/specs/2026-07-02-encryption-and-secret-redaction.md OQ-1.`,
    );
    result = getOrCreateKeyFile(configDir);
  }
  keyCache.set(cacheKey, result);
  return result;
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
// the resolution side (bearer-keystore.ts) reads it back. Reads fall back
// read-only to the legacy unscoped identity (AC-2); writes always target
// the scoped identity for `configDir` (AC-1) — never the legacy one, EXCEPT
// the deliberate `writeThroughLegacy` exception on rotate (see
// StoreBearerOpts below — a review fix-round addition, not part of the
// original FEAT-466 AC-2 read-only guarantee).
//
// secrets.env is UNCONDITIONALLY AUTHORITATIVE for the bearer (review
// fix-round decision, superseding the original "fallback of last resort"
// design): callers (init.ts, token.ts) now always write MEMORY_BEARER=
// regardless of whether the OS-store write also succeeded. Rationale: a
// rollback to a pre-FEAT-466 binary reads the OS store BEFORE secrets.env
// (see bearer-keystore.ts's documented resolution order), so if secrets.env
// were left empty whenever the OS store succeeded (the pre-fix-round
// behavior), a rollback could resolve a stale or hard-coded-default bearer
// with no way to recover it from secrets.env. Keeping secrets.env always
// current closes that gap for fresh installs (no legacy OS entry to shadow
// it); the `writeThroughLegacy` rotate exception above closes it for
// upgraded installs that do have a pre-existing legacy OS entry.

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

export interface StoreBearerOpts {
  /**
   * Review fix-round (rollback hazard): also best-effort write `token` into
   * the LEGACY unscoped identity, not just the scoped one. This is a
   * deliberate, narrowly-scoped exception to the "legacy is read-only"
   * rule (AC-2) — rotation is exactly the moment a stale legacy entry
   * becomes dangerous: a `reinstall --rollback` to a pre-FEAT-466 binary
   * reads the legacy identity directly (it has no scoping concept at all),
   * so if rotation only refreshed the scoped identity, the rolled-back
   * binary would resolve a stale bearer instead of the one just issued.
   * Only `token.ts`'s `rotateToken()` sets this — `init.ts`'s first-time
   * provisioning deliberately does NOT, since writing the legacy identity
   * from a sandboxed/test `init` is the exact mechanism that caused the
   * original 2026-07-10 incident this FEAT closes. Never touched when the
   * ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass is active (that path never
   * touches the OS store at all, scoped or legacy).
   */
  writeThroughLegacy?: boolean;
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
export function storeBearer(token: string, configDir: string, opts: StoreBearerOpts = {}): BearerStoreResult {
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
    if (opts.writeThroughLegacy) {
      try {
        new EntryCtor(SERVICE, BEARER_ACCOUNT).setPassword(token);
      } catch (err) {
        console.warn(
          `[astramem-local] WARNING: could not write-through the rotated bearer into the legacy ` +
          `credential-store identity (${errMessage(err)}); a rollback to a pre-FEAT-466 binary may ` +
          `read a stale bearer from that identity until the next successful rotate.`,
        );
      }
    }
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

// ─── Cloud sync device token (FEAT-472; scoped per configDir) ─────────────
//
// FEAT-466 deliberately left this identity unscoped ("a natural follow-up if
// a similar incident ever touches sync auth" — see the done FEAT-466 note
// this comment used to carry). FEAT-472 does that follow-up: same collision
// class as the bearer/db-key (a sandboxed `pair` pointed at a throwaway
// configDir would otherwise clobber the production device token in the OS
// credential store, which is keyed globally by service+account, not by
// configDir) — so this mirrors storeBearer/readBearer above exactly: scoped
// identity first, read-only legacy fallback (pre-FEAT-472 installs keep
// working with no re-pair), and the same ASTRA_MEMORY_TEST_FORCE_KEYFILE
// bypass.
//
// No `writeThroughLegacy` option (unlike storeBearer's StoreBearerOpts):
// DEC-011's rollback trap is specifically a ROTATE hazard — a value gets
// updated in place while an older binary still consults the legacy identity
// first. The sync device token has no rotate flow (grep confirms `token
// rotate` in cli/token.ts is bearer-only); `pair` is the only write path,
// and it is a fresh/full re-provisioning action analogous to `init` — which
// FEAT-466 deliberately does NOT write-through to legacy either, because a
// sandboxed init writing the legacy identity is exactly the incident
// mechanism this whole scoping scheme exists to prevent. If a rotate-style
// operation is ever added for the sync token, revisit this the same way
// DEC-011 did for the bearer.
//
// Authority note (sync.json vs this entry — see config/sync-settings.ts):
// sync.json is authoritative for CONNECTION metadata (enabled/url/
// workspaceId/tenantId); this keystore entry (or ASTRA_SYNC_TOKEN) is
// authoritative for the CREDENTIAL itself. Neither ever holds the other's
// data. A rollback to a pre-FEAT-472 binary after a fresh (post-FEAT-472)
// `pair` finds no legacy-identity entry (pair never wrote one) and no
// ASTRA_SYNC_TOKEN — the shipper/pull just log their existing "device-token
// incomplete" warning and do nothing, same as any other unpaired install;
// re-running `pair` recovers it. Low severity since sync is opt-in and this
// mirrors the accepted-tradeoff shape of FEAT-466 AC-2, not a new hazard.

const SYNC_TOKEN_ACCOUNT = 'sync-device-token';

export function syncTokenFilePath(configDir: string): string {
  return join(configDir, 'sync-token.key');
}

/** ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass, sync-token flavor — see file header. */
function storeSyncTokenFile(token: string, configDir: string): BearerStoreResult {
  mkdirSync(configDir, { recursive: true });
  const filePath = syncTokenFilePath(configDir);
  writeFileSync(filePath, token, { mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* best-effort on platforms without POSIX permission bits */
  }
  restrictKeyFileAcl(filePath);
  return { stored: true, source: 'key-file' };
}

/** ASTRA_MEMORY_TEST_FORCE_KEYFILE bypass, sync-token flavor — see file header. */
function readSyncTokenFile(configDir: string): string | null {
  const filePath = syncTokenFilePath(configDir);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf8').trim();
}

/**
 * Store the cloud sync device token (ADR-003 auth) in the OS credential
 * store, under the identity scoped to `configDir` (FEAT-472, mirroring
 * storeBearer). ASTRA_MEMORY_TEST_FORCE_KEYFILE=1 skips the OS credential
 * store entirely, writing to `<configDir>/sync-token.key` instead.
 */
export function storeSyncToken(token: string, configDir: string): BearerStoreResult {
  if (process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE === '1') {
    console.warn(
      '[astramem-local] WARNING: TEST-ONLY key-file bypass active ' +
      '(ASTRA_MEMORY_TEST_FORCE_KEYFILE=1) — skipping the OS credential store for the sync device token. ' +
      'Real serving environments must never set this variable.',
    );
    return storeSyncTokenFile(token, configDir);
  }
  try {
    const entry = new EntryCtor(scopedService(configDir), SYNC_TOKEN_ACCOUNT);
    entry.setPassword(token);
    return { stored: true, source: 'credential-store', identity: 'scoped' };
  } catch (err) {
    console.warn(
      `[astramem-local] WARNING: OS credential store unavailable (${errMessage(err)}); ` +
      `sync device token was NOT stored. Set ASTRA_SYNC_TOKEN in the environment instead.`,
    );
    return { stored: false, source: 'secrets-env-fallback' };
  }
}

/**
 * Read the cloud sync device token: the identity scoped to `configDir`
 * first, then a read-only fallback to the legacy unscoped identity (pre-
 * FEAT-472 installs keep working with no re-pair). Null when absent under
 * either identity or when the store is unavailable.
 */
export function readSyncToken(configDir: string): string | null {
  return lookupSyncToken(configDir)?.token ?? null;
}

/**
 * Doctor-facing variant of readSyncToken(): reports which identity (scoped
 * vs legacy vs the test-only key-file bypass) the sync device token was
 * actually read from, or 'none' when nothing is stored under any of them.
 */
export function getSyncTokenIdentity(configDir: string): KeyIdentity | 'key-file' | 'none' {
  const result = lookupSyncToken(configDir);
  if (!result) return 'none';
  return result.identity ?? 'key-file'; // source lacks identity only for the key-file bypass
}

function lookupSyncToken(configDir: string): { token: string; source: 'credential-store' | 'key-file'; identity?: KeyIdentity } | null {
  if (process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE === '1') {
    const token = readSyncTokenFile(configDir);
    return token ? { token, source: 'key-file' } : null;
  }

  try {
    const scopedEntry = new EntryCtor(scopedService(configDir), SYNC_TOKEN_ACCOUNT);
    const scoped = scopedEntry.getPassword();
    if (scoped) return { token: scoped, source: 'credential-store', identity: 'scoped' };
  } catch {
    // fall through to the legacy read below
  }

  try {
    const legacyEntry = new EntryCtor(SERVICE, SYNC_TOKEN_ACCOUNT);
    const legacy = legacyEntry.getPassword();
    if (legacy) return { token: legacy, source: 'credential-store', identity: 'legacy' };
  } catch {
    // store unavailable, or no legacy entry — both mean "nothing to read"
  }

  return null;
}
