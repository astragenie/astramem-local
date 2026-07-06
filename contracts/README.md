# @astragenie/astramem-contracts

The cross-repo technical constitution for AstraMem. `astramem-local` (Bun/TS/SQLite)
and AstraMem cloud (.NET/Postgres) are two different implementations of the
same product; this directory is the single source of truth both must
conform to, enforced in CI on both sides. See:

- [ADR-001: Canonical Memory Atom](../docs/adr/ADR-001-canonical-memory-atom.md)
- [ADR-003: Sync Protocol](../docs/adr/ADR-003-sync-protocol.md)
- [ADR-005: Retrieval — contract + shared eval harness](../docs/adr/ADR-005-retrieval-contract.md)
- [ADR-008: Capture Protocol](../docs/adr/ADR-008-capture-protocol.md) / [docs/capture-protocol.md](../docs/capture-protocol.md)

v1 ships **in-repo**, consumed directly by this repo's CI (`.github/workflows/lint.yml`)
and vitest suite (`tests/contracts/conformance.test.ts`). The `package.json`
in this directory is already shaped for a future standalone npm publish
(`@astragenie/astramem-contracts`) once the cloud repo needs it as an
out-of-tree dependency instead of a git-submodule / vendored copy — see
"Cloud consumption" below for what that migration looks like.

## What's here

```
contracts/
  package.json              — publishable package metadata (private: true for now)
  validate.mjs               — plain Node script; compiles every schema, asserts
                                every fixtures/valid/* passes and every
                                fixtures/invalid/* fails. No deps beyond ajv +
                                ajv-formats (installed at the repo root).
  schemas/
    atom.v1.schema.json               — astramem/atom@1 (ADR-001)
    retrieval-query.v1.schema.json    — astramem-retrieval@1 query envelope (ADR-005)
    retrieval-result.v1.schema.json   — astramem-retrieval@1 result envelope + ScoreExplanation (ADR-005)
    sync-envelope.v1.schema.json      — astramem-sync@1 envelope (ADR-003)
    capture-envelope.v1.schema.json   — astramem-capture@1 envelope (ADR-008)
  fixtures/
    valid/<schema-prefix>-*.json      — >=3 per schema, each a distinct valid shape
    invalid/<schema-prefix>-*.json    — >=3 per schema, each violating a DIFFERENT constraint
    eval/
      corpus.json    — ADR-005 seed retrieval-eval corpus: 12 atoms, all 7 types,
                        one superseded pair, one entity-heavy fact
      queries.json   — 8 graded queries incl. one bitemporal as_of case
```

Every JSON Schema is **draft 2020-12**, plain JSON with no TypeScript-only
constructs — this is deliberate so the .NET cloud repo's CI can consume the
exact same files with a JVM/.NET JSON Schema validator (NJsonSchema,
JsonSchema.Net, etc.) without any transpilation step.

## Generated TypeScript types (`types/`)

For TypeScript consumers (astramem-local itself, astramem-plugin) that want
compile-time types on the hot path rather than a runtime ajv validator,
`generate-types.mjs` compiles each schema to a `.d.ts` under `types/` plus an
`index.d.ts` barrel. **These are GENERATED — never hand-edit.** The JSON Schema
stays the single source of truth; the types are a build artifact.

```bash
node contracts/generate-types.mjs   # regenerate types/*.d.ts
npm run contracts:generate          # same, via root script
npm run contracts:build             # generate + validate in one step
```

Root interface names are deterministic `<Name>V<N>` (`AtomV1`,
`RetrievalQueryV1`, `RetrievalResultV1`, `CaptureEnvelopeV1`, `SyncEnvelopeV1`),
re-exported from `@astragenie/astramem-contracts/types`. CI should run
`contracts:generate` and fail on a non-empty git diff, so a schema change that
wasn't accompanied by a regenerated type is caught as drift.

Cloud (.NET) does NOT use these — it consumes the JSON Schema directly (above).
The generated `.d.ts` are a TypeScript-consumer convenience only.

## Generated Zod validators (`zod/`)

TypeScript consumers that validate untrusted wire input at **runtime** (the
plugin's providers call `.parse()` on backend responses; local's routes validate
request bodies) want a Zod schema, not just compile-time types. `generate-zod.mjs`
compiles each JSON Schema to a runtime Zod validator under `zod/` +
an `index.ts` barrel. **GENERATED — never hand-edit.**

```ts
import { RetrievalQueryV1Schema, RetrievalResultV1Schema } from '@astragenie/astramem-contracts/zod';
const result = RetrievalResultV1Schema.parse(await res.json()); // runtime-validated + typed
```

Const names are `<Name>V<N>Schema` (`AtomV1Schema`, `RetrievalQueryV1Schema`, …),
each with a co-exported `z.infer` type. This is what lets the plugin delete its
hand-rolled `RecallResponseSchema`/`IngestPayloadSchema` (program slice U3) and
validate against the canonical contract instead. Round-tripped against the same
`fixtures/{valid,invalid}/*` in CI. Cloud (.NET) still uses JSON Schema + a .NET
validator — Zod is a TypeScript-consumer convenience only.

> **⚠ Caveat — Zod is LOSSY on conditional schemas.** `json-schema-to-zod` cannot
> translate JSON-Schema `if/then`/`allOf` conditionals; it emits a no-op
> (`z.intersection(z.any(), z.any())`). This affects **`capture-envelope.v1`**,
> whose `kind:"events" → require events` / else `require turns` rule is therefore
> **NOT enforced by `CaptureEnvelopeV1Schema`**. The `validate.mjs` ajv gate (and
> any .NET JSON-Schema validator) DOES enforce it — so the JSON Schema stays the
> authoritative validator. Consumers needing the conditional at runtime should
> `.superRefine()` on top of the generated Zod, or validate with ajv against
> `schemas/capture-envelope.v1.schema.json` directly. `atom.v1`, `retrieval-query.v1`,
> `retrieval-result.v1`, `sync-envelope.v1` have no conditionals and generate
> faithful Zod.

## Fixture naming convention (load-bearing)

`validate.mjs` and `tests/contracts/conformance.test.ts` both route fixtures
to schemas by filename prefix, derived mechanically from the schema file
name: `<name>.v<N>.schema.json` -> fixture files must start with
`<name>-v<N>-`. Example: `atom.v1.schema.json` matches
`fixtures/valid/atom-v1-decision-string-evidence.json`. A fixture whose name
doesn't match any schema's prefix fails the run (silently-skipped fixtures
would defeat the gate) — both runners assert every fixture file was matched
exactly once.

## Versioning rules (ADR-001)

- **Additive change** (new optional field, new enum value in an
  already-open registry) = **minor** version bump on the schema `$id` /
  `title` (e.g. `astramem/atom@1` stays `@1`; a genuinely breaking shape
  change would be `@2`).
- **Breaking change** (removing/renaming a required field, narrowing a type,
  removing an enum value) = **new major** (`@2`), shipped alongside the old
  schema for a **dual-read window**: both repos accept both versions until
  every writer has migrated, then the old schema is deleted. This mirrors
  the wire-version negotiation already used by the capture protocol
  (`wire_version` field) and sync protocol (`GET /sync/capabilities`).
- Fixtures for a deprecated major stay in `fixtures/` (under `deprecated/`
  once that's needed) until the dual-read window closes, so regression
  coverage doesn't silently disappear mid-migration.

## Evidence reconciliation (atom.v1.schema.json)

ADR-001's decision text specifies `evidence` as
`[{ transcript_id, span: [start, end] }]` — structured receipts pointing at
source transcript spans. **Reality**: `astramem-local` v1 stores evidence as
a single free-text excerpt string (`memories.evidence` column, migration
`004-provenance.sql`; see `src/contracts/memory.ts` `Memory.evidence:
string | null`).

Rather than let the schema describe an aspiration astramem-local doesn't
actually produce, `atom.v1.schema.json` models `evidence` as
`anyOf [string, array-of-refs]`:

- the **string** form is documented in the schema as "local v1 form" and is
  what `src/contracts/atom-wire.ts` (`toAtomWireV1`) emits today;
- the **array-of-refs** form is the ADR-001 canonical shape, which cloud can
  emit once/if it tracks per-span provenance.

This is a pragmatic-contract-truth-beats-aspiration call: a schema that
rejects every atom astramem-local actually produces is not a contract, it's
a wishlist. When local gains span-level evidence tracking, the string arm
can be deprecated behind the versioning rule above rather than breaking the
schema retroactively.

## Retrieval result — ScoreExplanation signal map

ADR-005 requires every retrieval hit to carry a `ScoreExplanation` with
per-signal raw score, weight, and final contribution, and states this is
never optional. `retrieval-result.v1.schema.json` makes `explanation`
**required** on every hit (not conditional on the query's `explain` flag).

`explanation.signals` is an **open map** keyed by signal name
(`additionalProperties`, not a closed enum) so both engines validate without
either one dictating the other's fusion formula:

- **local** (`src/search/fuse.ts`): `bm25`, `cosine`, `importance`,
  `freshness` — 4-signal fusion (α=β=0.4, γ=δ=0.1).
- **cloud**: 6-signal fusion + RRF fallback + cross-encoder rerank seam
  (ADR-005 engine-specific rulings) — different signal names entirely
  (e.g. `rrf`, `cross_encoder`).

Each signal's own shape is fixed: `{ raw: number, weight: number, final:
number }`. See `contracts/fixtures/valid/retrieval-result-v1-cloud-six-signals.json`
vs. `retrieval-result-v1-single-hit-local-signals.json` for both engines
validating against the same schema.

## Retrieval query — project/agent/entity filters (FEAT-424)

`retrieval-query.v1.schema.json`'s `filters` block is the **canonical**
project/agent/entity recall-filter contract — the single source of truth
FEAT-424 unifies `astramem-local`, `astramem-plugin`, and the memory SaaS
backend around, replacing three independently-drifted filter shapes:

- `filters.project` and `filters.agent` are `anyOf [string, string[]]` — a
  single value is exact match, a list is OR/IN-semantics. An empty array is
  "no constraint" (never match-nothing).
- `filters.entity` is a plain `string`, resolved by each engine's own
  normalize seam (case/whitespace-insensitive, exact match then substring
  fallback per ADR-005 / FEAT-402).
- `project` + `agent` AND-compose when both are present.

`astramem-local`'s own `tsconfig.json` scopes `rootDir` to `src/`, so its
daemon code cannot `import` `contracts/zod/retrieval-query.v1.ts` directly
(TS6059 — the file lives outside `rootDir`). Its wiring
(`src/contracts/recall-filters.ts`) is therefore a hand-mirrored copy of this
schema's filter shape, held honest by
`tests/contracts/recall-filter-parity.test.ts` (ajv-compiles this schema at
test time and asserts the Zod mirror agrees). `astramem-plugin` and the
memory SaaS backend do not have that constraint — they should import
`@astragenie/astramem-contracts/zod`'s `RetrievalQueryV1Schema` (or the
`.d.ts` types) directly rather than hand-rolling a third copy. See
`docs/recall-filters.md` "Canonical contract (FEAT-424)" for full daemon-side
wiring detail and the cross-repo adoption follow-up.

## Sync envelope timestamps

`sync-envelope.v1.schema.json` keeps `created_at` as an **epoch-ms
integer**, not an ISO string, deliberately breaking from `atom.v1`'s ISO
8601 convention: the event shape is a 1:1 mirror of the `memory_events`
table (migration `007-memory-events.sql`, an `INTEGER` column), because
ADR-003 sync is log-shipping — the wire form of a log row should be the log
row, not a reformatted view of it.

## Running the gate locally

```bash
node contracts/validate.mjs      # standalone — schemas + fixtures only
npm run contracts:validate       # same thing, via the package.json script
bun run test                     # full vitest suite, includes
                                  # tests/contracts/conformance.test.ts
                                  # (schema compile + fixtures + LIVE
                                  # conformance against the real pipeline)
```

CI: `.github/workflows/lint.yml` runs `node contracts/validate.mjs` as a
step immediately after `tsc --noEmit` (cheap, fast, no build required).
`.github/workflows/test.yml` gates on the vitest conformance suite as part
of the normal `bun run test` run.

## Cloud consumption (what task 3b/3c needs)

The cloud (.NET) repo's CI needs:

1. **The files**: either (a) a git submodule / subtree pointing at this
   repo's `contracts/` directory, or (b) once published, an npm/NuGet-side
   artifact download of `@astragenie/astramem-contracts@1.0.0`. v1 ships (a)
   — no publish step yet, `private: true` in `contracts/package.json`.
2. **A runner**: cloud's CI does not need Node — the schemas are pure JSON
   Schema draft 2020-12 with `additionalProperties`, `anyOf`, `allOf`/`if`/
   `then`, `format` (uuid, date-time), and `pattern` keywords only. Any
   conformant .NET validator (e.g. `JsonSchema.Net`, `NJsonSchema`) can load
   `contracts/schemas/*.schema.json` directly and run the same
   valid-passes/invalid-fails assertion against `contracts/fixtures/{valid,invalid}/*.json`
   using the same filename-prefix routing rule described above.
3. **The eval harness**: `contracts/fixtures/eval/corpus.json` +
   `queries.json` are the shared golden retrieval-eval fixture set (ADR-005
   part 3). Cloud's retrieval CI job loads both, runs its own engine against
   `queries.json`, and computes recall@10 / NDCG@10 against the graded
   `graded_relevant` lists — thresholds are not gated yet (v1 = seed size
   only), but the harness format is fixed now so both sides measure the same
   thing when thresholds land.
4. **Versioning discipline**: cloud CI should fail (not warn) if it detects
   a schema `$id`/`title` version it doesn't recognize, per the dual-read
   window rule above — that failure is the signal a contract bump needs a
   coordinated two-repo rollout, not a silent skip.
