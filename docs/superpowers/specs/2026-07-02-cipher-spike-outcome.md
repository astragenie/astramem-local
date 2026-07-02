# Spike Outcome — `better-sqlite3-multiple-ciphers` × `sqlite-vec` (Wave 1 task 1a)

**Date:** 2026-07-02 · **Status:** **GO — CI PASS on ubuntu/macos/windows** (run 28585867468; required `trustedDependencies` for the driver's install script under Bun). 1b proceeds with the driver swap.
**Decides:** ADR-002 `docs/adr/ADR-002-local-storage-engine.md`, risk register #1 (cipher driver ×
sqlite-vec extension-load compatibility)

## What was tested

`tests/security/cipher-spike.test.ts` drives `better-sqlite3-multiple-ciphers` directly (not
`src/storage/db.ts`) against a temp-file DB, mirroring the sqlite-vec load mechanism used in
`src/storage/db.ts` (`sqliteVec.load(db)`):

1. Open a temp-file DB (`node:os` tmpdir + `mkdtempSync` unique dir), apply `PRAGMA key = '...'`
   immediately after open.
2. Load `sqlite-vec` the same way `openDb()` does.
3. `CREATE VIRTUAL TABLE v USING vec0(embedding FLOAT[1024])`, insert 3 distinct vectors, run a
   KNN `MATCH` query, assert distance-ascending ordering (nearest vector first).
4. Close, reopen **without** the key — reading throws (`SqliteError`), proving the file is
   actually encrypted and not just wrapped.
5. Reopen **with** the key — data and vector index intact, KNN query still orders correctly.
6. Byte-check the raw file header via `node:fs` — asserts it is **not** the plaintext
   `"SQLite format 3"` magic string SQLite always writes unencrypted.
7. A second test confirms a *wrong* key also fails to read (not just an absent key), ruling out
   a "key is decorative" false positive.

## Local win32 result

- Native module: `better-sqlite3-multiple-ciphers@12.11.1` installed via `npm install --save-dev`.
  Prebuilt binary resolved without a local compile step —
  `node_modules/better-sqlite3-multiple-ciphers/build/Release/better_sqlite3.node` was present
  immediately after install (no `node-gyp` invocation observed, no build errors).
- `bun install` was run afterward to sync `bun.lock` (both `package.json` and `bun.lock` show
  the new devDependency; `bun install` reported "Checked 242 installs across 277 packages" with
  the new package resolved).
- Isolated spike run: `npm test -- tests/security/cipher-spike.test.ts`

  ```
  Test Files  1 passed (1)
       Tests  2 passed (2)
  ```

- Full suite: `npm test`

  ```
  Test Files  59 passed (59)
       Tests  530 passed | 4 skipped (534)
  ```

  No pre-existing test regressed. The cipher spike test file is additive (`tests/security/` is a
  new directory); nothing in `src/` was touched.

## Type-compatibility finding (informs the 1b driver swap)

`src/storage/migrate.ts` types its parameter as `DB` (`import type { DB } from './db.js'`, which
resolves to `Database.Database` from `better-sqlite3`). A standalone type-check
(`npx tsc --noEmit --strict ...` against a scratch file, not committed) constructing a
`better-sqlite3-multiple-ciphers` `Database` instance and passing it to `migrate(db)` **compiled
cleanly, exit 0** — no structural type mismatch. `better-sqlite3-multiple-ciphers` ships its own
`index.d.ts` (`"types": "index.d.ts"` in its `package.json`) that is structurally compatible with
better-sqlite3's `Database.Database` shape (`.prepare`, `.exec`, `.pragma`, `.transaction`, etc.
all match). This means for the 1b driver swap, `migrate()` should need **no signature change** —
only `src/storage/db.ts`'s `openDb()` would swap its `Database` import and add the `PRAGMA key`
step. The exported `DB` type alias in `db.ts` may need to be re-pointed at the cipher package's
`Database.Database` (or kept structural) so callers across the codebase don't need edits.

## Observations relevant to the 1b driver swap

- `PRAGMA key = '...'` is **rejected** on `:memory:` databases
  (`SqliteError: Setting key not supported for in-memory or temporary databases`). Any test or
  code path currently using `openDb(':memory:')` (this repo's entire test suite does — see
  `tests/storage/migrate.test.ts`, `tests/vector/sqlite-vec.test.ts`, etc.) **cannot** enable
  encryption in-memory. This is expected/fine for tests (no encryption needed for ephemeral
  in-memory test DBs) but 1b must make the `PRAGMA key` step conditional on file-backed opens, or
  tests will need to switch to temp-file DBs if they want to exercise the ciphered path.
- `vec0` virtual table rowids must be passed as `BigInt`, not plain JS `number`, or the extension
  throws `SqliteError: Only integers are allows for primary key values on v` — this matches the
  existing pattern already used in `src/vector/sqlite-vec.ts` (`BigInt(memoriesRowid)`), so no new
  finding for the production code path, but worth flagging for anyone hand-rolling cipher-path
  tests without going through `SqliteVecStore`.
- No API incompatibilities surfaced between `better-sqlite3-multiple-ciphers` and `better-sqlite3`
  beyond the additive `PRAGMA key`/`rekey` support — `loadExtension`, `.prepare`, `.exec`,
  `.pragma`, `.transaction`, `.close` all behave identically in this spike.
- Raw file header on the encrypted DB is high-entropy binary (confirmed via byte read), not the
  15-byte `"SQLite format 3\0"` magic — this is the actual evidence of at-rest encryption per
  SEC-1/2, not just an API claim.

## What CI must confirm (3-OS matrix)

This spike is Windows-only evidence. The repo's CI runs the suite on ubuntu, macos, and windows
(Bun 1.3, `bun install --frozen-lockfile` + `bun run test`). Before 1b proceeds, push this branch
and confirm:

1. `bun install --frozen-lockfile` succeeds on all 3 OSes (i.e. `better-sqlite3-multiple-ciphers`
   has a prebuilt binary — or builds cleanly from source — for linux-x64, darwin (arm64/x64), and
   win32-x64 under Bun 1.3).
2. `tests/security/cipher-spike.test.ts` passes on all 3 OSes (proves sqlite-vec extension-load
   works on the ciphered driver's native binary on each platform, not just Windows).
3. The full suite (`bun run test`) is still 100% green on all 3 OSes — no regression from adding
   the devDependency.

## Go/no-go rule

- **CI green on ubuntu + macos + windows** → 1b proceeds with the `better-sqlite3-multiple-ciphers`
  driver swap in `src/storage/db.ts` (add `PRAGMA key` conditional on file-backed path, keep
  `sqlite-vec.load()` unchanged, `migrate()` needs no signature change per the type-compat finding
  above).
- **Any OS fails** (prebuilt binary unavailable and source build fails, or sqlite-vec fails to load
  against the ciphered native binary, or KNN queries misbehave on an encrypted file on that OS) →
  invoke the ADR-002 fallback: **application-level encryption of the `text` / `evidence` /
  `transcripts` columns** + OS file permissions (weaker but ships), and revisit the cipher driver
  quarterly per ADR-002 §Consequences.

## Files

- `tests/security/cipher-spike.test.ts` — new, additive spike test (not wired into any other
  suite; self-contained, does not import `src/storage/db.ts`).
- `package.json` — `better-sqlite3-multiple-ciphers` added under `devDependencies` (spike only;
  the 1b production dependency-list decision is separate).
- `bun.lock` — regenerated via `bun install` to include the new devDependency (required for CI's
  `--frozen-lockfile`).
