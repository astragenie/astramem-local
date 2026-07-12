# FEAT-453: Fact-Level Valid-Time Tracking on Entity Links — Design Spike

> **Title corrected 2026-07-12** (originally "Fact-Level Bitemporal Tracking"). What this FEAT
> designs, and what shipped in v0.12.0, is **valid-time tracking only** — there is no queryable
> transaction-time axis anywhere in this system ("what did we believe before a correction"). A
> genuine bitemporal model needs both axes; this repo has one. That is a real, useful feature —
> it is just not the feature the original title named. Operator decision (2026-07-12): correct
> the label, do not build the missing transaction-time axis (no evidence of demand for it). Full
> reasoning in §9 (status correction) and §10 Q2 (the terminology gap and the decision).

**Status:** proposed
**Date:** 2026-07-09
**Terminology:** valid-time only (label corrected 2026-07-12 — see note above and §10 Q2)
**Origin:** `.claude/artifacts/loop/backlog/triaged/FEAT-453.md` (architecture-corrected 2026-07-09 —
no `atoms` table, `entities` is a global dedup registry, migration target is `memory_entities`,
migration number is **023** — 022 is taken by `022-consolidation-proposal-metadata.sql`, shipped
v0.11.0).

## 0. Framing

Memory-level valid-time tracking already ships: `memories.valid_from`/`valid_to`
(`migrations/006-atom-v3.sql:20-21`), `validityFilterClause` (`src/search/search.ts:190-208`),
`preset=temporal` (`src/search/presets.ts`), and the window is already on the atom@2 wire
(`contracts/schemas/atom.v2.schema.json:83-92`). This FEAT adds one level finer: a single memory
can name several entities, and the memory's relationship to any one of them can have its own
validity window — "memory M says Alice was the approver Jan–Mar, then a later correction narrows
that" — without invalidating or superseding the whole memory.

The natural home for that window is `memory_entities` (`migrations/012-entities.sql:24-28`), the
memory↔entity link table. `entities` itself is a deduplicated global registry (one row per
canonical name across the whole corpus) and cannot carry a window — the same entity is linked from
many memories with different windows. This is the correction the original FEAT body missed.

Three open design decisions, settled below:

1. **DDL** — exact migration 023 shape, including the surrogate-PK rebuild `memory_entities`
   needs before it can carry its own columns.
2. **Contract** — how `valid_at`/`invalid_at` reach the wire given atom@2's `entities[]` items are
   `additionalProperties: false`.
3. **Query composition** — how a fact-level `as_of` composes with the existing memory-level
   `validityFilterClause`.

Scope is **local + cloud + shared contract**, per the FEAT's 3-slice cut. No graph engine (§7).

---

## 1. Decision: migration 023 DDL

### 1.1 Why a rebuild, not `ALTER TABLE ADD COLUMN`

`memory_entities`'s current PK is the composite natural key `(memory_id, entity_id)`
(`migrations/012-entities.sql:24-28`). Fact-level validity means the **same** `(memory_id,
entity_id)` pair can legitimately have more than one row over time (a stated correction opens a
second window for the same link) — the composite PK forbids exactly that. SQLite has no `ALTER
TABLE` that swaps a PK or converts a composite natural key to a surrogate one in place, so this
needs the same create-copy-swap rebuild pattern already used three times in this repo
(`migrations/003-expand-memory-types.sql`, `013-archival.sql`, `017-widen-memory-types.sql`,
`021-unsupersede-event-type.sql`).

`memory_entities` is a **leaf** table — nothing holds `... REFERENCES memory_entities(...)` — so,
unlike migration 017's `memories` rebuild, there is no FK-cascade-on-DROP hazard to back up around.
The rebuild is the same shape as migration 021's (single-table, no dependents).

### 1.2 Exact SQL

```sql
-- 023: fact-level bitemporal validity on memory_entities (FEAT-453 slice 2).
--
-- memory_entities needs a surrogate PK before it can carry a validity window
-- of its own: the existing PK is the composite natural key (memory_id,
-- entity_id) (012-entities.sql), which means "the same fact link reasserted
-- with a different validity window" has nowhere to live as a second row.
-- SQLite has no ALTER TABLE that swaps a PK or converts a composite PK to a
-- surrogate one in place, so this is the same create-copy-swap table-rebuild
-- pattern migrations 013/017/021 already established. memory_entities is a
-- leaf table (nothing holds `REFERENCES memory_entities(...)`), so — unlike
-- migration 017's memories rebuild — there is no FK-cascade-on-DROP hazard
-- to back child rows up around; this is the simpler, migration-021-shaped
-- rebuild.
--
-- valid_at / invalid_at: bitemporal valid-time window for ONE fact link (one
-- memory_id/entity_id association at a point in time), distinct from:
--   - memories.valid_from/valid_to (006) — the MEMORY-level window. A fact
--     link's effective window is always clipped to fall inside its parent
--     memory's window at query time (never wider) — see
--     docs/specs/FEAT-453-bitemporal-design.md §3 for the exact clip.
--   - memory_events.created_at / memories.captured_at — ingest-time
--     bookkeeping, not valid-time.
-- Both nullable, and NEITHER is backfilled for pre-existing rows (unlike
-- migration 006's valid_from backfill): NULL valid_at means "no stated
-- fact-level start" and resolves to the parent memory's own valid_from AT
-- QUERY TIME (§3), not a value copied into the row — so a later correction
-- to the memory's own valid_from doesn't require rewriting every linked
-- fact row. NULL invalid_at means "not known to have stopped being true"
-- (same half-open-interval convention as memories.valid_to). Backfilling
-- either column here would be redundant work producing byte-identical
-- query-time behavior to leaving them NULL.
--
-- UNIQUE(memory_id, entity_id) is deliberately NOT re-added as a constraint:
-- unlike the old composite PK, a memory MAY now carry multiple fact-link
-- rows for the same (memory_id, entity_id) pair with different validity
-- windows (e.g. "Alice was the approver Jan-Mar" then a second row "Alice
-- was the approver Apr-" after a stated correction) — that plurality is the
-- entire point of this migration. Overlapping-window hygiene for the same
-- pair is an application-level invariant (EntityRepo.linkWithValidity's
-- caller controls the window), not a DB constraint — see §1.4 for the
-- partial-unique index that DOES still enforce "at most one currently-open
-- window per pair."
--
-- Zero interaction with vec0 tables: memory_entities has never been part of
-- the memories_vec schema and this migration adds no vec0 table, touches no
-- FLOAT[N] column, and does not go through getVecSchemaDim()/
-- DEFAULT_EMBED_DIM (CLAUDE.md "Do NOT" section).
--
-- migrate.ts wraps each migration in db.transaction() — no explicit
-- BEGIN/COMMIT here.

CREATE TABLE memory_entities_new (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  valid_at INTEGER,
  invalid_at INTEGER
);

-- Explicit column list + synthesized UUIDv4-shaped id per row (same
-- randomblob idiom migration 010 used to backfill memory_events.event_id) —
-- every pre-existing link becomes exactly one row with valid_at/invalid_at
-- both NULL (no stated window yet, falls back to the parent memory's own
-- valid_from per §3 until a distill run or explicit correction sets one).
INSERT INTO memory_entities_new (id, memory_id, entity_id, valid_at, invalid_at)
SELECT
  lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) ||
    substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  ),
  memory_id, entity_id, NULL, NULL
FROM memory_entities;

DROP INDEX IF EXISTS idx_memory_entities_entity;
DROP TABLE memory_entities;
ALTER TABLE memory_entities_new RENAME TO memory_entities;

-- 1.3: lookups this feature and the pre-existing entity surfaces need.
CREATE INDEX idx_memory_entities_entity ON memory_entities(entity_id);
CREATE INDEX idx_memory_entities_memory ON memory_entities(memory_id);

-- 1.4: "at most one currently-open (invalid_at IS NULL) window per
-- (memory_id, entity_id) pair" — the one invariant worth a DB constraint
-- rather than leaving entirely to the application. A partial unique index
-- (not a full UNIQUE(memory_id, entity_id)) is required specifically
-- because it must NOT reject closed (invalid_at NOT NULL) historical rows
-- for the same pair — those are the whole feature.
CREATE UNIQUE INDEX idx_memory_entities_open_window
  ON memory_entities(memory_id, entity_id)
  WHERE invalid_at IS NULL;
```

### 1.3 `EntityRepo` surface changes (implementation note for slice 2, not part of this spike)

- `link(memoryId, entityId)` → superseded by `linkWithValidity(memoryId, entityId, { validAt?:
  number | null, invalidAt?: number | null })`. Existing callers that don't care about validity
  pass `{}` (both NULL) — byte-identical to today's `INSERT OR IGNORE` **except** it is no longer
  `OR IGNORE` on the composite pair (that constraint is gone); it becomes a plain `INSERT` guarded
  by the partial-unique index in §1.4, so re-linking an already-open pair must go through a
  `closeAndRelink` helper (close the old row's `invalid_at`, insert the new one) rather than
  relying on `INSERT OR IGNORE`'s implicit no-op.
- `unlinkMemory` (supersede's AC-3 cascade, `entities.ts:69-71`) stays a hard `DELETE` — unaffected
  by this migration; deleting all rows for a memory_id is unconditional regardless of how many
  windows exist per pair.

---

## 2. Decision: contract shape — relax atom@2 in place, do NOT cut atom@3

### 2.1 The tension

`atom.v2.schema.json`'s `entities[]` items are `additionalProperties: false`
(`contracts/schemas/atom.v2.schema.json:117-136`) — so are the root object and every nested object
in this schema. That closedness is not new to this change: `entities[].subtype`, the whole
`entities[]` shape, `provenance`, and every other field on atom@2 already required editing this
same schema file in place to be declared. What's new is only that this particular addition is
being asked about explicitly.

Per `contracts/README.md` "Versioning rules": **additive** change (new optional field, new enum
value in an already-open registry) = edited in place, package **minor** bump, no new schema major.
**Breaking** change (remove/rename a required field, narrow a type, remove an enum value) = new
schema major (`@3`), shipped alongside `@2` for a dual-read window. Adding two new **optional**
fields to `entities[]` items removes nothing, renames nothing, and narrows nothing — every
document valid under today's `atom.v2.schema.json` stays valid under the relaxed one. That is
squarely the additive case.

### 2.2 Recommendation: relax `atom.v2.schema.json` in place

Add to `entities[].properties` (`contracts/schemas/atom.v2.schema.json:119-135`):

```json
"valid_at": {
  "type": ["string", "null"],
  "format": "date-time",
  "description": "Bitemporal valid-time start for THIS entity link (fact-level, distinct from the atom's own valid_from). null = no stated fact-level start; resolves to the atom's own valid_from at query time."
},
"invalid_at": {
  "type": ["string", "null"],
  "format": "date-time",
  "description": "Bitemporal valid-time end for THIS entity link. null = not known to have stopped being true."
}
```

Both optional (not added to `entities[].required`, which stays `["name", "kind"]`). Package bump:
`contracts/package.json` minor (e.g. `2.0.0` → `2.1.0`) — mirrors the 1.3.0 changelog entry's
"additive/tightening-only... no schema major bump" precedent.

**Do not cut atom@3.** A new major drags in the full dual-read-window ceremony (freeze `@2`
forever unmodified, ship `@3` side by side, three-way dual-accept on cloud's reader, a follow-up
chore to retire `@2`) — proportionate for the three atom@2 warts (lossy flat entities, a
`repo`/`project` split-brain field, a scope-alias cleanup), disproportionate for two nullable
fields nobody is required to populate. It would also land a third atom major while atom@1→atom@2's
own dual-accept window (README §"Memory atom v2") is still open on cloud — compounding, not
reducing, the number of schema generations every consumer has to reason about at once.

Guard the atom-kind parity gate: `tests/contracts/entity-kind-parity.test.ts` and the
filename-prefix fixture-routing convention are untouched (the `kind` enum doesn't change). Add:

- `fixtures/valid/atom-v2-entity-validity-window.json` — an entity with `valid_at`+`invalid_at`
  populated.
- `fixtures/valid/atom-v2-entity-validity-null.json` — an entity with both explicitly `null` (not
  omitted — proves the nullable-not-just-optional type union).
- A regression fixture in `fixtures/invalid/` asserting an entities[] item with an unrecognized
  **third** key is still rejected — proves `additionalProperties: false` still does its job after
  the edit, i.e. this really is "two named fields added," not "the object opened up."

Regenerate `types/atom.v2.d.ts` and `zod/atom.v2.ts` (`generate-types.mjs` / `generate-zod.mjs`,
no conditionals on this schema per the README's Zod-lossy caveat list, so both generate faithfully)
as part of the same slice-2 commit that lands the schema edit — CI's `contracts:generate`
zero-diff gate will otherwise fail on stale generated output.

### 2.3 Where the fields live: inline on `entities[]` items, not a parallel list

Rejected alternative: a parallel top-level `entity_validity: [{ name, kind, valid_at, invalid_at
}]` array, correlated to `entities[]` by name+kind or by array index. Rejected because:

- **Inline is the established idiom.** `subtype` was added to `entities[]` items exactly this way,
  not as a parallel `entity_subtypes` list — a second parallel array here would be the first
  departure from that pattern for no structural reason.
- **Correlation-by-index is fragile** if either array is ever reordered independently, and
  correlation-by-(name,kind) is ambiguous the instant an atom names the same entity twice with two
  different roles in one text (rare, not impossible). Inlining sidesteps the correlation problem
  entirely — the window travels with the entity mention that has it.
- A parallel list only pays for itself when most consumers don't want the extra fields and closed
  objects make optional fields expensive to add — but per §2.2 that "expensive" premise is false
  here (it's a normal in-place additive edit), so there's no cost to amortize away.

### 2.4 SaaS/cloud consumer note (from `contracts/README.md`, no sibling-repo read needed)

Per README "Cloud + plugin consumption": cloud's CI pulls a **pinned** copy of
`contracts/schemas/*.json` (git submodule/subtree, or an npm artifact at a `contracts-v*` tag) —
it does not read this repo's `contracts/` live. That means the real compatibility risk here isn't
schema-major-vs-minor, it's **deployment lag**: until cloud bumps its pinned contracts version,
any atom that actually populates `valid_at`/`invalid_at` will be rejected by cloud's
still-`additionalProperties:false`, still-stale copy of the schema — same lag risk every additive
change to a closed schema already carries (see `wire.ts`'s own `WIRE_VERSION_PATTERN` tightening
note: "daemon-side and cloud-side adoption... are follow-ups"). This is a **sequencing** problem,
not a **versioning** problem, and the slice cut in §5 sequences around it: slice 2 (local) can
write `valid_at`/`invalid_at` into local SQLite and even distill-extract them without touching the
wire at all — `src/contracts/atom-wire.ts`'s `toAtomWireV1` mapper today still emits `entities: []`
unconditionally (an atom@2 writer cutover for this mapper hasn't landed yet, independent of this
FEAT) — so there is no live wire path that ships these fields until an atom@2 writer exists AND
cloud has pulled the relaxed schema. Slice 3 lands the cloud EF migration + contract pull first;
wiring the local shipper to actually populate the fields on outgoing sync payloads is gated on
slice 3 shipping, mirroring the FEAT body's own "soft sequencing constraint" note about FEAT-456.

---

## 3. Decision: query composition semantics

Fact-level `as_of` is a **projection/join concern layered on the existing memory-level filter**,
never a second independent `AND` bolted onto `validityFilterClause`. Two distinct composition
points, not one:

### 3.1 Effective fact-link window (the one clip rule everything else uses)

A fact link's effective window is **always clipped to fall inside its parent memory's own
window** — narrower wins, and the clip happens **at query time**, not by mutating
`memory_entities` rows when the parent memory's lifecycle changes:

```
effective_start = MAX(COALESCE(me.valid_at, m.valid_from), m.valid_from)
effective_end   = MIN(COALESCE(me.invalid_at, +inf), COALESCE(m.valid_to, +inf))
```

In SQLite (`+inf` as an out-of-range epoch-ms sentinel, e.g. `9223372036854775807`):

```sql
MAX(COALESCE(me.valid_at, m.valid_from), m.valid_from) <= :asOf
  AND MIN(COALESCE(me.invalid_at, 9223372036854775807),
          COALESCE(m.valid_to, 9223372036854775807)) > :asOf
```

Why query-time clipping instead of a lifecycle-time cascade: `supersede()` already hard-`DELETE`s
a memory's `memory_entities` rows (`entities.ts` AC-3 cascade, `memory-events.ts:242-244`) — a
stronger clip than capping `invalid_at` would be, so superseded memories need no new handling.
`invalidate()` (`memory-events.ts:162-184`) does **not** delete or cap `memory_entities` rows
today, which could otherwise leave a fact-link window open past its memory's own `valid_to`. The
`MIN(..., m.valid_to)` clip in `effective_end` closes that gap **without** requiring `invalidate()`
to learn about `memory_entities` at all — the effective window is capped at query time regardless
of whether the row itself was ever mutated. This is the concrete answer to "what happens when
memory-level and fact-level windows conflict": the narrower one always wins, computed on read.

### 3.2 Composition point A — `preset=temporal` / `filters.as_of` alone (no entity filter)

Memory **selection** is unchanged: `validityFilterClause(asOf)` against `memories.valid_from`/
`valid_to` (`search.ts:190-208`) decides which memories are in the result set, exactly as today.
Fact-level validity only affects **projection** — if/when a caller asks for a memory's entity
annotations (e.g. a future `GET /memories/:id` detail view, or `EntityRepo.listForMemory`), those
annotations are filtered to links whose *effective* window (§3.1) covers `T`. It never adds or
removes a memory from search results.

### 3.3 Composition point B — `filters.entity` + `filters.as_of` together

This is the case that changes memory **selection**, and is the actual value proposition of
fact-level tracking. Today, `entity=` resolves to entity ids and intersects via
`EntityRepo.memoryIdsForEntities` (`entities.ts:146-153`) — an all-time "ever linked" set, no
window. This FEAT adds a time-aware sibling:

```ts
memoryIdsForEntitiesAsOf(entityIds: string[], asOf: number): Set<string>
```

joining `memory_entities` → `memories` and applying the §3.1 clip. A memory qualifies **only if
both** hold: (i) it independently passes the ordinary memory-level `validityFilterClause(asOf)`
(a fact link on an otherwise-invalidated/superseded memory must not resurrect it as a search hit),
**and** (ii) it has a `memory_entities` row for a resolved entity id whose effective window (§3.1)
covers `T`. Note (ii)'s clip already subsumes (i) for the specific matched entity (because
`effective_end` is `MIN`-clipped against `m.valid_to`) — (i) still matters for *other* memories in
the surrounding search/recall path that don't carry this entity at all, so both checks are kept
explicit rather than relying on the subsumption as the only guard.

### 3.4 Worked examples

**Example 1 — plain temporal, no entity filter (projection only).**
Memory `M1` ("Alice approved the PR"), `valid_from=Jan1`, `valid_to=NULL` (still current as a
memory). Its `alice` link: `valid_at=Jan1`, `invalid_at=Mar1` (the approval role ended Mar1, stated
in a later distill run, without invalidating the whole memory — other facts in `M1` are still
true).
- `preset=temporal&as_of=2026-02-01` (no `entity=`): `M1` passes the unchanged memory-level filter
  (`Jan1 <= Feb1 < NULL`) → **returned**, same as pre-FEAT-453 behavior.
- `preset=temporal&as_of=2026-04-01`: `M1` **still returned** (memory-level filter is untouched by
  fact-level windows) — but if the caller also asks for `M1`'s entity annotations at that instant,
  `alice` is **excluded** from the annotation list (`Apr1 > Mar1`). The search hit is unaffected;
  only entity metadata display differs.

**Example 2 — entity + temporal (selection narrowing).**
Same `M1`. `filters.entity=alice&filters.as_of=2026-02-01`:
`memoryIdsForEntitiesAsOf(['alice-id'], Feb1)` includes `M1` (`Jan1 <= Feb1 < Mar1`) → `M1`
**is** in results.
`filters.entity=alice&filters.as_of=2026-04-01`:
`memoryIdsForEntitiesAsOf(['alice-id'], Apr1)` does **not** include `M1` (`Apr1 >= Mar1`) → `M1`
is **excluded**, even though `M1` is still a "currently valid" memory in the broader sense. This is
the entire point of fact-level tracking: the memory survives, but stops counting as evidence for
"alice, as of April."

**Example 3 — no stated hint, fallback, and the invalidate() gap.**
Memory `M2` (`valid_from=Mar1`, created with an entity mention of `bob` but no stated validity
hint — extraction found no date in the source text), so its link row is `valid_at=NULL,
invalid_at=NULL`. Per §3.1, effective window = `[MAX(M2.valid_from, M2.valid_from),
MIN(+inf, COALESCE(M2.valid_to, +inf))]` = `[Mar1, M2.valid_to-or-open]` — the memory's own window,
exactly the "fallback = memory's own valid_from" rule from §4. If `M2` is later `invalidate()`d at
`Jun1` (setting `M2.valid_to=Jun1`, **not** deleting the `bob` link row — `invalidate()` has no
`memory_entities` cascade, unlike `supersede()`), a query for `entity=bob&as_of=2026-08-01` still
correctly **excludes** `M2`: `effective_end = MIN(+inf, Jun1) = Jun1 <= Aug1`. No lifecycle-code
change to `invalidate()` was needed — the query-time clip in §3.1 already closes the gap.

---

## 4. Distill validity-hint extraction

Incremental prompt extension, not a new pipeline stage — `src/distill/prompts/extract.ts` already
emits the full `entities[]` shape (`name`, `kind`, `subtype`) as part of the **same** LLM call that
produces the atom (`migrations/012-entities.sql` doc comment: "written by the distill-time
embed-index stage, same LLM call as atom extraction"). Add two more optional keys to the per-entity
JSON instructions the model is asked to emit:

```
"entities": [{ "name": "...", "kind": "...", "subtype": "...",
               "valid_at": "<ISO-8601 date-time, only if the source text states one>",
               "invalid_at": "<ISO-8601 date-time, only if the source text states one>" }]
```

Prompt guidance: omit both keys entirely when the source doesn't state a date for that specific
entity relationship — an absent hint is not "assume now," it is "no fact-level opinion," which
resolves at query time via §3.1's fallback to the memory's own `valid_from`.

Wiring (slice 2, not part of this spike):

- Local-only entity type used between stage 5 (extract) and stage 8 (embed-index) widens past the
  wire's `AtomEntitySchema` (`name`/`kind`/`subtype` only) to also carry optional
  `valid_at`/`invalid_at` (parsed ISO strings), analogous to how `NormalizedMemory` already carries
  fields beyond the wire shape.
- `08-embed-index.ts` (`embedAndIndex`, `entities.ts:15-16` import site) calls
  `entityRepo.linkWithValidity(memoryId, entityId, { validAt, invalidAt })` per entity instead of
  `link()`. `validAt`/`invalidAt` are `null` (not `ctx.capturedAtMs` and not "now") when the
  extractor emitted no hint — **fallback = the memory's own `valid_from`, resolved at query time
  per §3.1, never baked into the row at write time.** This matches the FEAT correction precisely:
  "default to the memory's own `valid_from`, not `captured_at`" — and additionally means a later
  correction to the memory's `valid_from` (rare, but possible via a future backfill/repair tool)
  never requires rewriting already-linked fact rows.
- No change to `entity-backfill` CLI's shape is required by this FEAT — pre-existing corpus
  backfill rows get `valid_at=NULL, invalid_at=NULL` from migration 023 directly (§1.2), which
  already resolves to the same fallback.

---

## 5. Slice cut

Contract → local → cloud, matching the FEAT's proposed 3-slice shape, with the contract edit moved
to the *start* of slice 2 (it's a small in-place schema edit per §2, not itself a spike — the
spike was deciding whether to do it, which this document settles).

| Slice | Scope | Points |
|---|---|---|
| **SLICE-1** (this document) | Design spike: DDL, contract shape, query composition, distill hints, ACs. No code. | 3 |
| **SLICE-2** (local) | Contract: relax `atom.v2.schema.json` in place (§2.2) + regenerate types/zod + fixtures + package minor bump. Migration 023 (§1.2). `EntityRepo.linkWithValidity` + `memoryIdsForEntitiesAsOf` (§1.3, §3.3). `search.ts` composition wiring for `entity`+`as_of` (§3.3). Distill prompt + local entity-type widening + `08-embed-index.ts` wiring (§4). No sync-wire population yet (§2.4). | 5 |
| **SLICE-3** (cloud) | EF Core migration mirroring `memory_entities`'s surrogate PK + `ValidAt`/`InvalidAt` columns (Postgres has no SQLite ALTER-TABLE limitation, so this is a plain additive migration, not a rebuild). As-of query support in the retrieval path. Shipper carries the new fields end-to-end — gated on cloud having pulled the relaxed contract (§2.4) before local's shipper starts populating them. | 5 |

Total 13 points, matching the FEAT body's original estimate (~2–2.5 weeks, 1 dev). Soft sequencing
constraint carried over from the FEAT body: don't parallelize this FEAT's migration slice with
FEAT-456's (both touch the entity/consolidation lifecycle) — not a hard `depends_on`.

---

## 6. Acceptance criteria (Given-When-Then)

**AC-1 — migration 023 preserves existing links.**
*Given* a database with N `memory_entities` rows from a prior version, *when* migration 023 runs,
*then* the post-migration table has exactly N rows, each with the same `(memory_id, entity_id)`
pair as before, a freshly generated `id`, and `valid_at`/`invalid_at` both `NULL`.

**AC-2 — surrogate PK allows a second window for the same pair.**
*Given* an existing open (`invalid_at IS NULL`) link row for `(memoryId, entityId)`, *when* the
caller closes it (`invalid_at = T1`) and inserts a new row for the same pair with `valid_at = T1`,
*then* both inserts succeed and the table holds two rows for that pair — proving the composite-PK
constraint is gone and `idx_memory_entities_open_window` (§1.4) still rejects a *second concurrently
open* row for the same pair.

**AC-3 — contract fixtures pass/fail as designed.**
*Given* the relaxed `atom.v2.schema.json` (§2.2), *when* `contracts/validate.mjs` runs, *then*
every `fixtures/valid/atom-v2-*` fixture (including the two new ones) passes, every
`fixtures/invalid/atom-v2-*` fixture (including the new unrecognized-third-key regression fixture)
fails, and `tests/contracts/entity-kind-parity.test.ts` stays green (kind enum untouched).

**AC-4 — distill extracts a stated validity hint.**
*Given* source text that states an entity relationship's time bound (e.g. "Alice was the approver
from January to March"), *when* stage 5 extraction runs, *then* the emitted `entities[]` item for
`alice` carries `valid_at`/`invalid_at` matching the stated dates, and stage 8 links them via
`linkWithValidity` unchanged.

**AC-5 — distill falls back to the memory's own `valid_from` when no hint is stated.**
*Given* source text that mentions an entity with no stated date, *when* distill runs, *then* the
resulting `memory_entities` row has `valid_at=NULL, invalid_at=NULL`, and a subsequent `as_of`
query at any instant within `[memory.valid_from, memory.valid_to)` resolves the link as valid per
§3.1's fallback — matching Example 3 (§3.4).

**AC-6 — entity+as_of narrows selection (Example 2).**
*Given* a memory with a fact-level link window narrower than the memory's own window, *when* a
search/recall query supplies both `filters.entity` (resolving to that link) and `filters.as_of`
outside the link's effective window but inside the memory's own window, *then* the memory is
**excluded** from results — while a plain `as_of` query with no entity filter at the same instant
still **includes** it (Example 1 vs Example 2, §3.4).

**AC-7 — supersede/invalidate interaction needs no new cascade code.**
*Given* a memory with open fact-level links, *when* it is `supersede()`d, *then* the existing AC-3
`DELETE FROM memory_entities WHERE memory_id = ?` cascade removes them exactly as before (no
migration-023-specific change needed); *and given* it is instead `invalidate()`d, *when* an
`entity`+`as_of` query targets an instant after the memory's `valid_to`, *then* the §3.1 query-time
clip excludes it with no change to `invalidate()`'s implementation (Example 3, §3.4).

**AC-8 — zero interaction with the vector schema.**
*Given* migration 023 applied to a database at any configured embedding dim, *when* `doctor` /
the embed-dim preflight run, *then* neither reports any change — `memories_vec` and
`getVecSchemaDim()` are untouched (§1.2).

---

## 7. Non-goals

- **No graph engine.** This is temporal metadata on the existing `memory_entities` link, not
  Graphiti-style typed edges *between* two entities (e.g. `alice --reports_to--> bob`). Modeling
  relationships between entities (rather than between a memory and one entity) stays on the
  kill-list, per the FEAT body's own framing.
- **No `retrieval-result.v1.schema.json` change.** Search/recall hits are whole memories today;
  this FEAT doesn't add a per-entity-link field to the result envelope. A future feature that wants
  to explain *why* a memory matched at a given `as_of` (surfacing which entity link's window
  covered `T`) is an explicit, separate follow-up — not scoped here (§2.4 already notes the wire
  writer for the request/create side is itself gated on a separate atom@2-writer cutover).
- **No UI for editing fact-level windows.** Windows are set by distill extraction (§4) or, in
  principle, an explicit correction API — no such API is part of this FEAT; `linkWithValidity` is a
  storage-layer primitive, not a new REST/MCP surface.
- **No backfill UPDATE for the pre-existing corpus.** Unlike migration 006's `valid_from` backfill
  (which was necessary because there was no fallback path at the time), `NULL`/`NULL` on every
  pre-existing `memory_entities` row already resolves correctly via the §3.1 query-time fallback —
  writing the same value explicitly would be redundant work with no behavioral difference.
- **No change to `invalidate()`/`supersede()` implementations.** Both lifecycle ops need zero new
  code — see AC-7 and §3.1's explanation of why the query-time clip is sufficient.

## 8. Open risks / follow-ups (not blocking slice 2)

- `src/contracts/atom-wire.ts`'s `toAtomWireV1` mapper still emits `entities: []` unconditionally
  — astramem-local has not yet cut its live wire writer over to atom@2 at all (per
  `contracts/README.md`'s own "Memory atom v2" section, that cutover is separate follow-up work).
  This FEAT's wire-shape decision (§2) targets the schema so the field exists when that cutover
  happens; it does not perform the cutover.
- `idx_memory_entities_open_window` (§1.4) enforces "at most one open window per pair" at the DB
  layer, but doesn't prevent two *closed* windows for the same pair from overlapping in time (e.g.
  two historical corrections whose ranges accidentally intersect) — left as an application-level
  invariant on `linkWithValidity`'s caller, not a DB constraint, consistent with how the rest of
  this repo's bitemporal windows (`memories.valid_from`/`valid_to`) are enforced by lifecycle-op
  code rather than a `CHECK`.

---

## 9. Status correction (2026-07-12)

**SLICE-1 (this document) and SLICE-2 (local) are DONE and shipped — not pending.** The backlog
file (`.claude/artifacts/loop/backlog/triaged/FEAT-453.md`) is stale: it still reads
`status: triaged`, `slices: []`, and carries the `needs_contract` framing as if no design existed.
The actual history:

| Commit | What |
|---|---|
| `051a1c0` | This design doc committed (SLICE-1) |
| `40d166e` | SLICE-2 implementation (migration 023, `EntityRepo.linkWithValidity`/`closeAndRelink`/`memoryIdsForEntitiesAsOf`, `search.ts` composition, distill prompt hints, contract relax + fixtures) |
| `9032dad` | Review artifact committed — `.claude/artifacts/crew/reviews/20260710T065902-review-result-feat-453-s2.md`, verdict **PASS** |
| `11348dd` | Merged to main |
| `b5f1cee` | **Released in v0.12.0** — CHANGELOG.md "Added" section, "Fact-level bitemporal validity on entity links (FEAT-453 slice 2)" |

Verified directly against the current main-checkout working tree (not just the review artifact's
claims): `src/storage/entities.ts` has `linkWithValidity`/`closeAndRelink`/`memoryIdsForEntitiesAsOf`
exactly as designed; `src/search/search.ts:377-385` wires the entity+`as_of` composition point
(§3.3) exactly as designed, with `validityFilterClause` (§3.2's point A) applied independently and
unchanged at `search.ts:462`. `SCHEMA_VERSION` is at 25 (migrations through
`025-purge-batches.sql`), i.e. two full migrations have shipped *after* 023 with no incident.

**Only SLICE-3 (cloud EF Core mirror) remains**, and it has not been started: a read-only sweep of
the sibling `memory` repo (`C:\work\mega\memory`) found no EF migration, `MemoryEntities` DbSet
change, or retrieval-path clip touching this feature outside unrelated sibling-agent worktrees
under `memory/.claude/worktrees/` (different in-flight work, not this FEAT).

**Action needed (not performed here — out of this task's read-only-on-source scope, and backlog
bookkeeping isn't source/schema, but it's still not this task's assigned deliverable):** update
`.claude/artifacts/loop/backlog/triaged/FEAT-453.md` frontmatter to drop `needs_contract`, set
`slices: [FEAT-453-SLICE-1, FEAT-453-SLICE-2]` (done) with only `FEAT-453-SLICE-3` remaining, and
consider whether the FEAT file should move to an "in-progress"/partial bucket rather than sit in
`triaged/` unchanged. Flagging this to the lead rather than editing loop backlog state as part of a
design-only task.

## 10. Answers to the five open questions (2026-07-12 review)

These were posed as "must not be hand-waved" before any further slice work. All five are already
resolved by §0–§4 above; this section makes each answer explicit and citable in one place, plus one
genuine gap (Q2) that needs a human call.

**Q1 — Grain: fact/atom or memory?**
Neither, precisely — it's **the memory-to-entity link** (`memory_entities`), a third grain between
"whole memory" and "global entity." Confirmed against schema: `entities` (migration 012) is a
deduplicated *global* registry — one row per canonical name across the entire corpus — so a
validity window cannot live there (which entity would it belong to; Alice-in-general has no single
window). `memories` already has its own memory-level `valid_from`/`valid_to` (migration 006) and
that is untouched. The correct — and only structurally possible — home for "this specific mention
of Alice, in this specific memory, was true Jan–Mar" is the junction row. This does mean existing
memory-level `as_of` queries are **completely unaffected** unless a caller also supplies
`filters.entity` (§3.2 vs §3.3) — a plain `as_of` query never touches `memory_entities` at all.

**Q2 — Bitemporal semantics: which axis, and is the FEAT title accurate? [HUMAN CALL — see below]**
Precise answer: **this ships valid-time only, on both grains.** `memories.valid_from`/`valid_to`
and the new `memory_entities.valid_at`/`invalid_at` both model *when the fact was/is true in the
world* — the valid-time axis. Neither table has a queryable *transaction-time* axis (when the
system learned or recorded that fact) that a caller can pin with something like `as_of_transaction`
— `memories.created_at`/`memory_events.created_at` are ingest bookkeeping timestamps, not a second
indexed dimension you can slice retrieval on ("what did we believe was true, as of last Tuesday,
even though we've since corrected it"). That capability is what full bitemporal modeling adds over
valid-time-only modeling, and it does not exist today at either grain.

**This is a genuine terminology gap in the FEAT, not a new one this design doc introduced** — the
FEAT title and Graphiti comparison both say "bitemporal" while describing (and now shipping) a
valid-time-only model. It is a defensible, deliberate scope cut (Graphits's own `valid_at`/
`invalid_at`/`expired_at` on `edges.py:271-282` is also valid-time-only, per the FEAT's own cited
evidence — "bitemporal" in the competitor-gap research report is describing the *category* of
temporal-fact tracking loosely, not asserting Graphiti itself does two-axis modeling), but nobody
made that scope cut explicit before SLICE-2 shipped. **Human decision needed:** (a) accept that
FEAT-453 is closed-as-shipped under valid-time-only semantics and rename/reframe the FEAT
title/CHANGELOG language to stop saying "bitemporal" unqualified (or add a one-line clarifying
footnote), **or** (b) file a distinct new FEAT for true transaction-time tracking (a genuinely
different, larger feature — it would need an append-only fact-version log, not a mutable window
column, since transaction-time is inherently insert-only/immutable) if there's real customer
demand for "what did we used to believe" queries. Recommend (a) — no evidence in the competitor
research or the FEAT's own customer-impact score (0.4) suggests transaction-time queries are asked
for; ship the valid-time win, rename the label.

**Resolved 2026-07-12 (operator decision):** Option (a) accepted. The label is corrected wherever
this repo describes its own capability (this document's title, above; the competitor-gap-analysis
report; this ADR's own amendment) — no transaction-time axis will be built absent concrete demand.
Historical CHANGELOG entries are left unedited (they record what was said at release time); a
clarifying note there is a separate call for the maintainer, not made by this pass.

**Q3 — Invalidation/supersession vs fact-level `invalid_at`: two overlapping mechanisms?**
Yes, there are now two independent triggers that can close a fact-link window — but they don't
need unifying because they compose cleanly via one rule, already implemented: **narrower wins,
computed at query time** (§3.1's `MAX`/`MIN` clip). Concretely:
- `supersede()` still hard-`DELETE`s all of a memory's `memory_entities` rows (pre-existing AC-3
  cascade, unchanged) — the strongest possible clip, so a superseded memory's fact links simply
  don't exist to be queried.
- `invalidate()` sets the *memory's* `valid_to` but does **not** touch `memory_entities` rows at
  all (no new cascade was added, and AC-7 proves none is needed) — the effective-window formula's
  `MIN(..., m.valid_to)` term closes the gap by capping every fact link at the memory's own
  invalidation instant, without `invalidate()` ever needing to know `memory_entities` exists.
- An explicit fact-level `invalid_at` (set via distill extraction or a future correction call)
  closes a *narrower* window than the memory's own lifecycle state — "this specific fact stopped
  being true before the whole memory did."
No new unification code is needed; the two mechanisms already resolve to a single answer (the
tighter bound) by construction, not by special-casing which one "wins." This is fully covered by
AC-7 with a passing test.

**Q4 — Retrieval blast radius: does search/fuse filter on validity by default?**
No — and this is the load-bearing design choice that keeps the blast radius small. Memory
**selection** (which memories are candidates at all) is governed exclusively by the pre-existing
`validityFilterClause(as_of)` against `memories.valid_from`/`valid_to`, completely unchanged by this
FEAT. Fact-level validity only enters selection when a caller supplies **both** `filters.entity`
*and* `filters.as_of` together (§3.3) — the one new code path
(`memoryIdsForEntitiesAsOf`), gated behind an explicit `if (filters.entity !== undefined)` branch
that was already there pre-FEAT-453 for the untimed case. A plain `as_of`-only query, or any query
with no `as_of` at all, takes exactly the pre-FEAT-453 code path with zero behavioral change — this
was verified against the live `search.ts` diff, not just asserted. Default `as_of` semantics for a
query with no explicit time are also unchanged: `filters.as_of === undefined` → `valid_to IS NULL`
(current-snapshot), same as before this FEAT existed.

**Q5 — Backfill: what does NULL mean for pre-existing rows?**
Neither of the two options posed ("always valid" / "unknown") — it's a third, more precise choice:
**"defers to the parent memory's own window."** Migration 023 leaves every pre-existing
`memory_entities` row at `valid_at=NULL, invalid_at=NULL` (no backfill UPDATE, deliberately — §7
"Non-goals"). At query time, `memoryIdsForEntitiesAsOf`'s clip (§3.1) treats `NULL` as
`COALESCE(me.valid_at, m.valid_from)` / `COALESCE(me.invalid_at, +inf)` — i.e. a link with no
stated fact-level opinion inherits exactly its parent memory's own valid-time window, no wider and
no narrower. This is neither "always valid regardless of the memory's state" (which would ignore
`m.valid_to` entirely) nor "unknown therefore excluded" (which would need a sentinel/exclusion
rule the design doesn't have) — it propagates the one temporal fact the system already has an
opinion about (the memory's own window) down to every link that hasn't stated a finer one. Same
answer applies uniformly to pre-existing corpus rows and to newly-distilled rows where extraction
found no date in the source text (§4, AC-5).

## 11. SLICE-3 contract: cloud EF Core mirror (the actual remaining gap)

Everything above is retrospective (confirming already-shipped local design). This section is the
one piece of net-new design content this pass adds — SLICE-3 has no code yet, on either side.
Written from this repo's contract-facing surface only; final column/type decisions belong to
whoever picks up SLICE-3 with the `memory` repo open, but the shape below should not need
revisiting.

### 11.1 EF Core migration shape (mirrors §1.2, Postgres has no rebuild constraint)

Postgres supports adding a surrogate PK to an existing table and dropping a composite PK/unique
constraint via a normal `ALTER TABLE` — none of SQLite's copy-swap rebuild is needed. Target: a
`MemoryEntities` table/entity mirroring local's `memory_entities` post-023 shape:

```
Id           uuid        PK (was implicitly the composite natural key before, if cloud already had
                          a memory_entities equivalent — confirm against cloud's actual current
                          schema before assuming this table exists there at all; this design doc
                          only has authority over the local side, per this FEAT's own cross-product
                          scope note)
MemoryId     uuid        FK -> Memories(Id), cascade delete (mirrors local's ON DELETE CASCADE)
EntityId     uuid        FK -> Entities(Id), cascade delete
ValidAt      timestamptz NULL
InvalidAt    timestamptz NULL
```

Partial unique index equivalent to §1.4: Postgres supports partial unique indexes natively —
`CREATE UNIQUE INDEX ... ON "MemoryEntities" ("MemoryId", "EntityId") WHERE "InvalidAt" IS NULL`,
expressed via EF Core's `HasFilter()` on a `HasIndex(...).IsUnique()` fluent call. This is a
**plain additive migration** on the cloud side (add table or add two nullable columns + one
partial index) — no rebuild, no data hazard, matching the FEAT triage's technical-risk banding
("additive/nullable... keeping it below the 0.9+ contract-break band").

### 11.2 Retrieval query mirror (EF Core / LINQ shape of §3.1's clip)

The `+inf` sentinel trick (§3.1's `9223372036854775807` epoch-ms literal) is a SQLite-ism worth
replacing on the Postgres side with `InvalidAt == null || InvalidAt > asOf` predicates directly —
Postgres/LINQ has no need for a sentinel since `NULL`-aware comparisons compose naturally in EF
Core's translated SQL (`COALESCE` isn't required to express "null means open-ended" in a boolean
predicate the way SQLite's `MIN`/`MAX`-based clip needed it for a single comparable value). Target
shape:

```csharp
var effectiveStart = me.ValidAt ?? m.ValidFrom;
var effectiveEnd = me.InvalidAt; // null = open
bool covers = effectiveStart <= asOf && (effectiveEnd == null || effectiveEnd > asOf)
              && m.ValidFrom <= asOf && (m.ValidTo == null || m.ValidTo > asOf);
```

i.e. the same two-part rule as §3.3 ("both hold: (i) memory-level filter independently passes, (ii)
fact-link effective window covers `T`"), not a literal port of the SQLite `MAX`/`MIN`-with-sentinel
expression, which is an implementation detail of SQLite's lack of nullable-aware comparison
operators in that particular clause shape.

### 11.3 Shipper wiring — hard-gated, not just soft-sequenced

§2.4 already established the local shipper does not populate these fields on the wire yet
(`toAtomWireV1` unconditionally emits `entities: []`, independent of this FEAT). SLICE-3's shipper
work is therefore **cloud pulling the relaxed atom@2 contract first** (a routine version-pin bump
per `contracts/README.md`'s existing pinned-artifact/subtree process — no new contract work), and
only *then* does populating `valid_at`/`invalid_at` on outgoing sync payloads become a live wire
path. Sequence, precisely:
1. Cloud EF migration lands (11.1) — schema exists, but has zero non-null rows since nothing
   writes to it yet.
2. Cloud pulls relaxed `atom.v2.schema.json` (contracts `2.1.0`, already shipped locally).
3. Cloud retrieval path (11.2) goes live — reads default to NULL/inherits-parent behavior
   identically to local's own fallback (§10 Q5), so this is safe to deploy before step 4.
4. **Separate, later** follow-up (not part of SLICE-3 as scoped by the FEAT body): local's own
   `toAtomWireV1` atom@2 writer cutover (already a known independent piece of unshipped work per
   §2.4) starts actually emitting real `valid_at`/`invalid_at` values on the wire. Until that
   cutover lands, SLICE-3's cloud schema/query support ships and sits ready with no observable data
   flowing into it — this is intentional, not a partial/broken state.

### 11.4 SLICE-3 human decisions

- **Confirm cloud's current `memory_entities`-equivalent shape** before writing the EF migration —
  this design doc has no authority over what the `memory` repo's schema actually looks like today;
  §11.1's column list assumes a structural mirror of local's post-023 shape but that assumption
  needs a human (or a `crew:architect-feature` pass scoped to the `memory` repo) to verify against
  live cloud EF model state before implementation starts.
- **Resolve Q2 (§10)** before or alongside SLICE-3 — if the human call there is "rename away from
  'bitemporal'," that relabeling should happen in the same pass as SLICE-3's cloud-side
  documentation/ADR language, not drift into a third round of terminology cleanup later.

## 12. Slice decomposition (corrected)

| Slice | Status | Scope | Owner mode |
|---|---|---|---|
| SLICE-1 | **DONE** (this document, commit `051a1c0`) | Design spike | n/a |
| SLICE-2 | **DONE, shipped v0.12.0** (commit `40d166e`, review PASS `9032dad`, merged `11348dd`) | Local: migration 023, contract relax, `EntityRepo` surface, `search.ts` composition, distill hints | n/a |
| SLICE-3 | **Not started** | Cloud: EF Core migration mirror (§11.1) + retrieval query (§11.2) + shipper (§11.3, hard-gated on the separate atom@2-writer cutover) | **CROSS-REPO, NOT AUTONOMOUS** — needs the sibling `memory` repo open and human coordination on schema-shape confirmation (§11.4) |

No further local-only slice work remains under FEAT-453. The FEAT is not eligible for
`/runner:wave` autonomous dispatch as currently scoped (SLICE-3 is the only open item and it's
explicitly non-autonomous) — it needs a human-initiated cross-repo session against `memory`, per
the wave-plan handoff's own framing.
