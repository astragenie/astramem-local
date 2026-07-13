# FEAT-481: Entity-to-Entity Relations — Design

**Status:** draft for architect-reviewer
**Date:** 2026-07-13
**Author:** architect (this session)
**Origin:** `.claude/artifacts/loop/backlog/pending/FEAT-481.md`; scoped by
`docs/superpowers/specs/2026-07-13-memory-quality-design.md` §3.3 (D3 coordination).
**Related:** FEAT-402 (`entities`/`memory_entities`, migration 012), FEAT-453
(fact-level valid-time on `memory_entities`, migration 023,
`docs/specs/FEAT-453-bitemporal-design.md` — the pattern this design reuses
throughout), the merged extraction-prompt FEAT (D3, same prompt surface).

## 0. Load-bearing finding: cloud already ships this (FEAT-285/M9)

Before any new design: the sibling `memory` repo (`C:\work\mega\memory`) already
has a **shipped, production** entity-relationship feature —
`AstraMemory.Persistence.Entities.EntityRelationshipEntity` (table
`astramemory.entity_relationships`), `IEntityRelationshipRepository`, and two
MCP tools (`get_entity_related`, `get_entity_timeline`,
`src/AstraMemory.Mcp/Tools/EntityTools.cs`) already registered in this repo's
own `contracts/manifests/mcp-tools.v1.json` as **cloud-owned, stable**. This
was not visible from the FEAT body or the memory-quality design doc, and it
changes three of the six deliverables below from "invent a shape" to "mirror
an existing shape for wire parity." Cloud's schema:

```csharp
Guid Id; Guid TenantId; Guid SubjectEntityId; string Predicate;
Guid ObjectEntityId; Guid EvidenceMemoryId; string SourceExcerpt;
double Confidence = 0.5; DateTimeOffset ValidFrom; DateTimeOffset? ValidTo;
Guid? InvalidatedBy; DateTimeOffset? InvalidatedAt; DateTimeOffset CreatedAt;
```

Key ground truth this design leans on:
- `predicate` is a **plain string column** (`HasMaxLength(128)`), no enum, no
  case constraint — local's SCREAMING_SNAKE_CASE convention is compatible
  (it's a string value, not a schema decision) but must not be a DB `CHECK`.
- `confidence` **is persisted**, default `0.5`, clamped `[0,1]` at write time
  (`EntityRelationshipRepository.cs:55`) — this answers open question 3
  directly (§6).
- Dedup is **write-time only** (`INSERT ... WHERE NOT EXISTS` on
  `(tenant, subject, predicate, object)` among currently-valid rows,
  `EntityRelationshipRepository.cs:32-45`) — no DB uniqueness constraint.
  Cloud's own comment: *"Future supersession is handled by a separate API
  (out of scope for v1)"* — cloud hasn't built edge supersession either.
- `InvalidatedBy` is a **nullable self-FK** placeholder, `ON DELETE SET NULL`
  — wired in the schema, not yet populated by any code path found.
- One `evidence_memory_id`/`source_excerpt` per row (singular, required) —
  matches the FEAT body's singular `source_memory_id`.
- Query shape: `direction: subject | object | both`, optional `asOf`,
  "currently valid" = `valid_to IS NULL OR valid_to > now()`.

Implication for this design: local's v1 should be built as **the local mirror
of cloud's already-shipped shape**, not a parallel invention. Naming,
retrieval contract, and confidence-keep are decided below with that as the
tie-breaker whenever the FEAT body's wording and cloud's shipped shape
diverge.

---

## 1. `entity_relations` schema — migration 027

Latest migration is `026-proxy-usage.sql`; this is **027**.

```sql
-- 027: entity-to-entity relation triples (FEAT-481).
--
-- Local mirror of the sibling `memory` repo's already-shipped
-- astramemory.entity_relationships (FEAT-285/M9) — see
-- docs/specs/FEAT-481-design.md §0 for the cross-repo shape this was built
-- to stay wire-compatible with. subject_entity_id/object_entity_id follow
-- the same entities(id) FK + ON DELETE CASCADE convention memory_entities
-- already uses (012-entities.sql); source_memory_id follows the same
-- memories(id) FK + ON DELETE CASCADE convention every memory-scoped child
-- table uses (erase() hard-deletes memories, cascade follows automatically,
-- foreign_keys=ON for every connection — src/storage/db.ts).
--
-- No composite UNIQUE(subject_entity_id, relation_type, object_entity_id):
-- cloud's own repository doesn't enforce this at the DB layer either
-- (EntityRelationshipRepository.cs UpsertAsync — a write-time
-- INSERT...WHERE NOT EXISTS guard, not a constraint) because two different
-- source memories independently asserting the same triple is corroborating
-- evidence, not a conflict — see design doc §3 for why a DB constraint
-- would be wrong here, unlike memory_entities' partial-unique open-window
-- index (023's problem was one specific pair carrying multiple time
-- windows; this table's problem is many memories corroborating one
-- semantic fact, a different shape entirely).
--
-- valid_from/valid_to: same half-open valid-time convention as
-- memories.valid_from/valid_to (006) and memory_entities.valid_at/invalid_at
-- (023). valid_from is always populated at write time (extracted stated
-- date if the source text gave one, else the source memory's own
-- valid_from/captured_at) — never left NULL, matching both
-- memories.valid_from's own insert-time convention (006's comment: "New
-- rows set valid_from = created_at at insert time") and cloud's now()
-- default. valid_to NULL = not known to have stopped being true.
--
-- confidence: kept (see design doc §6) — model-reported [0,1], defaults to
-- 0.5 when the extractor omits it, clamped at the storage-layer write path
-- exactly like cloud's Math.Clamp(confidence, 0.0, 1.0) equivalent.
--
-- Zero interaction with vec0 tables — no FLOAT[N] column, no
-- getVecSchemaDim()/DEFAULT_EMBED_DIM touch (CLAUDE.md "Do NOT" section).

CREATE TABLE entity_relations (
  id TEXT PRIMARY KEY,
  subject_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  object_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_excerpt TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  invalidated_by TEXT REFERENCES entity_relations(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

-- Direction lookups (mirrors cloud's ix_entity_relationships_subject/object,
-- EntityRelationshipEntityConfiguration.cs:28-32).
CREATE INDEX idx_entity_relations_subject ON entity_relations(subject_entity_id, relation_type);
CREATE INDEX idx_entity_relations_object ON entity_relations(object_entity_id, relation_type);

-- Temporal filtering: currently-valid scan is the default read path for
-- both directions (get_entity_related with no as_of) — index the common
-- "still open" predicate directly rather than relying on a table scan +
-- filter, same rationale as idx_memory_entities_open_window (023) even
-- though this is a plain (non-unique, non-partial-on-uniqueness) index here.
CREATE INDEX idx_entity_relations_valid_to ON entity_relations(valid_to);

-- Reverse lookup for the source-memory-scoped cascade (supersede()/erase()
-- need "every relation row sourced from memory X" — same shape
-- unlinkMemory() already needs for memory_entities, entities.ts:127-129).
CREATE INDEX idx_entity_relations_source_memory ON entity_relations(source_memory_id);
```

**FK/cascade decisions:**
- `subject_entity_id`/`object_entity_id` → `entities(id) ON DELETE CASCADE`.
  In practice this is dead code today: `EntityRepo` has no delete/erase
  method (verified — `src/storage/entities.ts` has no `DELETE FROM
  entities`), so entities are immortal once created. `CASCADE` is chosen for
  consistency with `memory_entities`' identical FK (012-entities.sql:32) and
  costs nothing; if an entity-merge/dedup operation is ever added, cascade
  deletion of orphaned relation rows is the wrong behavior for a *rename*
  (the row should be repointed, not deleted) — call this out explicitly so
  a future entity-merge FEAT doesn't get surprised by an implicit cascade
  wipe. No entity merge/rename operation exists in this codebase today
  (`normalizeEntityName` dedup happens entirely at *creation* time via the
  `entities.name UNIQUE` constraint, `src/entity/normalize.ts` — there is no
  later merge-two-existing-entities path to reconcile against).
- `source_memory_id` → `memories(id) ON DELETE CASCADE` — same as every
  other memory-scoped child row; `erase()`'s hard delete follows
  automatically (matches `memory_entities`' existing AC-3 cascade note,
  012-entities.sql:15-18).
- `invalidated_by` → self-FK, `ON DELETE SET NULL` — mirrors cloud's
  identical column exactly (`EntityRelationshipEntityConfiguration.cs:49-52`),
  kept as a placeholder for a future explicit-correction API; nothing writes
  it in v1 (see §3).

---

## 2. Extraction integration

### 2.1 Same call, nested per-atom (not a top-level array)

Add an optional `relations` field **inside `AtomSchema`**, parallel to the
existing `entities` field (`src/distill/prompts/extract.ts:37-46`), not a
new top-level sibling of `atoms`:

```ts
export const AtomRelationSchema = z.object({
  subject: z.string().min(1).max(100),
  relation_type: z.string().min(1).max(64),
  object: z.string().min(1).max(100),
  valid_at: z.string().optional(),
  invalid_at: z.string().optional(),
});

// on AtomSchema:
relations: z.array(AtomRelationSchema).optional(),
```

**Why nested, not top-level:** a memory row doesn't exist until stage 8
(`08-embed-index.ts`, one row per `NormalizedMemory` post stage 7) — a
chunk-level top-level `relations` array would have no unambiguous
`source_memory_id` once a chunk yields multiple atoms/memories. Nesting
inside the atom that names the relation gives every triple exactly one
future memory row to attach to, for free, with no correlation problem (same
reasoning FEAT-453 §2.3 used to reject a parallel `entity_validity` array in
favor of inlining onto `entities[]` items).

**No extra LLM call, no extra token budget line item beyond headroom:** same
`callExtract` call (`05-extract.ts:103-120`); `maxTokens: 1500` may need a
modest bump (est. +200–300) once relations are added to the JSON shape —
budget check happens in slice 2 (§5) against real output, not asserted here.

### 2.2 No-hallucination constraint: subject/object must be named in the same atom

`subject`/`object` are matched by name against **this atom's own
`entities[]` list** (case/whitespace-normalized via the existing
`normalizeEntityName` seam) — a triple naming something the model didn't
already commit to listing as an entity in the same atom is dropped, not
auto-created. This is the concrete "no-hallucination" guardrail: it
structurally prevents the model inventing a relation between two things it
never named as entities, at zero extra validation cost (the entities list
is already being validated/coerced in the same pass). This is stricter than
Graphiti's own approach (which allows edge endpoints not otherwise tracked
as first-class entities) but matches this repo's existing taste for keeping
the entity registry a deliberate, curated set (`entities.ts` has no
freeform "mention" table, unlike cloud's separate `EntityMentionRepository`)
— answers the design point 2 "unresolvable endpoints" question:
**drop the triple, never auto-create an entity from the relation side.**

### 2.3 Validation: lenient per-triple, same idiom as atoms/entities

`AtomRelationSchema` is validated the same way `AtomEntitySchema` already is
— parse the wrapper leniently, then filter: a malformed triple (empty
`relation_type`, `subject === object`, or an unresolvable endpoint per §2.2)
is dropped from the array, never rejects the whole atom or throws
`TransientError`. Mirrors `coerceEntityKinds` + the `AtomSchema.safeParse`
filter already in `05-extract.ts:131-189` — add a sibling
`resolveAtomRelations(atom, resolvedEntityIds)` step at stage 8 (not stage
5, since name→id resolution needs the already-upserted entity ids for this
atom) that filters relations whose subject/object name isn't in the
resolved map.

### 2.4 `relation_type` normalization: open vocabulary, SCREAMING_SNAKE_CASE convention, no enum

Matches cloud's plain `string` `predicate` column (§0) — no DB `CHECK`, no
zod `z.enum`. Add a `normalizeRelationType` seam
(`src/entity/normalize.ts`, sibling to `normalizeEntityName`): uppercase +
non-alphanumeric runs collapsed to `_` + trim leading/trailing `_`
(`"reports to"` → `"REPORTS_TO"`, `"depends-on"` → `"DEPENDS_ON"`). This is
a normalization convention enforced at the write seam, not a closed enum —
open vocabulary was chosen over a seeded enum + `'other'` because: (a) cloud
already ships an open string column, so a local enum would need constant
re-sync against cloud's unconstrained vocabulary or silently reject valid
predicates cloud would accept; (b) the extraction prompt (owned by D3, not
this FEAT) is where recall-relevant vocabulary discipline actually lives —
few-shot examples in the shared prompt should model 5-10 common predicates
(`REPORTS_TO`, `DEPENDS_ON`, `OWNS`, `WORKS_ON`, `PART_OF`, `CAUSED`,
`REPLACED`, `APPROVED_BY`) without a hard allow-list, same "open vocabulary,
disciplined by examples" pattern the entity `kind` enum explicitly does
*not* use (kind IS a closed enum, `EntityKindSchema`) — the difference is
intentional: entity *kinds* are a small, stable, cross-repo-shared taxonomy;
relation *types* are an open long tail no taxonomy could usefully close
without constant maintenance, exactly the same judgment cloud's own schema
already made.

### 2.5 Prompt guidance: possessor qualification (D3 ownership, this FEAT's slice lands inside it)

The triples prompt addition belongs in the **same shared skeleton** D3 is
already building (`src/distill/prompts/extract.ts`, per the memory-quality
design doc §3.2/§3.3 — "same file, one owner"). Guidance to add to that
shared prompt for the `relations` field specifically: resolve pronouns and
possessives to the actual named entity before writing subject/object (e.g.
"her deploy script" → subject is the actual named person/agent entity, not
the pronoun; "the team's repo" → object is the specific named repo entity,
not a vague possessive phrase) — this is the same "self-contained, pronouns
resolved" richness rule D3 already decided for atom text (§3.2 bullet 1),
applied to relation endpoints. This design doc specifies the *requirement*;
the actual prompt copy is D3's builder's deliverable, not duplicated here.

---

## 3. Edge supersession semantics

**v1 is deliberately modest — matching cloud's own "out of scope for v1"
stance (§0), not a gap unique to local:**

1. **Source-memory lifecycle cascade (reuses existing valid-time machinery,
   zero new lifecycle code):**
   - `supersede()` (`src/storage/memory-events.ts:272`) already hard-deletes
     the old memory's `memory_entities` rows in the same transaction (AC-3,
     `entities.ts:127-129`). Extend this **same transaction** to also
     `DELETE FROM entity_relations WHERE source_memory_id = ?` for the old
     memory — a one-line addition next to the existing `unlinkMemory` call,
     not a new mechanism.
   - `invalidate()` (`memory-events.ts:218`) needs **no new code**, exactly
     per the FEAT-453 §3.1 precedent: at query time, a relation's effective
     `valid_to` is `MIN(entity_relations.valid_to, source_memory.valid_to)`
     (both treated as `+inf` when NULL). A relation sourced from a memory
     that gets `invalidate()`d is automatically excluded from any `as_of`
     query past the memory's own `valid_to`, with zero change to
     `invalidate()`'s implementation — same trick, same justification,
     as FEAT-453's already-shipped `memoryIdsForEntitiesAsOf`.
2. **A contradicting triple (e.g. a later session says "Bob no longer
   reports to Alice"):** **out of v1**, matching cloud. This is a
   distill/consolidation-judge problem (same shape as FEAT-456's
   memory-level contradiction judge), not a storage-layer concern — no
   automatic edge-closing on semantic contradiction in this slice. The
   schema supports it later (`invalidated_by` self-FK is already there,
   unpopulated) without a migration.
3. **Explicit stated end-date on the same triple** (extraction found
   `invalid_at` per §2.1): written directly onto the new row's `valid_to` —
   this is the one case where a "closing" signal comes from extraction
   itself, no different from how `memory_entities`' `valid_at`/`invalid_at`
   hints already work (FEAT-453 §4).
4. **Idempotency/dedup — same triple re-extracted from another session:**
   mirror cloud's write-time guard exactly
   (`EntityRelationshipRepository.cs:32-45`): before inserting, check
   whether a **currently-valid** row already exists for the exact
   `(subject_entity_id, relation_type, object_entity_id)` tuple; skip the
   insert if so (`INSERT INTO entity_relations (...) SELECT ... WHERE NOT
   EXISTS (SELECT 1 FROM entity_relations WHERE subject_entity_id = ? AND
   relation_type = ? AND object_entity_id = ? AND valid_to IS NULL)`).
   **Deliberately not a DB constraint** (see migration comment, §1) — two
   independent memories asserting the same triple is corroborating evidence
   worth keeping distinct rows for (different `source_memory_id`,
   different `confidence`), it's only the *write-time flood* of the exact
   same tuple from re-processing the same content that's being guarded
   against, and a plain conditional INSERT is cheaper and matches cloud's
   own chosen mechanism rather than reinventing one.

---

## 4. v1 retrieval surface

### 4.1 Tool naming — deviate from the FEAT body's literal `entity_graph`, use cloud's already-shipped names

**Recommendation: implement `get_entity_related` and `get_entity_timeline`
locally**, not a new `entity_graph` tool. Justification: `mcp-tools.v1.json`
is a **parity-CI-gated cross-repo source of truth**
(`tests/contracts/mcp-tool-manifest-parity.test.ts` fails on any drift
between the manifest and the MCP server's actually-registered tool names,
`src/mcp/server.ts` header). Both names already exist in that manifest as
`"owner": "cloud", "status": "stable"` (§0). Inventing a third local-only
name (`entity_graph`) would fragment the naming convention this repo has
consistently followed for every other shared verb (`search_memory`,
`remember`, `invalidate_memory`, `submit_feedback` are all `"owner": "both"`
today) for no benefit — a client (plugin or otherwise) that already knows
`get_entity_related` from cloud shouldn't have to learn a second name for
the same concept when talking to the local daemon. Slice 3 (§5) flips both
manifest entries from `"cloud"` to `"both"` and registers matching tools in
`src/mcp/server.ts`.

**`get_entity_related` contract** (mirrors `EntityTools.cs:67-143` exactly):

```
Input:  entityId (uuid), asOf? (ISO-8601), direction? ('subject'|'object'|'both', default 'both'), limit? (default 50, max 500)
Output: { entity_id, relationships: [{ id, subject_entity_id, relation_type, object_entity_id, source_memory_id, source_excerpt, confidence, valid_from, valid_to }] }
```

`asOf` support: same `parseAsOf` helper already imported into
`src/mcp/server.ts:55` for search's `as_of` — no new date-parsing code.
"Currently valid" default (no `asOf`): `valid_to IS NULL OR valid_to >
now()`, identical semantics to cloud.

**`get_entity_timeline` contract** (mirrors `EntityTools.cs:147-196`):
memories mentioning the entity, newest first, optional `since` lower bound.
This is **not new machinery** — it's `EntityRepo.memoryIdsForEntities`
(`entities.ts:199-211`, already time-aware via
`memoryIdsForEntitiesAsOf` when a bound is supplied) joined back to
`memories` for `content`/`type`/`created_at`, exposed as an MCP tool for the
first time. No new table, no new repo method beyond a small
`listMemoriesForEntity(entityId, since?, limit)` wrapper.

### 4.2 1-hop recall expansion: recommend OUT of v1

Neither cloud nor this design adds automatic 1-hop graph expansion into
`search`/`recall` results. Reasoning: (a) cloud — the only other system with
this exact table shipped — hasn't built it either, so there's no proven
demand signal to copy; (b) this repo has a consistent, deliberate taste for
keeping retrieval's default blast radius small and opt-in (FEAT-453 §10 Q4:
fact-level validity "only enters selection when a caller supplies **both**
`filters.entity` *and* `filters.as_of` together" — never a default-on
expansion of the result set). Automatic 1-hop expansion would silently
change ranking/recall-quality-harness baselines (ADR-005) for every existing
query the moment it shipped — exactly the kind of blast-radius risk this
repo's own precedent avoids. Recommend: ship `get_entity_related` as an
explicit, separate tool call in v1; revisit 1-hop expansion as a v1.1
follow-up only if real usage of `get_entity_related` shows a recurring
manual "search, then look up relations, then re-search" pattern worth
automating.

**Confirmed OUT of v1** (per the FEAT body, unchanged by this design): graph
algebra, multi-hop path queries, community detection.

---

## 5. Slice breakdown

| Slice | Scope | Owner mode | Est |
|---|---|---|---|
| **SLICE-1** | Migration 027 (§1). Storage primitive — new `EntityRelationRepo` (or a new section of `EntityRepo`, builder's call): insert-with-dedup-guard (§3.4), `getForSubject`/`getForObject`/`getForEntity` with `asOf` (§4.1), cascade wiring into `supersede()` (§3.1). Unit tests. | Independent, can start immediately (no dependency on D3). | 1.5 dev-days |
| **SLICE-2** | Extraction wiring: `AtomRelationSchema` + prompt guidance (§2.1-2.5) in `src/distill/prompts/extract.ts`, per-triple lenient validation in `05-extract.ts`, stage-8 resolution + write (`08-embed-index.ts`) calling SLICE-1's repo. **Must land inside the merged extraction-prompt FEAT's (D3) builder scope — same file, one owner** (constitution rule 1). Do not dispatch this as a separate parallel builder against `extract.ts` while D3 is in flight. | **Coordinated with D3**, not autonomous-parallel. | 1.5 dev-days (shared substantially with D3's own prompt-authoring cost) |
| **SLICE-3** | MCP tool surface: `get_entity_related` + `get_entity_timeline` registered in `src/mcp/server.ts` (§4.1), manifest owner flip `cloud`→`both` for both entries in `contracts/manifests/mcp-tools.v1.json`, parity test stays green. | Independent, depends on SLICE-1 only. | 1 dev-day |
| **SLICE-4** | Fixtures/eval + a doctor invocation canary (this repo's dominant failure mode is "built, wired, never invoked" — add a cheap canary confirming distill actually produces `entity_relations` rows on real transcripts, not just that the code compiles) + docs (README MCP tool count, CLAUDE.md). | Independent, last. | 0.5-1 dev-day |

**Total: ~4.5-5 dev-days**, inside the FEAT body's own 4-6 estimate.
SLICE-2's overlap note directly answers design point 5's ask: the triples
prompt work is real work inside D3's scope, not a separately-dispatchable
parallel slice — a second builder touching `extract.ts` concurrently with
D3 would violate the one-file-one-owner scope-discipline rule.

---

## 6. Open question 3 — confidence field: **keep**

**Keep it**, as a plain model-reported float, default `0.5`, clamped
`[0,1]` at the storage write path. Reasoning:

1. **Wire parity forces the question anyway.** Cloud's
   `EntityRelationshipEntity.Confidence` is `NOT NULL` with a DB default of
   `0.5` (§0). Whether or not local's extraction populates a real value,
   *something* has to be sent on the wire once a shipper for this table
   exists — dropping the local column doesn't avoid the field, it just
   moves the "what value do we send" question to the shipper with less
   information available at that point than at extraction time.
2. **Zero marginal extraction cost.** The same LLM call already emits a
   `confidence` field per-atom (`AtomSchema.confidence`,
   `05-extract.ts`/`extract.ts:41`) — asking for one more float per triple
   in the same JSON response is not a new capability, just a new field on
   an already-solved shape.
3. **The calibration caveat is real but doesn't argue for dropping the
   column — it argues against *using it as a hard filter*.** Models are
   known to be poorly calibrated (the design doc's own framing). Mitigation
   chosen here: `get_entity_related` (§4.1) returns `confidence` as
   **metadata only** in v1 — no query parameter thresholds or filters on
   it, no ranking weight derived from it. This defers any confidence-gated
   behavior to a future pass once real distribution data exists from
   production extraction, matching this repo's existing discipline of not
   hard-coding behavior against unvalidated model output (e.g. FEAT-453 §7
   leaving overlap-window hygiene to application code rather than guessing
   at a DB constraint for a case with no evidence yet).
4. Graphiti's choice not to persist a confidence field (noted in the FEAT
   body) is not a strong counter-signal here — Graphiti's design constraints
   are its own, and this repo's actual, already-shipped cross-repo partner
   (cloud, §0) made the opposite call and this design follows the partner
   that has to interoperate on the wire.

---

## 7. Summary of deviations from the FEAT body's literal wording

For the reviewer's attention — everything below is a considered deviation
from FEAT-481.md's literal text, driven by the §0 finding, not scope creep:

- MCP tool name: `entity_graph` → `get_entity_related` + `get_entity_timeline`
  (§4.1), to match cloud's already-shipped, parity-gated names.
- `relation_type` case convention (SCREAMING_SNAKE_CASE) is kept exactly as
  asked, but implemented as a normalization seam at the write path, not a DB
  `CHECK` or zod enum — needed for wire compatibility with cloud's open
  `string` column (§2.4).
- Confidence: kept, per §6 (the FEAT body flagged this as an open question,
  not a decision — this section closes it).
