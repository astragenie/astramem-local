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

- [ ] AC-1: Given migration 027 applied, When the schema is inspected, Then `entity_relations(id, subject_entity_id, predicate, object_entity_id, evidence_memory_id, source_excerpt NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, valid_from NOT NULL, valid_to, invalidated_by, created_at)` exists with `subject_entity_id`/`object_entity_id`/`evidence_memory_id` as `ON DELETE CASCADE` FKs (not cloud's `RESTRICT`) and indexes on `(subject_entity_id, predicate)`, `(object_entity_id, predicate)`, `valid_to`, and `evidence_memory_id`.
- [ ] AC-2: Given two independent memories each asserting the identical `(subject_entity_id, predicate, object_entity_id)` triple concurrently, When both writes race against `EntityRelationRepo`'s insert path, Then the dedup guard's `INSERT...SELECT...WHERE NOT EXISTS` runs as one atomic prepared statement (single `db.prepare(...).run(...)` call, no separate SELECT-then-INSERT round trip) and at most one currently-valid row survives for that tuple — no TOCTOU duplicate.
- [ ] AC-3: Given a relation sourced from a memory that is later `invalidate()`d, When `getForSubject`/`getForObject`/`getForEntity` is queried with an `asOf` timestamp past that memory's own `valid_to`, Then the relation is excluded from the result — the query `JOIN`s `memories` and computes effective validity as `MIN(entity_relations.valid_to, memories.valid_to)` / `MAX(entity_relations.valid_from, memories.valid_from)` (both `+inf`/open when NULL), not a filter on `entity_relations.valid_to` alone.
- [ ] AC-4: Given a memory is superseded via `supersede()`, When the supersession transaction commits, Then every `entity_relations` row with `evidence_memory_id` = the old memory's id is deleted in that same transaction (mirrors the existing `memory_entities` unlink behavior).
- [ ] AC-5: Given a memory has one or more `entity_relations` rows citing it via `evidence_memory_id` (ADR-006 erasure cascade), When `erase_memory` hard-deletes that memory, Then the citing `entity_relations` rows are removed automatically via `ON DELETE CASCADE` — a query for `entity_relations` rows whose `evidence_memory_id` no longer resolves to a `memories` row returns 0, and `erase_memory` does not fail with an FK-violation error (this is the reason CASCADE was chosen over cloud's `RESTRICT`).

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
