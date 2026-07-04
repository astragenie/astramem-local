# FEAT-415 pre-mortem — encrypted-DB restart smoke seam

technical_risk: 0.60 (AC5 mandates this before touching keystore code).

## What already exists (investigated before writing any code)

`src/storage/keystore.ts` already implements the full production provider
chain: OS credential store (`@napi-rs/keyring`, service `astramem-local`,
account `db-key`) first, falling back to a `<configDir>/db.key` (0600 /
Windows ACL-restricted) key file with a WARN log when the credential store
throws. `serve.ts` calls `getOrCreateKey(defaultConfigDir())` whenever
`cfg.security.encryption.enabled` is true and `dataDir !== ':memory:'`.

There is ALSO an existing test-only seam: `__setEntryCtorForTests(ctor)` in
keystore.ts, a module-level override of the `Entry` constructor used by
`tests/security/encryption.test.ts` to simulate a credential-store outage
in-process, without touching the real OS credential store.

## Why the existing seam is NOT sufficient for this smoke suite

`__setEntryCtorForTests` is an in-process monkeypatch (it reassigns a
module-level `let EntryCtor` binding). The smoke suite spawns the daemon as
a **separate child process** (`node dist/cli/index.js serve`, see
`tests/smoke/helpers/daemon.ts:spawnDaemon`) — a child process gets a fresh
module graph, so the parent test process calling
`__setEntryCtorForTests(...)` has zero effect on the spawned daemon.

Confirmed empirically: `Entry(service, account)` from `@napi-rs/keyring` is
keyed only by the service/account string pair — it is NOT namespaced by
config dir, APPDATA, or any of the env vars the existing sandbox
(`makeIsolatedDaemonEnv`) already redirects. So spawning a daemon with
`security.encryption.enabled: true` and no further seam would read/write a
REAL `astramem-local` / `db-key` entry in the real Windows Credential
Manager on whatever machine runs the test — exactly the failure class F1
already flagged and the PM risk radar calls out explicitly for this FEAT.

## Chosen seam (smallest blast radius)

Add one new env-gated bypass inside `getOrCreateKey()`:

```ts
if (process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE === '1') {
  return getOrCreateKeyFile(configDir);
}
```

placed as the first line of the function, before the credential-store
`try` block — so when unset (every real production invocation), behavior
is byte-identical to today: credential store first, key-file fallback only
on a genuine throw. Naming follows the existing `ASTRA_MEMORY_MOCK_PROVIDERS`
convention (test/CI-only, never set by real serving, never written to
config.yaml, no CLI flag exposes it).

This satisfies:
- AC2 (test key path never touches real OS credential store) — the
  credential-store constructor is never even called when the flag is set,
  not just made to fail gracefully.
- AC4 (production paths unchanged) — the bypass is a single `===` check
  against an env var real users/services never set; default behavior
  (flag unset) takes the exact pre-existing code path. Verified with a new
  unit test asserting the credential-store constructor IS still invoked
  when the flag is unset.

### Alternatives considered and rejected
- **Config-file key-file-forced mode** (`security.encryption.keyFile` in
  config.yaml): larger surface — would need schema, writer, loader, and
  doctor changes for a knob only tests use. Rejected as bigger blast radius
  than an env check for a test-only concern.
- **Reusing `__setEntryCtorForTests` via an IPC/preload hook** into the
  child process (e.g. `--require` a stub module): more moving parts,
  fragile against the compiled `dist/cli/index.js` entry point, and less
  auditable than a single env-var branch. Rejected.

## Secondary finding surfaced during investigation (AC3)

Empirically reproduced (scratch script against the real
`better-sqlite3-multiple-ciphers` driver): opening an encrypted DB with the
WRONG key does fail loud — `db.pragma('journal_mode = WAL')` inside
`openDb()` throws `SqliteError: file is not a database (SQLITE_NOTADB)` —
but the message is generic and NOT actionable: it is byte-identical to the
unrelated "opened an encrypted DB with the cipher-less global build"
failure mode already documented in this repo's CLAUDE.md. A user hitting
this would reasonably conclude the database file is corrupt, not that they
have a stale/wrong encryption key.

serve.ts does not currently catch/rewrap this error — it propagates
through `serve()` to `main().catch(e => { console.error(e); process.exit(1); })`,
which dumps the raw stack and exits 1. That is "loud" (AC3's first bar) but
not "actionable" (AC3's second bar). Scope-checked against
"fix ONLY if small": wrapping the single `openDb(dbPath, { key })` call in
serve.ts's encryption-enabled branch in a try/catch that rewraps
`SQLITE_NOTADB` into a message naming the likely cause (wrong/stale
encryption key, points at the key source — credential store vs key file —
and the dbPath) is a ~15-line, single-file, non-refactoring change. Doing
it as part of this slice rather than filing a separate FEAT, per the
builder's discretion granted in the dispatch.
