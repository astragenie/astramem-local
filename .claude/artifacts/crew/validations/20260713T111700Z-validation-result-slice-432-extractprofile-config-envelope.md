# Validation Result — SLICE-432 (extractProfile config/envelope plumbing, migration 028, SCHEMA_VERSION 28)

**Result: PASS** (5/5 scenarios)

Scope validated (UNCOMMITTED working tree at time of validation): migration
`028-extract-profile.sql` (additive nullable `transcripts.extract_profile`),
`SCHEMA_VERSION` bump to 28 (`src/server/lib/wire-meta.ts`), the closed-enum
`distill.extractProfile` config field + `applyExtractProfileGovernance`
(`src/config/config.ts`), writer/loader plumbing (`src/config/writer.ts`,
`src/config/loader.ts`), the canonical envelope's optional `extract_profile`
field (`CanonicalIngestSchema`, `src/server/routes/ingest.ts`), the
transcripts-row → `distillHandler` → `PipelineContext.extractProfile` carry
(`src/pipeline/handlers/distill.ts`, `src/distill/pipeline.ts`), and
`resolveExtractionPrompt`'s precedence resolution (`src/distill/prompts/extract.ts`,
`src/distill/stages/05-extract.ts`). Reviews already PASS ×2 per the dispatch;
this artifact covers exercised behavior only, not code reading.

Build: `bun run build` run first (`tsc -p .`, clean, no errors) before any
scenario — dist/ confirmed fresh.

## Scenario 1 — Fresh boot: PASS

Spawned `node dist/cli/index.js serve --port 0` with
`ASTRA_MEMORY_DATADIR=:memory:`, a unique `ASTRA_MEMORY_TOKEN`, and
`ASTRA_MEMORY_MOCK_PROVIDERS=1` (never port 7777, never the default datadir).
Boot log was a single clean "serving on 127.0.0.1:<port>" line — no migration
errors.

```
GET /health ->
{
  "ok": true,
  "version": "0.15.1",
  "schema_version": 28,
  "status": "ok",
  ...
}
```

Note: a first attempt without `ASTRA_MEMORY_DATADIR` set correctly
self-exited immediately via the daemon's own single-instance lock ("already
running (pid ..., port 7777)") rather than touching the real production
daemon or its datadir — confirms the lock guard works as a safety net; the
corrected env was used for the actual scenario. Daemon killed by PID after
the check (not by image name); no stray process left running, `:memory:`
never touches the OS keystore (confirmed via `src/cli/serve.ts`'s
`dataDir === ':memory:'` branch, which skips `getOrCreateKey` entirely).

## Scenario 2 — Upgrade path on a populated pre-028 DB: PASS

Reimplemented `migrate()`'s own file-application loop (registering
`sha256_hex`, same as `src/storage/migrate.ts`) to apply **only** migration
files 001–027 against a fresh `:memory:` DB — i.e. a DB that has never seen
`extract_profile`. Seeded 1 session + 1 transcript + 1 memory via raw SQL
matching the pre-028 column shapes. Then called the actual, unmodified
`migrate()` from `dist/storage/migrate.js` (the same function `serve.ts`
calls at boot).

Result:
```json
{
  "maxVersionBefore": 27,
  "hasExtractProfileBefore": false,
  "countsBefore": { "transcripts": 1, "memories": 1 },
  "migrateError": null,
  "maxVersionAfter": 28,
  "hasExtractProfileAfter": true,
  "countsAfter": { "transcripts": 1, "memories": 1 },
  "transcriptRowAfter": {
    "id": "pre-upgrade-transcript-1",
    "content": "pre-upgrade content",
    "extract_profile": null
  },
  "memoryRowAfter": { "id": "pre-upgrade-memory-1", "text": "pre-upgrade memory text" },
  "vecSchemaDimAfter": 1024
}
```
Migration 028 applied cleanly on the populated DB, zero data loss (both rows
byte-identical to their pre-upgrade content), the pre-existing transcript row
reads `extract_profile: null` (as documented — additive nullable column,
NULL for every row that predates it), and `vecSchemaDim` is untouched at
1024 (028 has no interaction with `memories_vec`, consistent with the
migration file's own header comment).

## Scenario 3 — Live envelope round-trip: PASS

Built the actual Fastify app (`buildApp` from `dist/server/app.js` — the
same app `serve.ts` constructs) against a fresh `:memory:` DB, migrated to
28, and drove all three envelope cases through the real route handler via
`app.inject()` (chosen over a second daemon spawn specifically so the
`:memory:` DB could be queried directly afterward — a separately-spawned
daemon's `:memory:` DB isn't reachable from outside the process):

| case | POST /ingest/transcript | HTTP | `transcripts.extract_profile` |
|---|---|---|---|
| `extract_profile: "conversational"` | canonical envelope | **200** | `'conversational'` |
| field omitted | canonical envelope | **200** | `NULL` |
| `extract_profile: "bogus_value"` | canonical envelope | **400** `{"error":"invalid",...}` | (no row inserted — zod rejects before the insert) |

Also drove the same three cases against a real spawned daemon (Scenario 1's
`:memory:` + mock-providers instance) over actual HTTP for an independent
confirmation of the 200/200/400 status codes — matched exactly. Response
bodies for the 200 cases included `extraction_job_id` and
`queued_extraction_types` as expected for the transcript-kind async path.

## Scenario 4 — Config surface: PASS

Used the real writer (`configToYaml`) and real loader (`loadConfigFromDisk`)
directly, no hand-built YAML:

- `defaultConfig()` → `configToYaml()` emits `extractProfile: engineering`
  under `distill:` → round-tripped through `loadConfigFromDisk` →
  `loaded.distill.extractProfile === 'engineering'`.
- `defaultConfig()` with `distill.extractProfile` set to `'conversational'`
  → `configToYaml()` emits `extractProfile: conversational` → round-tripped
  through `loadConfigFromDisk` → `loaded.distill.extractProfile ===
  'conversational'`.

```json
{
  "defaultYamlHasLine": true,
  "loadedDefaultExtractProfile": "engineering",
  "conversationalYamlHasLine": true,
  "loadedConversationalExtractProfile": "conversational"
}
```

## Scenario 5 — Regression: PASS

```
bunx vitest run tests/e2e/ tests/integration/ingest-e2e.test.ts
 Test Files  6 passed (6)
      Tests  17 passed (17)
```

## Cleanup

Both temp daemons (Scenario 1's real spawn, and the independent HTTP
cross-check) killed by PID, never by image name. No production datadir,
port 7777, or the OS keystore touched by this validation run — `:memory:`
datadir used throughout per `src/cli/serve.ts`'s documented
never-touches-keystore branch. All scratch `.mjs` scripts were run from a
copy in the repo root and removed immediately after each run; `git status`
confirmed no stray files or working-tree changes were left behind by this
validation beyond what was already uncommitted at the start.

## Overall

PASS — all 5 requested scenarios green: fresh boot serves schema_version 28,
the upgrade path from a populated pre-028 DB applies cleanly with zero data
loss, the live envelope round-trip resolves all three precedence cases
exactly as documented (override / absent-NULL / invalid-400), the config
writer/loader round-trip carries `extractProfile` correctly in both
directions, and the full targeted regression suite is green. No further
action needed for SLICE-432 gate purposes.
