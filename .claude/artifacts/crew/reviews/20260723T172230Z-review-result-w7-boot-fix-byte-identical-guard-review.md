# Review Result — Wave 7 boot-fix: `openBootDb` extraction + single-open regression guard

- **Worktree:** `C:\work\mega\astra-wt\w7-boot`
- **Branch:** `w7/boot-fix`
- **Reviewed commit:** `ebaa0a1235c6bc16da1d6c7492a6509c60d7a6fd`
- **Base:** `f2382da9` (feat/retrieval-overhaul tip)
- **Reviewer:** independent review agent (astramem-local session)
- **Verdict: PASS**

## Scope

`git show ebaa0a12 --stat` confirms exactly two files touched, nothing else:

```
src/cli/serve.ts                         |  83 ++++++++++++++---------
tests/cli/serve-boot-single-open.test.ts | 112 +++++++++++++++++++++++++++++++
2 files changed, 164 insertions(+), 31 deletions(-)
```

No scope creep: no pragma changes, no `migrate()`/worker wiring changes, no logic change to boot ordering (`bootAndBind`'s bind-before-migrate vs. `--strict-preflight`'s migrate-before-bind branches are untouched — only the DB-open sub-block moved).

## Null-result claim (independently re-verified)

The commit message's investigation claim — exactly one `openDb()` call reachable before `app.listen()` in either boot branch, because `migrate()` takes an already-open handle and never opens its own — holds. `src/storage/migrate.ts` has no `openDb`/`Database` import, confirming `migrate(db, ...)` only consumes the handle passed in. This matches the prior investigation the team-lead already verified; I did not need to re-derive it, only confirm the commit's refactor doesn't disturb it.

## Behavior-preservation check (extract-function-only)

Compared `git show f2382da9:src/cli/serve.ts`'s inline `if (dataDir === ':memory:') { ... } else if (cfg.security.encryption.enabled) { ... } else { ... }` block against the new `openBootDb(dataDir, dbPath, cfg)` at `src/cli/serve.ts:982` line-by-line:

| Aspect | Pre-image (inline) | Post-image (`openBootDb`) | Match |
|---|---|---|---|
| Branch order/conditions | `:memory:` → encryption-enabled → plaintext | identical order, identical conditions | yes |
| `:memory:` path | `db = openDb(dbPath)`, no key | `return { db: openDb(dbPath) }` | yes |
| Encrypted path | `getOrCreateKey` → `encryptIfPlaintext` → `openDb(dbPath, {key})` → `dbKey = keyResult.key`, catch → `rewrapWrongKeyError` | same call sequence, same catch, same error wrap, returned instead of assigned | yes |
| Plaintext path | `console.warn(...)` (exact string) → `db = openDb(dbPath)` | identical warning string → `return { db: openDb(dbPath) }` | yes |
| `rewrapWrongKeyError` | unchanged (diff shows this function untouched, only its call site moved) | same | yes |
| Call-site wiring | `db = opened.db; const dbKey = opened.dbKey; dbForCrash = db;` | preserves `db`/`dbKey`/`dbForCrash` semantics exactly (`dbForCrash` still assigned right after, same position) | yes |
| New imports | `type DB` from `../storage/db.js`, `type Config` from `../config/config.js` | both are legitimate type-only exports (`storage/db.ts:5`, `config/config.ts:10`) — no runtime behavior change | yes |

`bunx tsc --noEmit -p tsconfig.json` and `-p tsconfig.tests.json` both ran clean (no output, no errors) — the extraction is type-sound with the new exported signature.

No semantic drift found — no dropped log line, no reordered pragma/key step, no changed error type.

## Guard-quality check (is the assertion real?)

Ran the test file in isolation, then **injected a synthetic regression** into `openBootDb`'s plaintext branch (an extra `openDb(dbPath)` call before the real one) to confirm the guard actually fails on a real second-open, rather than passing vacuously:

```
AssertionError: expected "openDb" to be called 1 times, but got 2 times
 ❯ tests/cli/serve-boot-single-open.test.ts:85:17
```

The guard caught it immediately. Reverted the injection afterward; `git diff --stat` against `ebaa0a12` is empty, confirming the worktree is back to the exact reviewed commit. Re-ran the file clean: 4/4 pass.

Coverage of all 3 branches confirmed real, not decorative:
- `:memory:` — asserts 1 call, `dbKey` undefined.
- plaintext — asserts 1 call, called with `dbPath`, `dbKey` undefined.
- encrypted (fresh datadir) — asserts 1 call, `dbKey` equals the mocked key.
- wrong-key NOTADB — mocks `openDb` to throw `SQLITE_NOTADB`, asserts `rewrapWrongKeyError`'s message (`/does not match this file/`) still fires unchanged after extraction.

`getOrCreateKey` is mocked only in `keystore.js` (never touches the real `%APPDATA%\Astramem` credential store); `encryptIfPlaintext` is correctly left unmocked since every test uses a fresh temp dir where the path doesn't exist yet — confirmed against `encryptIfPlaintext`'s real first line (`if (!existsSync(dbPath)) return 'missing';`) in `src/storage/migrate-encrypt.ts:67`, so it's a genuine no-op, not a test-only shortcut.

## Full-suite verification

```
bunx tsc --noEmit -p tsconfig.json         # clean, no output
bunx tsc --noEmit -p tsconfig.tests.json   # clean, no output
npx vitest run tests/cli tests/server      # 67 files, 825 tests passed
```

Matches the builder's claimed 825/67 exactly.

## Conclusion

- Extraction is byte-identical behavior (confirmed by direct pre/post-image line comparison — not just "no test regression").
- New regression guard is real: proven to catch an injected second-open, not vacuous.
- Scope is exactly the 2 files claimed; no boot-sequence, pragma, or wiring changes.
- Full relevant suite green (825/825), both tsconfigs clean.

**PASS — cleared for merge to the release branch.**
