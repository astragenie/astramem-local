# FEAT-481: Entity-to-Entity Relations — Design

**Status:** draft for architect-reviewer
**Date:** 2026-07-13
**Author:** architect (this session)
**Design principle: cloud parity.** The sibling `memory` (SaaS) repo already
ships a mature, production entity-relationship system (§0). Every decision
below defaults to mirroring cloud's shape — schema, casing, cascade
semantics, field names — unless a specific local constraint (ADR-006 hard
erasure, no server-side enrichment pass) forces a deliberate divergence,
each of which is called out explicitly in §7.
**Origin:** `.claude/artifacts/loop/backlog/pending/FEAT-481.md`; scoped by
`docs/superpowers/specs/2026-07-13-memory-quality-design.md` §3.3 (D3
coordination); revised per team-lead directive (cloud-parity constraints,
this pass).
**Related:** FEAT-402 (`entities`/`memory_entities`, migration 012), FEAT-453
(fact-level valid-time on `memory_entities`, migration 023,
`docs/specs/FEAT-453-bitemporal-design.md` — the pattern this design reuses
throughout), the merged extraction-prompt FEAT (D3, same prompt surface).

## 0. Ground truth from the cloud repo (verified against code, not summary)

Cloud (`C:\work\mega\memory`) ships `astramemory.entity_relationships`
(FEAT-285/M9), `IEntityRelationshipRepository`, and two MCP tools
(`get_entity_related`, `get_entity_timeline`,
`src/AstraMemory.Mcp/Tools/EntityTools.cs`) already registered in this
repo's own parity-CI-gated `contracts/manifests/mcp-tools.v1.json` as
cloud-owned/stable. Verified directly (`db/migrations/schema.sql:4556-4575`,
`EntityRelationshipEntity.cs`, `EntityRelationshipRepository.cs`,
`EntityPersister.cs`, `EntityKinds.cs`, `IExtractionPipeline.cs`):

```sql
CREATE TABLE astramemory.entity_relationships (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    subject_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
    predicate varchar(128) NOT NULL,
    object_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
    evidence_memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
    source_excerpt text NOT NULL,
    confidence double precision NOT NULL DEFAULT 0.5,
    valid_from timestamptz NOT NULL,
    valid_to timestamptz,
    invalidated_by uuid REFERENCES entity_relationships(id) ON DELETE SET NULL,
    invalidated_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
```

Corrections/refinements to fold in beyond the team-lead's summary (each
independently verified, cited by file):

1. **`predicate` is a hard, security-gated write filter, not a soft
   default.** `EntityPersister.cs:159-168` (comment: *"Security review
   MEDIUM: enforce predicate allow-list as a WRITE gate. Previously only
   used to normalize the metric tag — any LLM-extracted string accumulated
   in entity_relationships.predicate unconditionally."*). A candidate whose
   `Predicate` isn't in the allow-list is **dropped entirely** (counted,
   logged, never written — no `'other'` fallback row is persisted).
   The allow-list (`IExtractionPipeline.cs:32-34`,
   `ExtractionDefaults.AllowedRelationshipPredicates`) is:
   ```
   uses, depends_on, replaces, supersedes, mentions,
   relates_to, part_of, owned_by, assigned_to, created_by
   ```
   — **lowercase `snake_case`**, not `SCREAMING_SNAKE_CASE` as FEAT-481's
   body assumed, and matched with `StringComparer.Ordinal` (case-sensitive).
   This is the load-bearing fact for §2.4/§7.
2. **Confidence is NOT a model-reported value on cloud's current
   relationship path.** `IExtractionPipeline.cs:53`'s
   `RelationshipCandidate` record is `(Subject, Predicate, Object,
   SourceExcerpt)` — **no confidence field at all** at the candidate/wire
   level. `EntityPersister.cs:203-204` calls
   `relationshipRepo.UpsertAsync(..., confidence: 0.7, ct)` — a **hardcoded
   literal**, not the model's own estimate (entity mentions get a
   different hardcoded `0.8`, `EntityPersister.cs:135`). The column's DB
   default (`0.5`) is a schema-level fallback, distinct from the
   application-level constant cloud actually writes. This refines (not
   contradicts) "cloud persists confidence" — it does, but not as a
   genuine per-relationship calibration signal today. See §6.
3. **No wire field for relationship triples exists today.** Cloud's
   `ReadDeclaredEntitiesJson` (`SyncIngestService.cs:490-524`) reads only an
   `entities` array off the incoming payload; there is no
   `ReadDeclaredRelationshipsJson` counterpart anywhere in the repo (grepped
   for it, zero hits). Cloud's relationships are mined entirely **server
   side**, asynchronously, by `EnrichmentBackgroundService` re-reading
   already-stored memory content — not fed from anything local ships on the
   wire. A wire field for declared relationship triples (§5, SLICE-5) is
   genuinely new work, and the cloud-side reader for it does not exist yet
   — correctly out of this repo's scope, exactly as the team-lead's
   directive framed it.
4. **FK behavior is `RESTRICT`, not `CASCADE`**, on all three FKs
   (subject/object entity, evidence memory) — cloud never hard-deletes a
   memory or entity out from under an existing relationship row; deletion
   is blocked instead of cascading. `invalidated_by` is `ON DELETE SET
   NULL` (self-FK) but nothing in the codebase currently *writes* it for
   relationships (searched every `InvalidatedBy` write site — all matches
   are on the unrelated `Memory`/`MemoryDataEntity` bitemporal chain, not
   `EntityRelationshipEntity`). The self-FK is a shipped-but-dormant
   placeholder, same conclusion as the original pass, now double-checked.
5. **Entity kind taxonomy is already byte-identical.** Cloud's
   `EntityKinds.CanonicalOrder` (`EntityKinds.cs:42-45`) —
   `actor, team, org, project, product, workitem, decision, tech, tool,
   concept, event, other` — matches local's `ENTITY_KINDS`
   (`src/contracts/entity.ts:14-27`) in the same order, verbatim. FEAT-481
   introduces no new entity kind, so there is no drift risk to design
   around here; noted for completeness per the team-lead's directive item 2,
   not because any change is needed.

---

## 1. `entity_relations` schema — migration 027

Latest migration is `026-proxy-usage.sql`; this is **027**. Column names now
mirror cloud's exactly (`predicate`, `evidence_memory_id`) per the team-lead
directive — a deliberate rename from this design's first draft (which used
`relation_type`/`source_memory_id`, matching only the FEAT body's literal
wording) so a future sync/shipper slice is a field-for-field copy, not a
translation layer.

```sql
-- 027: entity-to-entity relation triples (FEAT-481).
--
-- Local mirror of the sibling `memory` repo's already-shipped
-- astramemory.entity_relationships (FEAT-285/M9, verified against
-- db/migrations/schema.sql:4556-4575) — column names (predicate,
-- evidence_memory_id) match cloud's exactly, not the FEAT body's original
-- relation_type/source_memory_id wording, so a future shipper needs no
-- field-name translation. See docs/specs/FEAT-481-design.md §0 for the
-- verified cross-repo shape.
--
-- subject_entity_id/object_entity_id/evidence_memory_id use ON DELETE
-- CASCADE, NOT cloud's ON DELETE RESTRICT (§0.4) — a deliberate divergence,
-- not an oversight. Cloud never hard-deletes a memory or entity out from
-- under a relationship row (RESTRICT blocks it structurally); this repo's
-- ADR-006 erase_memory tool is an explicit, user-invoked HARD delete
-- (src/storage/memory-events.ts, `foreign_keys=ON` for every connection,
-- src/storage/db.ts) that every other memory-scoped child table already
-- cascades on (memory_entities, 012-entities.sql). Using RESTRICT here
-- would make erase_memory fail with an FK violation the moment any
-- relationship cites the memory being erased — CASCADE preserves
-- erase_memory's existing all-or-nothing hard-delete contract. subject/
-- object entity CASCADE is likewise consistent with memory_entities'
-- existing FK (012-entities.sql:32) and is dead code in practice either
-- way: EntityRepo has no delete/erase method, so entities are immortal
-- once created (no merge/rename operation exists in this codebase today —
-- entities.name UNIQUE dedups entirely at *creation* time via
-- normalizeEntityName, src/entity/normalize.ts). If an entity-merge FEAT is
-- ever added, CASCADE is the wrong behavior for a *rename* (the row should
-- be repointed, not deleted) — flagging this now so that future FEAT
-- doesn't get surprised by an implicit cascade wipe.
--
-- No composite UNIQUE(subject_entity_id, predicate, object_entity_id):
-- cloud's own repository doesn't enforce this at the DB layer either
-- (EntityRelationshipRepository.cs UpsertAsync — a write-time
-- INSERT...WHERE NOT EXISTS guard, not a constraint) because two different
-- source memories independently asserting the same triple is corroborating
-- evidence, not a conflict.
--
-- valid_from/valid_to: same half-open valid-time convention as
-- memories.valid_from/valid_to (006) and memory_entities.valid_at/invalid_at
-- (023), and matches cloud's own valid_from NOT NULL / valid_to nullable
-- shape exactly. valid_from is always populated at write time (extracted
-- stated date if the source text gave one, else the source memory's own
-- valid_from/captured_at) — never left NULL, matching both
-- memories.valid_from's insert-time convention (006: "New rows set
-- valid_from = created_at at insert time") and cloud's now() default.
--
-- source_excerpt is NOT NULL, matching cloud exactly (schema.sql:4563) —
-- the write path falls back to the parent atom's own `evidence`/`text`
-- field when the model omits a per-triple excerpt (§2.1), so this
-- constraint is always satisfiable without a nullable escape hatch.
--
-- confidence: kept (§6) — REAL model-reported value when the extractor
-- emits one, DEFAULT 0.5 otherwise (matches cloud's column default exactly;
-- unlike cloud, local's confidence can be a genuine per-triple model
-- estimate, not a hardcoded constant, since local's extraction call
-- already asks for one — see §6 for why this doesn't change v1's
-- treat-as-metadata-only stance).
--
-- Zero interaction with vec0 tables — no FLOAT[N] column, no
-- getVecSchemaDim()/DEFAULT_EMBED_DIM touch (CLAUDE.md "Do NOT" section).

CREATE TABLE entity_relations (
  id TEXT PRIMARY KEY,
  subject_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  evidence_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_excerpt TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  invalidated_by TEXT REFERENCES entity_relations(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

-- Direction lookups (mirrors cloud's ix_entity_relationships_subject/object,
-- EntityRelationshipEntityConfiguration.cs:28-32).
CREATE INDEX idx_entity_relations_subject ON entity_relations(subject_entity_id, predicate);
CREATE INDEX idx_entity_relations_object ON entity_relations(object_entity_id, predicate);

-- Temporal filtering: currently-valid scan is the default read path for
-- both directions (get_entity_related with no as_of).
CREATE INDEX idx_entity_relations_valid_to ON entity_relations(valid_to);

-- Reverse lookup for the source-memory-scoped cascade (supersede()/erase()
-- need "every relation row sourced from memory X" — same shape
-- unlinkMemory() already needs for memory_entities, entities.ts:127-129).
CREATE INDEX idx_entity_relations_evidence_memory ON entity_relations(evidence_memory_id);
```

---

## 2. Extraction integration

### 2.1 Same call, nested per-atom (not a top-level array)

Add an optional `relations` field **inside `AtomSchema`**, parallel to the
existing `entities` field (`src/distill/prompts/extract.ts:37-46`), not a
new top-level sibling of `atoms`:

```ts
export const AtomRelationSchema = z.object({
  subject: z.string().min(1).max(100),
  predicate: z.enum([...RELATION_PREDICATES, 'other']),
  object: z.string().min(1).max(100),
  evidence: z.string().optional(),
  valid_at: z.string().optional(),
  invalid_at: z.string().optional(),
});

// on AtomSchema:
relations: z.array(AtomRelationSchema).optional(),
```

**Why nested, not top-level:** a memory row doesn't exist until stage 8
(`08-embed-index.ts`, one row per `NormalizedMemory` post stage 7) — a
chunk-level top-level `relations` array would have no unambiguous
`evidence_memory_id` once a chunk yields multiple atoms/memories. Nesting
inside the atom that names the relation gives every triple exactly one
future memory row to attach to, for free (same reasoning FEAT-453 §2.3
used to reject a parallel `entity_validity` array in favor of inlining onto
`entities[]` items).

`evidence` is optional per-triple; when the model omits it, the write path
(stage 8) falls back to the atom's own `evidence` field, then to a
truncated `text`, so `source_excerpt NOT NULL` (§1) is always satisfiable —
mirroring how cloud's `RelationshipCandidate.SourceExcerpt` is always a
real string by the time `EntityPersister` receives it.

### 2.2 No-hallucination constraint: subject/object must be named in the same atom

`subject`/`object` are matched by name against **this atom's own
`entities[]` list** (case/whitespace-normalized via the existing
`normalizeEntityName` seam) — a triple naming something the model didn't
already commit to listing as an entity in the same atom is dropped, not
auto-created. Answers design point 2's "unresolvable endpoints" question:
**drop the triple, never auto-create an entity from the relation side.**

This is stricter than cloud's own server-side path, which *does*
auto-upsert an unrecognized subject/object as a bare `kind="other"` entity
(`EntityPersister.cs:172-186`) — but that path is structurally different:
cloud's relationships are mined by a separate enrichment LLM call over
already-stored content, with no natural "this atom's own entity list" to
constrain against. Local's relations are nested *inside* the same
extraction call that already produces the atom's `entities[]`, so the
stricter same-atom constraint is available for free and is the more
precise choice for this shape specifically — not a rejection of cloud's
looser policy, just a different structural opportunity.

**Named v1 limitation:** this guard also silently drops a genuine relation
whose two endpoints are real but split across two different atoms of the
same chunk (e.g. one atom about Alice's decision, another about Bob's
event, with a true Alice–Bob relation that belongs to neither atom alone) —
same "corroborating evidence, no complaint" behavior as a hallucination
that never should have been asserted, with no way for a caller to tell the
two cases apart. This is an accepted precision-over-recall trade for a
brand-new surface (consistent with v1's "deliberately modest" framing
elsewhere in this doc, §3), not an oversight — revisit post-v1 only if real
usage shows cross-atom relations are common enough to matter.

### 2.3 Validation: lenient per-triple, same idiom as atoms/entities

`AtomRelationSchema` is validated the same way `AtomEntitySchema` already
is — parse the wrapper leniently, then filter: a malformed triple (empty
`predicate`, `subject === object`, or an unresolvable endpoint per §2.2) is
dropped from the array, never rejects the whole atom or throws
`TransientError`. Mirrors `coerceEntityKinds` + the `AtomSchema.safeParse`
filter already in `05-extract.ts:131-189` — add a sibling
`resolveAtomRelations(atom, resolvedEntityIds)` step at stage 8 (name→id
resolution needs the already-upserted entity ids for this atom, so this
runs at stage 8, not stage 5) that filters relations whose subject/object
name isn't in the resolved map.

### 2.4 `predicate`: seeded enum matching cloud's exact allow-list + local-only `'other'`

**Reversed from this design's first draft.** The first pass recommended an
open vocabulary normalized to `SCREAMING_SNAKE_CASE`, reasoning that cloud's
column was "just a string." §0.1 found the real constraint: cloud enforces
a **case-sensitive, security-reviewed hard allow-list** of exactly 10
lowercase values, and silently drops anything else at write time. An open
local vocabulary in a different case convention would mean **every single
local-extracted relation silently fails cloud's write gate** the moment a
sync path exists — a severe, silent, 100%-loss failure mode, discovered
only by this verification pass.

**Decision:** local's `predicate` enum is exactly cloud's 10 values, same
casing, plus a local-only `'other'` bucket:

```
uses | depends_on | replaces | supersedes | mentions |
relates_to | part_of | owned_by | assigned_to | created_by | other
```

`'other'` is retained **locally** (real local graph value — a triple the
extractor found meaningful but that doesn't fit the 10-value list) but is
excluded from any future sync/shipper payload (§5, SLICE-5) exactly as
cloud would exclude it anyway — the filtering happens deliberately on the
local side instead of being silently rejected server-side with no local
visibility into the loss. This is a closed zod `z.enum` (not a normalized
open string), unlike this design's first draft — no `normalizeRelationType`
seam is needed since there's no case-folding to do; the prompt asks for
these exact 11 tokens.

Prompt guidance (owned by D3, §2.5): few-shot examples model all 10 real
predicates plus one `'other'` example, so the model has genuine signal for
the closed set rather than inventing synonyms that would all collapse to
`'other'` uselessly.

### 2.5 Prompt guidance: possessor qualification (D3 ownership, this FEAT's slice lands inside it)

The triples prompt addition belongs in the **same shared skeleton** D3 is
already building (`src/distill/prompts/extract.ts`, per the memory-quality
design doc §3.2/§3.3 — "same file, one owner"). Guidance to add to that
shared prompt for the `relations` field specifically: resolve pronouns and
possessives to the actual named entity before writing subject/object (e.g.
"her deploy script" → subject is the actual named person/agent entity, not
the pronoun) — the same "self-contained, pronouns resolved" richness rule
D3 already decided for atom text (§3.2 bullet 1), applied to relation
endpoints. This design doc specifies the *requirement*; the actual prompt
copy is D3's builder's deliverable, not duplicated here.

---

## 3. Edge supersession semantics

**v1 is deliberately modest — matching cloud's own stance, not a gap unique
to local.** Cloud's `invalidated_by` self-FK (§0.4) is schema-shipped but
**dormant** — nothing in cloud's codebase currently populates it for
relationships (verified: every `InvalidatedBy`-write site found is on the
unrelated `Memory` bitemporal chain). "Reuse cloud's `invalidated_by`
pattern" therefore means: **ship the same dormant self-FK placeholder,
matching cloud's own current state exactly** — not invent a working
supersession-chain mechanism cloud itself hasn't built yet. Building a live
chain-writer here would leave local *ahead* of cloud's own shipped
behavior, which is a bigger scope increase than this FEAT's estimate
supports and not something to invent unilaterally without the cloud side
also committing to it.

1. **Source-memory lifecycle cascade (reuses existing valid-time machinery,
   zero new lifecycle code):**
   - `supersede()` (`src/storage/memory-events.ts:272`) already hard-deletes
     the old memory's `memory_entities` rows in the same transaction (AC-3,
     `entities.ts:127-129`). Extend this **same transaction** to also
     `DELETE FROM entity_relations WHERE evidence_memory_id = ?` for the
     old memory — a one-line addition next to the existing `unlinkMemory`
     call, not a new mechanism.
   - `invalidate()` itself (`memory-events.ts:218`) needs **no new code**,
     exactly per the FEAT-453 §3.1 precedent — but, per the reviewer's
     finding, that "no new code" claim is about `invalidate()`'s own
     implementation only, not the feature as a whole: the effective-`valid_to`
     computation must be built into SLICE-1's read path from the start
     (§4.1's `JOIN memories`), not bolted on afterward. At query time, a
     relation's effective `valid_to` is `MIN(entity_relations.valid_to,
     memories.valid_to)` (both treated as `+inf` when NULL), computed by the
     join §4.1 now specifies explicitly. A relation sourced from a memory
     that gets `invalidate()`d is automatically excluded from any `as_of`
     query past the memory's own `valid_to`, with zero change to
     `invalidate()`'s implementation — the join lives entirely in
     `EntityRelationRepo`'s own queries, which SLICE-1 must build this way
     from day one.
2. **A contradicting triple** (e.g. a later session says "Bob no longer
   reports to Alice"): **out of v1**, matching cloud (no code path anywhere
   populates `invalidated_by` for a relationship — §0.4). Schema supports
   it later without a migration.
3. **Explicit stated end-date on the same triple** (extraction found
   `invalid_at` per §2.1): written directly onto the new row's `valid_to` —
   no different from how `memory_entities`' hints already work (FEAT-453
   §4).
4. **Idempotency/dedup — same triple re-extracted from another session:**
   mirror cloud's write-time guard exactly
   (`EntityRelationshipRepository.cs:32-45`): before inserting, check
   whether a **currently-valid** row already exists for the exact
   `(subject_entity_id, predicate, object_entity_id)` tuple; skip the
   insert if so. **Deliberately not a DB constraint** — two independent
   memories asserting the same triple is corroborating evidence worth
   keeping as distinct rows (different `evidence_memory_id`, different
   `confidence`), matching cloud's own chosen mechanism exactly.
   **Implementation requirement, not optional style:** the
   `INSERT...SELECT...WHERE NOT EXISTS` guard MUST stay one atomic prepared
   statement (a single `db.prepare(...).run(...)` call) — this is what makes
   it race-safe under SQLite's single-writer lock even across multiple
   process (daemon/worker) writers. A refactor into two round trips ("SELECT
   to check with `.get()`, then `.run()` the insert separately") silently
   reintroduces the TOCTOU race the single-statement form was chosen to
   avoid. `EntityRelationRepo`'s implementation must carry a comment saying
   so at the call site, not just here in the design doc.

---

## 4. v1 retrieval surface

### 4.1 Tool naming and shape — match cloud's already-shipped tools field-for-field

**`get_entity_related`** (mirrors `EntityTools.cs:67-143` exactly, now
including field names):

```
Input:  entityId (uuid), asOf? (ISO-8601), direction? ('subject'|'object'|'both', default 'both'), limit? (default 50, max 500)
Output: { entity_id, relationships: [{ id, subject_entity_id, predicate, object_entity_id, evidence_memory_id, source_excerpt, confidence, valid_from, valid_to }] }
```

Note `predicate`/`evidence_memory_id` in the output shape, not
`relation_type`/`source_memory_id` — this MCP JSON contract, not just the
DB schema, is now byte-identical to cloud's tool output field names, so a
client already speaking to cloud's `get_entity_related` needs zero mapping
code to also speak to local's.

**Query contract, made explicit per reviewer finding [HIGH]:** the first
draft of this section stated the "currently valid" filter as `valid_to IS
NULL OR valid_to > now()` against `entity_relations` alone. That is
insufficient and, if implemented literally, produces a correctness bug:
§3.1 promises that a relation sourced from an `invalidate()`d memory stops
reading as valid once `as_of` passes that memory's own `valid_to`, but
nothing enforces that unless the query itself joins to `memories`.
`invalidate()` (`memory-events.ts:218-240`) only ever touches the
`memories` row — it has no knowledge of `entity_relations` by design — so
this join is the *only* place the promise can be honored, and it must be
part of `EntityRelationRepo`'s query from the start, not an afterthought.

`getForSubject`/`getForObject`/`getForEntity` (SLICE-1) MUST implement:

```sql
SELECT er.id, er.subject_entity_id, er.predicate, er.object_entity_id,
       er.evidence_memory_id, er.source_excerpt, er.confidence,
       er.valid_from, er.valid_to
FROM entity_relations er
JOIN memories m ON m.id = er.evidence_memory_id
WHERE er.subject_entity_id = ? -- or object_entity_id, per direction
  AND MAX(COALESCE(er.valid_from, m.valid_from), m.valid_from) <= :asOf
  AND MIN(COALESCE(er.valid_to, 9223372036854775807),
          COALESCE(m.valid_to, 9223372036854775807)) > :asOf
ORDER BY er.valid_from DESC
LIMIT ?
```

— the same `JOIN` + `MAX`/`MIN`-with-`+inf`-sentinel composition
`memoryIdsForEntitiesAsOf` already uses (`src/storage/entities.ts:223-238`),
substituting `er.evidence_memory_id` for `me.entity_id`'s join target. The
"currently valid, no `asOf` supplied" case is the same predicate with
`:asOf` bound to the current epoch-ms — not a separate, simpler query
against `entity_relations.valid_to` alone. `idx_entity_relations_evidence_memory`
(§1) covers the join; the composed `MAX`/`MIN` filter itself is not
sargable by a plain B-tree index, same as `memoryIdsForEntitiesAsOf`'s own
analogous filter — consistent with existing practice in this codebase, not
a regression, and fine at this repo's single-user/local scale.

`asOf` support: reuses `parseAsOf`, already imported into
`src/mcp/server.ts:55` for search's `as_of` — no new date-parsing code.

**`get_entity_timeline`** (mirrors `EntityTools.cs:147-196`): memories
mentioning the entity, newest first, optional `since` lower bound. Not new
machinery — `EntityRepo.memoryIdsForEntities`/`memoryIdsForEntitiesAsOf`
(`entities.ts:199-238`, already time-aware) joined back to `memories` for
`content`/`type`/`created_at`, exposed as an MCP tool for the first time.

### 4.2 Manifest update

Both entries in `contracts/manifests/mcp-tools.v1.json` flip `"owner":
"cloud"` → `"owner": "both"` (§5, SLICE-3) — the established pattern for
every other shared verb (`search_memory`, `remember`, `invalidate_memory`,
`submit_feedback`). `tests/contracts/mcp-tool-manifest-parity.test.ts`
enforces this stays in sync with what's actually registered in
`src/mcp/server.ts`, and is purely local (spins up this repo's own
`McpServer` in-process and diffs against this repo's own manifest copy) —
it does not block on, or contact, cloud in any way, and is unrelated to
`cross-repo-roundtrip.yml` (which only exercises the capture→ingest→
distill→recall path, never MCP tool registration). Flipping the owner
field for two tools cloud already implements today requires nothing from
cloud to land.

**Documentation follow-up, not a gate:** there is no automated check
keeping this repo's copy of `mcp-tools.v1.json` in sync with any
independent copy cloud may hold on its own side — `contracts/README.md`
describes cloud's consumption of this manifest as a prospective path it
itself flags as "NOT verified live." A case-sensitive-scope name flip like
this one (`cloud` → `both`) has no CI-enforced guarantee that a
cloud-side copy, if one exists, gets updated to agree. Recommend tracking
a one-line chore/message to whoever owns the cloud repo so the two copies
don't silently diverge on ownership metadata — this should not block
SLICE-3.

### 4.3 1-hop recall expansion: recommend OUT of v1

Neither cloud nor this design adds automatic 1-hop graph expansion into
`search`/`recall` results — cloud hasn't built it either, so there's no
demand signal to copy, and this repo has a consistent taste for keeping
retrieval's default blast radius small and opt-in (FEAT-453 §10 Q4). Ship
`get_entity_related` as an explicit, separate tool call in v1; revisit
expansion as a v1.1 follow-up only with real usage evidence.

**Confirmed OUT of v1** (per the FEAT body, unchanged): graph algebra,
multi-hop path queries, community detection.

---

## 5. Slice breakdown

| Slice | Scope | Owner mode | Est |
|---|---|---|---|
| **SLICE-1** | Migration 027 (§1). Storage primitive — new `EntityRelationRepo`: insert-with-dedup-guard (§3.4), `getForSubject`/`getForObject`/`getForEntity` with `asOf` (§4.1), cascade wiring into `supersede()` (§3.1). Unit tests. | Independent, starts immediately. | 1.5 dev-days |
| **SLICE-2** | Extraction wiring: `AtomRelationSchema` (predicate enum, §2.1-2.4) + prompt guidance (§2.5) in `src/distill/prompts/extract.ts`, per-triple lenient validation in `05-extract.ts`, stage-8 resolution + write (`08-embed-index.ts`) calling SLICE-1's repo. **Must land inside the merged extraction-prompt FEAT's (D3) builder scope — same file, one owner.** | Coordinated with D3, not autonomous-parallel. | 1.5 dev-days |
| **SLICE-3** | MCP tool surface: `get_entity_related` + `get_entity_timeline` registered in `src/mcp/server.ts` (§4.1-4.2), manifest owner flip in `contracts/manifests/mcp-tools.v1.json`, parity test stays green. | Independent, depends on SLICE-1 only. | 1 dev-day |
| **SLICE-4** | Fixtures/eval + a doctor invocation canary (this repo's dominant failure mode is "built, wired, never invoked" — confirm distill actually produces `entity_relations` rows on real transcripts) + docs. | Independent, last. | 0.5-1 dev-day |
| **SLICE-5 (deferred, not blocking v1)** | Wire extension: additive `relations` array on atom.v2 (or an atom@3 dual-accept, per the additive-vs-major rule in FEAT-453 §2.1 — likely additive, same reasoning) shaped as `{subject, predicate, object, evidence, confidence}` — cloud's own `RelationshipCandidate` has no confidence field (§0.2) but shipping it costs nothing and avoids a second wire round-trip if cloud later decides to consume it. **Cloud-side reader does not exist and is out of this repo's scope** — this slice only prepares the local emit shape. No local shipper wiring until a cloud reader exists to receive it (same "don't wire a dead wire path" discipline FEAT-453 §2.4/§11.3 already applied to its own valid_at/invalid_at fields). | Cross-repo-aware, not autonomous; defer until cloud commits to building the reader. | not estimated — no cloud-side counterpart to build against yet |

**Total (SLICE-1 through 4): ~4.5-5 dev-days**, inside the FEAT body's own
4-6 estimate. SLICE-5 is additive scope discovered by this parity pass, not
part of the original estimate — flagged as deferred rather than folded into
the total, since building it before cloud has a reader would be dead code
by this repo's own "built, wired, never invoked" failure-mode standard
(SLICE-4's canary exists precisely to catch that class of mistake; SLICE-5
would fail its own canary by design until cloud catches up).

---

## 6. Open question 3 — confidence field: **keep**

**Keep it**, as a plain model-reported float, default `0.5`, matching
cloud's column default. Reasoning, refined by §0.2's finding:

1. **Wire parity forces the question anyway**, and local's version is
   arguably *more* honest than cloud's own. Cloud's column is `NOT NULL
   DEFAULT 0.5`, but cloud doesn't currently write a real per-relationship
   confidence value at all — `EntityPersister.cs:203-204` hardcodes `0.7`
   for every server-extracted relationship, regardless of source content.
   Local's extraction call already produces a genuine per-atom confidence
   today (`AtomSchema.confidence`) — asking for one more float per triple
   in the same JSON response is a real (if imperfectly calibrated) signal,
   not a constant. Dropping the column locally wouldn't avoid the
   question; it would just mean local has *less* information than cloud's
   already-modest bar.
2. **Zero marginal extraction cost** — same LLM call, same JSON response
   shape extension as §2.1.
3. **Calibration caveat → don't use it as a hard filter, not → drop it.**
   `get_entity_related` (§4.1) returns `confidence` as metadata only in
   v1 — no query parameter thresholds, no ranking weight derived from it.
   Matches this repo's existing discipline of not hard-coding behavior
   against unvalidated model output (FEAT-453 §7 left overlap-window
   hygiene to application code rather than guessing at a DB constraint
   with no evidence yet).
4. Graphiti's choice not to persist confidence (noted in the FEAT body) is
   not a strong counter-signal — this repo's actual, already-shipped
   cross-repo partner made the opposite call, and cloud parity is this
   design's stated tie-breaker (header).

---

## 7. Summary of deviations from the FEAT body's literal wording

Everything below is a considered deviation, driven by the cloud-parity
verification in §0, not scope creep — listed for the reviewer's attention:

- **Field names:** `relation_type` → `predicate`, `source_memory_id` →
  `evidence_memory_id`, throughout schema, extraction output, and MCP tool
  output — matches cloud exactly so a future sync slice needs no
  translation layer (team-lead directive).
- **Case convention:** `SCREAMING_SNAKE_CASE` → lowercase `snake_case`,
  reversed from this design's own first draft once §0.1 found cloud's
  allow-list check is case-sensitive (`StringComparer.Ordinal`) and
  security-gated (silently drops non-matching predicates with no
  fallback). A case mismatch would have been a 100%-silent-loss failure
  mode the moment any sync path existed.
- **Vocabulary shape:** open vocabulary → closed 10-value seeded enum + a
  local-only `'other'`, matching cloud's exact allow-list rather than a
  larger or differently-cased set — `'other'` rows are excluded from any
  future sync payload (SLICE-5), mirroring cloud's own drop behavior
  deliberately rather than by accident.
- **MCP tool name:** `entity_graph` (FEAT body's literal text) →
  `get_entity_related` + `get_entity_timeline`, matching cloud's
  already-shipped, parity-gated names rather than fragmenting the shared
  verb-naming convention this repo has held for every other cross-repo
  tool.
- **Confidence:** kept, per §6 (the FEAT body flagged this as an open
  question, not a decision — this section closes it, now with the added
  nuance that cloud's own value is a hardcoded constant rather than a
  genuine per-relationship signal).
- **FK cascade:** `ON DELETE CASCADE` (not cloud's `RESTRICT`) on
  `evidence_memory_id`/subject/object entity FKs — the one place this
  design does *not* mirror cloud, because cloud never hard-deletes
  memories/entities while local's ADR-006 `erase_memory` explicitly does;
  `RESTRICT` would break that existing capability outright.
