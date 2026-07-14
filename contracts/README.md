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
in this directory is publishable (`@astragenie/astramem-contracts`, GitHub
Packages) via `.github/workflows/contracts-publish.yml`, tag-triggered on
`contracts-v*` — separate from the root package's `v*` tag scheme. See
"Publishing" and "Cloud + plugin consumption" below.

## What's here

```
contracts/
  package.json              — publishable package metadata (GitHub Packages,
                                see "Publishing" below)
  validate.mjs               — plain Node script; compiles every schema, asserts
                                every fixtures/valid/* passes and every
                                fixtures/invalid/* fails. No deps beyond ajv +
                                ajv-formats (installed at the repo root).
  wire.ts                    — hand-written wire-protocol constants (WIRE_VERSION,
                                WIRE_VERSION_PATTERN, WIRE_VERSIONS_SUPPORTED,
                                SYNC_PROTOCOL), see "Wire-protocol constants" below.
  manifests/
    mcp-tools.v1.json         — canonical MCP verb_noun tool-name manifest (U5),
                                see "MCP tool-name manifest" below.
  schemas/
    atom.v1.schema.json               — astramem/atom@1 (ADR-001)
    atom.v2.schema.json               — astramem/atom@2 (ADR-001 amendment, 2026-07-09) — see
                                          "Memory atom v2 (atom@2 breaking cut)" below
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

## Wire-protocol constants (`wire.ts`)

Some cross-repo wire agreements aren't a JSON Schema shape — they're small,
stable literals (a version string, a compiled regex, a protocol name) that
still need to be bit-for-bit identical across astramem-local, astramem cloud
(.NET), and astramem-plugin. `wire.ts` is a **hand-written** module for
exactly these (never touched by `generate-types.mjs` / `generate-zod.mjs`),
importable as `@astragenie/astramem-contracts/wire`:

```ts
import { WIRE_VERSION, WIRE_VERSION_PATTERN, WIRE_VERSIONS_SUPPORTED, SYNC_PROTOCOL } from '@astragenie/astramem-contracts/wire';
```

- **`WIRE_VERSION`** (`'v1.0'`) — the capture-protocol `wire_version` value
  this package's `capture-envelope.v1` schema targets for new writers.
- **`WIRE_VERSION_PATTERN`** — the M-R7 **tightened** `wire_version` regex,
  `^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$`: ASCII digits only, leading
  zeros disallowed in *both* the major and minor component (so `"v01.0"`
  and `"v1.01"` are both rejected). Byte-for-byte the same pattern as
  `capture-envelope.v1.schema.json`'s `wire_version.pattern` (this change
  tightened that schema to match — see changelog below) and cloud's
  `IngestTranscriptRequest.cs:65` `RegularExpression` attribute.
  **Not yet adopted** by astramem-local's own
  `src/server/routes/ingest.ts` (`wire_version` Zod `.regex()`), which still
  uses the older, looser pattern (`^v(?:0|[1-9][0-9]*)\.[0-9]+$`, permits a
  leading-zero minor) — adopting this constant there is a follow-up.
- **`WIRE_VERSIONS_SUPPORTED`** — the domain@gen vocabulary
  (`['atom@1', 'atom@2', 'retrieval@1', 'sync@1', 'capture@1']`) this package's
  schemas correspond to. `atom@2`'s addition here is package-level bookkeeping
  only — `src/server/lib/wire-meta.ts`'s hand-mirrored `WIRE_VERSIONS_SUPPORTED`
  (derived from `SCHEMA_FILE_TO_DOMAIN`, for the same `rootDir` reason
  described under [MCP tool-name manifest](#mcp-tool-name-manifest-u5) below)
  is scoped to `*.v1.schema.json` files only and is therefore untouched by
  this addition; wiring the daemon/cloud reader to actually accept `atom@2` on
  the wire is separate follow-up work (see "Memory atom v2" below). This is a
  separate axis from the capture protocol's per-request `wire_version` field
  above — don't conflate the two.
- **`SYNC_PROTOCOL`** (`'astramem-sync@1'`) — mirrors `SYNC_PROTOCOL` in
  `src/sync/shipper.ts`.
- **`ENTITY_KINDS`** (12 values: `actor, team, org, project, product,
  workitem, decision, tech, tool, concept, event, other`) and **`ACTOR_KINDS`**
  (`['actor', 'team', 'org']`, the subset for which `entities[].subtype` is a
  meaningful refinement) — the canonical entity-kind registry `atom.v2.schema.json`
  `entities[].kind` enforces. Kept in sync with the schema by
  `tests/contracts/entity-kind-parity.test.ts`. See "Memory atom v2" below.

Like the Zod barrel, this is a TypeScript-consumer convenience — cloud
(.NET) has its own literal constants and doesn't consume this file.

## Memory atom `type` registry (U4, ADR D4)

`atom.v1.schema.json`'s `type` enum is the canonical, cross-repo vocabulary
for memory atoms — 10 values, ratified in the U4 contract-unification wave
(ADR D4) as the union of astramem-local's original 7 and cloud's 3:

| Type          | Ships from                         | Notes                                                                 |
|---------------|-------------------------------------|------------------------------------------------------------------------|
| `decision`    | local (+ cloud consumes via sync)   | Architectural/design choice.                                          |
| `fact`        | local (+ cloud consumes via sync)   | Objective project fact.                                               |
| `lesson`      | local (+ cloud consumes via sync)   | Learning from failure/surprise.                                       |
| `command`     | local (+ cloud consumes via sync)   | Useful shell incantation.                                             |
| `todo`        | local (+ cloud consumes via sync)   | Pending work item.                                                    |
| `note`        | local (+ cloud consumes via sync)   | Freeform observation not fitting other types.                        |
| `event`       | local (+ cloud consumes via sync)   | Something that happened at a point in time.                          |
| `preference`  | cloud only (today)                  | User/agent preference atom. Local has no writer yet.                 |
| `task_result` | cloud only (today)                  | Outcome of a completed task. Local has no writer yet.                 |
| `summary`     | cloud only (today)                  | Session/thread summary atom. Local has no writer yet.                |

Local's own writer-facing surfaces (the extraction LLM prompt
`src/distill/prompts/extract.ts`, the ADR-008 `events`-kind request schemas
in `src/server/routes/ingest.ts` / `src/pipeline/handlers/distill-events.ts`,
and the `memories.type` SQLite `CHECK` constraint) are **deliberately left at
the original 7** by this change — astramem-local does not yet produce
`preference`/`task_result`/`summary` atoms anywhere, so widening those
writer-side surfaces (and the DB `CHECK`) is a separate follow-up, not part
of authoring the shared contract vocabulary. `src/contracts/memory.ts`'s
`MEMORY_TYPES`/`MemoryType` (the daemon's in-process type union, used by
read paths like search/sync/eval) IS reconciled to the full 10 here, since
those paths must be able to represent an atom of any canonical type (e.g. one
pulled from cloud via `src/sync/puller.ts`) even before local gains its own
writer for it.

## Memory atom v2 (atom@2 breaking cut, 2026-07-09)

`atom.v2.schema.json` is the first `@2` bump under the "Versioning rules"
below — a deliberate, zero-customers-only breaking cut across three warts
identified in `atom.v1.schema.json`, done in one window rather than three
separate additive-then-deprecate cycles. Full rationale: ADR-001 amendment
(`docs/adr/ADR-001-canonical-memory-atom.md`).

`atom.v1.schema.json` is **not deleted or modified** by this change — it
still validates `'personal'`-scoped, `repo`-carrying, flat-`entities: string[]`
atoms exactly as before, so existing atom@1 producers/consumers are
unaffected until they explicitly migrate. The two schemas are shipped
side-by-side for a **cloud-reader dual-accept window**: cloud accepts both
`atom@1` and `atom@2` on ingest during rollout (reusing the `content ?? text`
fallback idiom from #618), astramem-local's writer + offline sync queue
migrate to `atom@2`, then a follow-up chore commit removes the `atom@1`
fallback and flips `/sync/capabilities` to `atom@2`-only. None of that
daemon/cloud wiring is part of this package-only change — see the plan doc
referenced in the ADR-001 amendment for the cutover task breakdown.

The three breaking changes, all scoped to `atom.v2.schema.json` only (except
where noted):

1. **`entities` is now a typed object array**, not `string[]`:
   `[{ name: string(1..256), kind: <12-value enum>, subtype?: "human"|"ai" }]`.
   The flat string shape was lossy in practice — astramem-local's own
   `harness.ts:137` already re-synthesizes a fake kind for every entity
   string it reads back, which is the concrete evidence that downstream
   consumers need `kind`, not just a name. The 12-value `kind` registry
   (`actor, team, org, project, product, workitem, decision, tech, tool,
   concept, event, other`) and the `actor, team, org` subset for which
   `subtype` (`human`/`ai`) is meaningful are exported from `wire.ts` as
   `ENTITY_KINDS`/`ACTOR_KINDS` (see "Wire-protocol constants" above).
   `actor` covers both humans and AI agents — there is no separate
   person/agent kind. `repo` was deliberately cut as an entity *kind*: a
   repo/project identity is owned by the structural `provenance.project`
   field (point 2 below), and cross-repo mentions land in `product` instead.
2. **`provenance.repo` is deleted.** `provenance.project` is the single
   canonical field going forward — cloud already collapses `project_id ??
   repo` onto one `WorkspaceProjectId` column, so a still-populated `repo`
   value under atom@1 could silently diverge from what cloud actually keys
   on. Writers that only ever had a repo value should send it as `project`.
   `retrieval-query.v1.schema.json`'s `filters.repo` is dropped in the same
   cut (see its own changelog entry below) — that file stays `v1` (no
   `retrieval@2`) because, unlike the sync-envelope wire, retrieval is a
   synchronous request/response surface with no durable offline queue
   forcing a dual-accept window; the four named `repo`→`project` consumer
   call sites are daemon-side follow-up work, not part of this package.
3. **The `'personal'` scope alias is dropped.** `atom.v1.schema.json` kept
   `'personal'` as a one-release dual-read accommodation for the
   `personal`→`private` rename (U7-local astramem-local#110, DEC-048),
   tracked as `TODO(remove-personal-alias)` (astramem-local#115) — this is
   the release that removes it. `atom.v2.schema.json`'s `scope` enum is
   `private | team | org` only. `retrieval-query.v1.schema.json`'s
   `filters.scope` and `retrieval-result.v1.schema.json`'s `hits[].scope`
   drop `'personal'` in the same cut (both stay `v1` — same reasoning as
   point 2: synchronous surfaces, no offline-queue dual-accept need).

**Also bundled in this release, additive (no version bump needed on their
own schema)**: `retrieval-result.v1.schema.json`'s `hits[].type` enum widens
from the original 7 values to the full canonical 10 (adds `preference`,
`task_result`, `summary`) — cloud already returns these types, so a
conformant hit from a real cloud response used to fail this schema. Per the
"Memory atom `type` registry" section above, widening an already-open
registry enum is additive, not breaking.

### atom@2 additive extension — transcript speaker/segment provenance (FEAT-496, 2026-07-14)

Same `atom.v2.schema.json` file, no version bump — new optional fields only,
per the "Additive change" rule below. Motivated by FEAT-491 (meeting-caption
capture) and cloud's WS-B/FEAT-516, both of which need per-evidence speaker
identity and timing to reach stored atom provenance, not just the wire.

- **`evidence[].speaker_label`** (optional string) and
  **`evidence[].segment_start_ms`** (optional non-negative integer) — added
  to the structured-receipt branch of `evidence`'s `anyOf` (the
  `{ transcript_id, span }` object shape). `speaker_label` is a display
  name/label as surfaced by a diarized or caption-labeled source (e.g.
  "Alice", "Speaker 2"). `segment_start_ms` is a millisecond offset into the
  source recording/transcript, complementing `span` (a character offset into
  the transcript *text*, not a time offset) — the two are independent axes
  and a source may populate either, both, or neither.
- **`provenance.worker` / `provenance.model` / `provenance.attestation`**
  (all optional, nullable strings) — the Screenpipe-inspired provenance
  triple, reserved now because `provenance` has `additionalProperties: false`
  (line 68) and every field needs an explicit schema edit; reserving the slot
  in this pass is nearly free and avoids a second breaking-adjacent PR later.
  **None of these three are written by any producer yet** — this is a
  forward-reserve, not a shipped capability. `worker` names the compute tier
  that ran extraction (e.g. `local-cpu`/`local-gpu`/`cloud-worker`); `model`
  is `name@version` of the underlying LLM/ASR model (distinct from
  `provenance.extractor`, which names the *pipeline*, not the model);
  `attestation` is an opaque signature/hash for future tamper-evidence use.
  No enum on any of the three — freeform strings, since the value sets don't
  exist yet.
- **`provenance.consent_disclosed`** (optional, nullable boolean; ADR-017
  decision 6) — whether the operator disclosure/opt-in required for capturing
  a non-user speaker (audio FEAT-489, meeting captions FEAT-491) was
  satisfied at capture time. Tri-state semantics: `null`/absent = not
  applicable or not recorded (e.g. atoms with no non-user speaker involved);
  `true`/`false` = an explicit disclosure determination was made. Scoped onto
  atom@2 provenance deliberately (ADR-017) so consent provenance has ONE
  schema-change surface instead of being duplicated per capture source.
  Server-side enforcement policy (hard-reject on missing/false at ingest) is
  FEAT-489/491 daemon-side work, not part of this contract.

**Deliberately NOT added here: `platform` / `meeting_id`.** FEAT-491's
meeting-caption capture source needs these, but they describe the *capture
session* (which meeting, which platform), not a single evidence span or a
single atom's provenance — many atoms can be distilled from one captured
session. They belong on `capture-envelope.v1.schema.json` (FEAT-491's own
schema widen: `capture_source` enum + envelope fields), and flow into stored
atoms via the existing `provenance.session_id` correlation, the same way
`session_id` already bridges capture envelope and atom today. Coordinated
with FEAT-491 so its speaker labels land in `evidence[].speaker_label`
above rather than a competing shape.

Fixtures: `atom-v2-speaker-segment-evidence.json` (valid, exercises both new
evidence fields) and `atom-v2-provenance-triple.json` (valid, exercises the
reserved provenance triple plus `consent_disclosed: true`) added under
`fixtures/valid/`.

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

## Publishing

`.github/workflows/contracts-publish.yml` publishes `@astragenie/astramem-contracts`
to GitHub Packages (`npm.pkg.github.com`) on push of a `contracts-v*` tag
(NOT the root package's `v*` tag — the two packages release independently;
see "Versioning" below for why). The workflow:

1. Asserts the tag suffix matches `contracts/package.json` version (same
   parity gate pattern as `version-tag-parity.yml`, scoped to this package).
2. Regenerates `types/` + `zod/` from `schemas/` and fails the job if that
   produces a diff — the checked-in generated output must already match
   what's published (prevents publishing stale generated code).
3. Publishes with the ambient Actions `GITHUB_TOKEN` (`packages: write`
   permission) — this is CI-to-same-org publish, not the classic-PAT path.

Cutting a release: bump `contracts/package.json` version, land that on
`main`, then push tag `contracts-vX.Y.Z` pointing at that commit.

**Consuming the published package** (plugin repo CI, or any local install)
needs read access to GitHub Packages, which — unlike consuming a public
npmjs.org package — always requires an authenticated request. Configure:

```
# ~/.npmrc or repo .npmrc
@astragenie:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

with `NODE_AUTH_TOKEN` set to a classic PAT (`ghp_...`, `read:packages` scope
— `gho_` OAuth tokens from `gh auth login` are rejected, see
`github-packages-auth.md`). Whether the consuming repo's own CI can instead
rely on its ambient `GITHUB_TOKEN` for a same-org cross-repo package read
was **not verified live** in this change — treat that as open until checked
against this org's GitHub Packages visibility settings.

## Cloud + plugin consumption (what task 3b/3c needs)

The cloud (.NET) repo's CI needs:

1. **The files**: either (a) a git submodule / subtree pointing at this
   repo's `contracts/` directory, or (b) an npm-side artifact download of
   `@astragenie/astramem-contracts` via GitHub Packages once a
   `contracts-v*` tag has been published (see "Publishing" above). Cloud
   only needs the JSON Schemas + fixtures (not the TS types/Zod), so a thin
   fetch-and-unpack step (`npm pack` + extract, or a raw GH Packages tarball
   download) is enough — cloud CI does not need a Node toolchain otherwise.
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

## MCP tool-name manifest (U5)

`manifests/mcp-tools.v1.json` is the canonical, cross-repo source of truth
for the MCP `verb_noun` tool-name vocabulary — astragenie/memory#671 (U5)
needs both MCP servers (this daemon + the cloud .NET server) to expose the
identical tool-name surface so `astramem-plugin`'s providers can call one
contract regardless of which backend answers.

Shape:

```json
{
  "version": "1",
  "tools": [
    { "name": "search_memory", "owner": "local", "description": "...", "status": "stable" }
  ]
}
```

Fields:

- `name` — the wire-level MCP tool name (`verb_noun`).
- `owner` — `local` | `cloud` | `both`, mirroring the "ships from" convention
  in the [memory atom `type` registry](#memory-atom-type-registry-u4-adr-d4)
  above. astramem-local's own SLICE-A only lists tools it registers today
  (`owner: "local"`) — cloud-owned rows are added once the cloud-side
  manifest draft exists, so this file never drifts ahead of what's actually
  registered on either side.
- `description` — short, human-facing summary. **Not** required to
  byte-match the MCP server's own `description` string passed to
  `registerTool()` — this manifest pins names + ownership, not full
  per-tool schema parity (see "Scope" below).
- `status` — `stable` | `planned` | `deprecated`, reserved for a future
  dual-name migration window (mirrors the wire-version dual-read convention
  above).

**Scope**: this manifest intentionally does NOT carry a JSON-Schema-per-tool
input contract. Each server's own `inputSchema` (zod locally, its .NET
equivalent in cloud) remains the authoritative validator for tool arguments —
widening this manifest to full input/output schemas was considered and
rejected as out of scope for #671, whose actual ask is name parity (client
rename-risk), not input-shape parity (already covered per-tool elsewhere).

**Naming decision (SLICE-A)**: all 15 tools astramem-local registers today
(`src/mcp/server.ts`) are already `verb_noun` or verb-only where the noun is
implicit/global, with two names that read noun-noun (`session_digest`,
`memory_history`) and one bare verb (`remember`). SLICE-A ships these
**as-is** — `remember` stays as-is (a `remember_memory`/`create_memory`
rename was considered and rejected: `remember` is the daemon's most-used
tool and a rename carries real client-config blast radius for no vocabulary
gain). Whether `session_digest`/`memory_history` need a `get_`-prefixed
rename to strictly match `verb_noun` (mirroring `get_health`'s shape) is
deferred to a coordinated SLICE-B, gated on the cross-repo #671 naming call
— this manifest is additive-only and renames nothing.

**Naming decision (SLICE-B, U5, astragenie/astramem-local#120)**: the
cross-repo call landed as follows:

- **`memory_history`** — grandfathered exact-match noun_verb name on both
  backends (cloud adopted local's name rather than renaming to
  `get_memory_history` — see the shipped `src/AstraMemory.Mcp/canonical-tool-manifest.json`
  in the cloud repo). Not renamed here either.
- **`session_digest`** — also grandfathered, **not** renamed to
  `get_session_digest`. Unlike `memory_history`, cloud has no MCP tool with
  this name at all, so there is no cross-repo naming collision forcing a
  decision — renaming a local-only tool for `verb_noun` purity alone, with
  no unification benefit, was judged not worth the alias-churn cost. Follows
  the same grandfather precedent set for `memory_history`.
- **`mark_memory_used` → `submit_feedback`** — this *is* a real cross-repo
  collision (two different signal types under two different names: local's
  ADR-010 implicit "recall was used" vs. cloud's explicit +1/-1 score) and
  is collapsed onto cloud's `submit_feedback` wire name. `mark_memory_used`
  is retained as a one-release **deprecated** alias (same handler) rather
  than a clean break, since D2's "no alias needed" reasoning was written
  for tools nobody calls yet — `mark_memory_used` predates U5 and may
  already have callers.
- This adds the 18 cloud-only tools (`owner: "cloud"`) from the actual
  shipped cloud manifest, giving 34 total entries (16 `local`/`both` +
  18 `cloud`). `get_health` stays `owner: "local"` — cloud exposes an
  equivalent only as a REST `/health` endpoint, not an MCP tool, per the
  cloud manifest's own notes.

Parity is enforced locally by
`tests/contracts/mcp-tool-manifest-parity.test.ts`, which builds the real
`McpServer` (mock deps, no live Ollama/network) and asserts its registered
tool names equal this manifest's `owner: "local"`/`"both"` entries exactly
— same "readdirSync/JSON.parse at test time, no `src/` import" shape as
[`tests/contracts/wire-version-map-parity.test.ts`](../tests/contracts/wire-version-map-parity.test.ts),
required because `tsconfig.json` scopes `rootDir` to `src/` (TS6059 blocks
`src/` from importing `contracts/`, but nothing stops `tests/` reading it).
Cloud's half (asserting its own registered names against this same file)
and the plugin's half (asserting provider tool-call names against it) are
out of this repo's build.

## Versioning: package semver vs. wire_version (two separate axes)

These are deliberately decoupled and must not be conflated:

- **`contracts/package.json` version** (npm semver, e.g. `1.3.0`) tracks
  changes to the *package artifact*: new fixtures, regenerated types/Zod,
  README updates, tooling changes, additive schema fields. It bumps on every
  `contracts-v*` release regardless of whether any wire-visible shape
  changed.
- **`wire_version`** (the field embedded inside envelopes, e.g.
  `capture-envelope.v1.schema.json`'s `wire_version`, and the `v1` suffix in
  schema `$id`/filenames like `atom.v1.schema.json`) is the *protocol*
  version — it only changes on a breaking change to the wire shape itself,
  and a bump requires the dual-read migration window described above,
  coordinated across all three consuming repos.

Consequence: a package version bump (e.g. `1.0.0` -> `1.1.0`) does **not**
imply a `wire_version` bump, and is safe for consumers to pick up without a
protocol migration. A `wire_version` bump (e.g. introducing `atom.v2`) always
forces at least a package **major** bump, but the reverse is not true — most
package releases will be minor/patch schema-package hygiene, not protocol
changes. CI on the consuming side should gate on `wire_version` compatibility
explicitly (point 4 above), not infer it from the npm package's semver.

## Changelog

- **2.3.0** — `atom.v2.schema.json` additive extension (FEAT-496, 2026-07-14;
  see "atom@2 additive extension" above). New optional fields, no schema
  version bump per the additive-minor rule: `evidence[].speaker_label`,
  `evidence[].segment_start_ms`, the reserved provenance triple
  `provenance.worker`/`model`/`attestation`, and
  `provenance.consent_disclosed` (ADR-017 decision 6 consent provenance).
  New fixtures: `atom-v2-speaker-segment-evidence.json`,
  `atom-v2-provenance-triple.json` (the latter also exercises
  `consent_disclosed: true`).
- **2.1.0** — `atom.v2.schema.json` `entities[]` items gain optional
  `valid_at`/`invalid_at` (both nullable `date-time`, FEAT-453 fact-level
  bitemporal tracking) — additive, in place, no schema major bump per the
  "Versioning rules" below (removes/renames/narrows nothing; every document
  valid under the pre-2.1.0 schema stays valid). New fixtures:
  `atom-v2-entity-validity-window.json` (populated), `atom-v2-entity-
  validity-null.json` (both explicitly `null`, proving the nullable-not-
  just-optional type union), and an `atom-v2-entity-extra-key-rejected.json`
  regression fixture proving `additionalProperties: false` still rejects an
  unrecognized key. See `docs/specs/FEAT-453-bitemporal-design.md` §2 for
  the full rationale (including why this is additive, not a `@3` cut).
- **2.0.0** — `atom.v2.schema.json` added (breaking; `atom.v1.schema.json`
  kept, unmodified, for the dual-read window) — see "Memory atom v2" above
  for the full rationale. Package major bump per the "Versioning rules"
  above: a `wire_version` bump always forces at least a package major.
  Summary of the wire-visible changes in this release:
  - `atom.v2.schema.json`: `entities` is now `[{name, kind, subtype?}]`
    instead of `string[]`; `provenance.repo` deleted (`project` is
    canonical); `scope` enum narrowed to `private|team|org` (`'personal'`
    dropped).
  - `retrieval-query.v1.schema.json` (in place, still `v1`): `filters.repo`
    deleted; `filters.scope` narrowed to `private|team|org`.
  - `retrieval-result.v1.schema.json` (in place, still `v1`): `hits[].scope`
    narrowed to `private|team|org`; `hits[].type` widened 7→10 values
    (additive — `preference`, `task_result`, `summary` added).
  - `wire.ts`: `WIRE_VERSIONS_SUPPORTED` gains `'atom@2'` (both `atom@1` and
    `atom@2` listed during the dual-accept window); new `ENTITY_KINDS`
    (12-value registry) and `ACTOR_KINDS` (`actor|team|org`) exports.
  - New fixtures for every change above (typed entities, unknown-kind
    rejection, `repo`/`personal` rejection on the affected schemas, the
    widened `hits[].type` set) plus `tests/contracts/entity-kind-parity.test.ts`.
  - ADR-001 amended in place with the atom@2 decision record.
- **1.3.0** — `wire.ts` hand-written module (`WIRE_VERSION`,
  `WIRE_VERSION_PATTERN`, `WIRE_VERSIONS_SUPPORTED`, `SYNC_PROTOCOL`),
  exported as `@astragenie/astramem-contracts/wire`; see "Wire-protocol
  constants" above. `capture-envelope.v1.schema.json`'s `wire_version`
  pattern **tightened** (M-R7) from `^v(?:0|[1-9][0-9]*)\.[0-9]+$` to
  `^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$` to match cloud's
  `IngestTranscriptRequest.cs:65` — a `"v1.01"`-style leading-zero minor
  component is now rejected. Types/Zod regenerated for the schema change;
  added `fixtures/invalid/capture-envelope-v1-wire-version-leading-zero-minor.json`
  to cover it. Additive/tightening-only for a field that was already
  required — no schema major bump. Not yet adopted by
  `src/server/routes/ingest.ts` (still the looser pattern) — daemon-side
  and cloud-side adoption of `WIRE_VERSION_PATTERN` are follow-ups, out of
  scope for this package-only change.
- **1.2.0** — `manifests/mcp-tools.v1.json` MCP tool-name manifest (U5-local
  SLICE-A/B); see "MCP tool-name manifest" above.
