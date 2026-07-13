---
id: SLICE-427
title: "Migration 027 + EntityRelationRepo (storage primitive, valid-time reuse)"
status: pending
feature: FEAT-481
phase: null
priority: P2
target_release: null
requires_validation: true
risk: medium
created: 2026-07-13
updated: 2026-07-13
effort_points: 2
estimated_tokens: 100000
---
# SLICE-427: Migration 027 + EntityRelationRepo (storage primitive, valid-time reuse)

Implements FEAT-481. See [feature file](../../../backlog/in-progress/FEAT-481.md) for product context.

## Objective

Entity-to-entity relations table — close the 'one join short of a knowledge graph' gap. Add entity_relations (subject_entity_id, relation_type SCREAMING_SNAKE_CASE, object_entity_id, valid_from, valid_to, source_memory_id, confidence) + migration; extend extraction to emit relation triples (coordinate with the merged extraction-prompt FEAT — same prompt surface; borrow Graphiti's possessor-qualification + no-hallucination patterns from the 2026-07-13 competitor research); supersession on edges reusing existing valid-time machinery; v1 retrieval surface = entity_graph MCP tool (neighbors + timeline) + optional 1-hop recall expansion. Explicitly OUT of v1 scope: graph algebra, path queries, community detection. Value: reaches Graphiti/Zep structural starting point while keeping local-first; unlocks honest knowledge-graph positioning currently banned by the language-discipline list; enables temporal relational queries (who owned X when Y happened). Est 4-6 dev-days. Depends-on: extraction-prompt FEAT (shared prompt surface); benefits from BYO/codex extraction flip for triple precision.

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

> WARNING: ACs copied from FEAT-481 and shared across 4 sibling slices — scope per-slice before close

- [ ] AC-1: Given migration 027 applied, When the schema is inspected, Then `entity_relations(id, subject_entity_id, predicate, object_entity_id, evidence_memory_id, source_excerpt NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, valid_from NOT NULL, valid_to, invalidated_by, created_at)` exists with `subject_entity_id`/`object_entity_id`/`evidence_memory_id` as `ON DELETE CASCADE` FKs (not cloud's `RESTRICT`) and indexes on `(subject_entity_id, predicate)`, `(object_entity_id, predicate)`, `valid_to`, and `evidence_memory_id`.
- [ ] AC-2: Given two independent memories each asserting the identical `(subject_entity_id, predicate, object_entity_id)` triple concurrently, When both writes race against `EntityRelationRepo`'s insert path, Then the dedup guard's `INSERT...SELECT...WHERE NOT EXISTS` runs as one atomic prepared statement (single `db.prepare(...).run(...)` call, no separate SELECT-then-INSERT round trip) and at most one currently-valid row survives for that tuple — no TOCTOU duplicate.
- [ ] AC-3: Given a relation sourced from a memory that is later `invalidate()`d, When `getForSubject`/`getForObject`/`getForEntity` is queried with an `asOf` timestamp past that memory's own `valid_to`, Then the relation is excluded from the result — the query `JOIN`s `memories` and computes effective validity as `MIN(entity_relations.valid_to, memories.valid_to)` / `MAX(entity_relations.valid_from, memories.valid_from)` (both `+inf`/open when NULL), not a filter on `entity_relations.valid_to` alone.
- [ ] AC-4: Given a memory is superseded via `supersede()`, When the supersession transaction commits, Then every `entity_relations` row with `evidence_memory_id` = the old memory's id is deleted in that same transaction (mirrors the existing `memory_entities` unlink behavior).
- [ ] AC-5: Given a memory has one or more `entity_relations` rows citing it via `evidence_memory_id` (ADR-006 erasure cascade), When `erase_memory` hard-deletes that memory, Then the citing `entity_relations` rows are removed automatically via `ON DELETE CASCADE` — a query for `entity_relations` rows whose `evidence_memory_id` no longer resolves to a `memories` row returns 0, and `erase_memory` does not fail with an FK-violation error (this is the reason CASCADE was chosen over cloud's `RESTRICT`).
- [ ] AC-6: Given the shared extraction call runs on a chunk (this slice is blocked-by FEAT-479 per DEC-015), When an atom's `relations` field is populated, Then each triple validates against a closed `predicate` enum of exactly `uses | depends_on | replaces | supersedes | mentions | relates_to | part_of | owned_by | assigned_to | created_by | other` (lowercase `snake_case`, matching cloud's case-sensitive allow-list) — a triple whose predicate string doesn't match one of these 11 exact values is dropped from the array, not coerced or auto-mapped to `other`.
- [ ] AC-7: Given an atom's extracted `relations[]` (no-hallucination guard), When a triple's `subject` or `object` name is not present in that same atom's own `entities[]` list, Then the triple is dropped and no new entity is auto-created from the relation side — this rule is scoped to the same atom only (a true relation whose two endpoints are named in two different atoms of the same chunk is an accepted, named v1 limitation, not a bug).
- [ ] AC-8: Given `SLICE-2` is dispatched, When FEAT-479's prompt-architecture slice has not yet landed, Then SLICE-2 is not started as an independent parallel builder against `src/distill/prompts/extract.ts` — it is coordinated inside FEAT-479's builder scope per DEC-015, one owner at a time.
- [ ] AC-9: Given an entity has related triples in the store, When `get_entity_related` is called with `entityId`, optional `asOf`, `direction` (`subject`\|`object`\|`both`, default `both`), and `limit` (default 50, max 500), Then it returns `{ entity_id, relationships: [{ id, subject_entity_id, predicate, object_entity_id, evidence_memory_id, source_excerpt, confidence, valid_from, valid_to }] }` — field names byte-identical to cloud's shipped `get_entity_related` output, requiring zero client-side mapping.
- [ ] AC-10: Given an entity has linked memories, When `get_entity_timeline` is called with `entityId` and an optional `since` bound, Then memories mentioning that entity are returned newest-first, reusing `EntityRepo.memoryIdsForEntities`/`memoryIdsForEntitiesAsOf` — no new table, no new time-tracking machinery.
- [ ] AC-11: Given `get_entity_related` and `get_entity_timeline` are registered in `src/mcp/server.ts`, When the same commit also flips both entries in `contracts/manifests/mcp-tools.v1.json` from `"owner": "cloud"` to `"owner": "both"`, Then `tests/contracts/mcp-tool-manifest-parity.test.ts` passes with no drift between the manifest and the actually-registered tools.
- [ ] AC-12: Given a doctor invocation runs after a real transcript is ingested and distilled (built-wired-never-invoked canary), When the transcript contains extractable entity relations, Then the doctor canary confirms `entity_relations` rows actually exist in the store — not merely that the extraction/storage code compiles and unit-tests pass in isolation.
- [ ] AC-13: Given SLICE-4 lands, When the eval/fixtures suite and docs are updated, Then fixtures cover at least one currently-valid relation, one `as_of`-excluded (superseded/invalidated-source) relation, and one dropped-triple case (unresolved endpoint or invalid predicate); README's MCP tool count and CLAUDE.md are updated to reflect the two new tools and the `entity_relations` table.

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-481 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
