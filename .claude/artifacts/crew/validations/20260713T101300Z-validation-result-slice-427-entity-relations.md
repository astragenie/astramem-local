# Validation Result — SLICE-427 (migration 027 entity_relations + EntityRelationRepo + supersede cascade)

**Result: PASS** (4/4 scenarios)

Scope validated: migration `027-entity-relations.sql`, `EntityRelationRepo`
(`src/storage/entity-relations.ts`), the `supersede()` cascade delete in
`src/storage/memory-events.ts:307`, `SCHEMA_VERSION` bump to 27
(`src/server/lib/wire-meta.ts`), on the UNCOMMITTED working tree at time of
validation. Reviews already PASS (see
`.claude/artifacts/crew/reviews/20260713T100837Z-review-slice427-entity-relations.md`);
this artifact covers exercised behavior only, not code reading.

Build: `bun run build` run first (clean `tsc -p .`, no errors) — dist/ was
stale before this run, confirmed fresh before any daemon-spawn scenario.

## Scenario 1 — Fresh-install boot path: PASS

Spawned `node dist/cli/index.js serve --port 0` with
`ASTRA_MEMORY_DATADIR=<temp dir>` (never port 7777, never the default
datadir). Boot log showed no migration errors, embed preflight ok.

```
GET /health ->
{
  "ok": true,
  "version": "0.15.1",
  "schema_version": 27,
  "status": "ok"
}
```

Daemon PID killed after the check (no stray process left running); temp
datadir removed afterward.

## Scenario 2 — Upgrade path on a populated pre-027 DB: PASS

Reimplemented `migrate()`'s own file-application loop (registering
`sha256_hex`, same as `src/storage/migrate.ts`) to apply **only** migration
files 001–026 against a fresh `:memory:` DB — i.e. a DB that has never seen
`entity_relations`. Seeded 2 memories + 2 entities via the real
`MemoryRepo`/`EntityRepo`. Then called the actual, unmodified `migrate()`
from `dist/storage/migrate.js` (the same function `serve.ts` calls at boot).

Result:
- `maxVersionBefore: 26`, `hasEntityRelationsBefore: false`
- `migrateError: null` — migration 027 applied cleanly on the populated DB
- `maxVersionAfter: 27`, `hasEntityRelationsAfter: true`
- `countsAfter` unchanged from `countsBefore` (2 memories, 2 entities) —
  zero data loss
- Both pre-upgrade memory rows and both pre-upgrade entity rows read back
  byte-identical (id + text/name) after the migration
- A post-upgrade `EntityRelationRepo.insert()` citing the **pre-upgrade**
  memory/entity rows succeeded (`inserted: true`) — proves the new table
  interoperates with data older than itself
- `vecSchemaDim` still 1024 post-upgrade (untouched, as expected — 027 has
  zero interaction with `memories_vec`, per the migration file's own header
  comment)

## Scenario 3 — Live erase cascade via the REAL route: PASS

Built the actual Fastify app (`buildApp` from `dist/server/app.js` — the
same app `serve.ts` constructs) against a fresh `:memory:` DB. Seeded one
memory, two entities, and one `entity_relations` row via
`EntityRelationRepo.insert()` citing that memory as evidence. Then called
the real route handler via `app.inject()`:

```
DELETE /memory/:id  (Authorization: Bearer <token>)
-> 200 { "ok": true }
```

Post-erase checks against the live app's DB connection:
- `entity_relations` rows citing the erased memory: 1 -> 0
- `memories` row for that id: gone (hard-deleted, as `erase()` documents)
- Orphan-relation scan (`entity_relations` LEFT JOIN `memories` WHERE
  `memories.id IS NULL`): **0** — no dangling FK, cascade fired cleanly, no
  FK-violation error thrown
- Follow-up `GET /health` on the same app instance: `200 { ok: true }` —
  daemon/app stayed healthy after the erase

Note on approach: the task suggested exercising this against the running
temp daemon's own DB file directly. That daemon (spawned with
`ASTRA_MEMORY_DATADIR` pointed at a temp dir) turned out to resolve its
encryption key via `getOrCreateKey(defaultConfigDir())` — `defaultConfigDir()`
is **not** scoped by `ASTRA_MEMORY_DATADIR`, so it reads/writes the OS
credential store under the same global identity a real production install
uses (matches the known "Keystore global identity collision" issue). To
avoid any interaction with that store, that daemon was killed immediately
after Scenario 1's `/health` check, and Scenario 3 was instead run fully
in-process (`buildApp` + `app.inject()`) against a `:memory:` DB with an
explicit test bearer token — this exercises the identical route handler
code with no daemon/keystore risk. Flagging this pre-existing footgun
(unrelated to SLICE-427 itself) in case it needs a follow-up FEAT.

## Scenario 4 — Regression smoke: PASS

```
bunx vitest run tests/e2e/ tests/integration/ingest-e2e.test.ts
 Test Files  6 passed (6)
      Tests  17 passed (17)
```

Also ran the full set of directly-touched/new test files for this slice as
additional evidence (not strictly requested, but cheap and directly on
point):

```
bunx vitest run tests/storage/entity-relations.test.ts tests/storage/migrate.test.ts \
  tests/storage/upgrade-path.test.ts tests/storage/entities.test.ts \
  tests/storage/entity-validity.test.ts tests/storage/atom-v3.test.ts \
  tests/server/version.test.ts
 Test Files  7 passed (7)
      Tests  135 passed (135)
```

## Cleanup

No stray daemon processes left running (both temp-spawned daemons killed by
PID, never by image name). Both temp datadirs removed. No production
datadir, port 7777, or the OS keystore were mutated by this validation run.

## Overall

PASS — all 4 requested scenarios green, plus the full directly-touched test
surface green. No further action needed for SLICE-427 gate purposes beyond
the keystore-scoping observation above (pre-existing, not a regression
introduced by this slice).
