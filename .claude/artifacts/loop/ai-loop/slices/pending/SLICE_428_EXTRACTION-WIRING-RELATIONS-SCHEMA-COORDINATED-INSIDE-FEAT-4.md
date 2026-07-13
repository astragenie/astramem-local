---
id: SLICE-428
title: "Extraction wiring: relations schema (coordinated inside FEAT-479 builder scope)"
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
# SLICE-428: Extraction wiring: relations schema (coordinated inside FEAT-479 builder scope)

Implements FEAT-481. See [feature file](../../../backlog/in-progress/FEAT-481.md) for product context.

## Objective

Entity-to-entity relations table — close the 'one join short of a knowledge graph' gap. Add entity_relations (subject_entity_id, relation_type SCREAMING_SNAKE_CASE, object_entity_id, valid_from, valid_to, source_memory_id, confidence) + migration; extend extraction to emit relation triples (coordinate with the merged extraction-prompt FEAT — same prompt surface; borrow Graphiti's possessor-qualification + no-hallucination patterns from the 2026-07-13 competitor research); supersession on edges reusing existing valid-time machinery; v1 retrieval surface = entity_graph MCP tool (neighbors + timeline) + optional 1-hop recall expansion. Explicitly OUT of v1 scope: graph algebra, path queries, community detection. Value: reaches Graphiti/Zep structural starting point while keeping local-first; unlocks honest knowledge-graph positioning currently banned by the language-discipline list; enables temporal relational queries (who owned X when Y happened). Est 4-6 dev-days. Depends-on: extraction-prompt FEAT (shared prompt surface); benefits from BYO/codex extraction flip for triple precision.

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] AC-6: Given the shared extraction call runs on a chunk (this slice is blocked-by FEAT-479 per DEC-015), When an atom's `relations` field is populated, Then each triple validates against a closed `predicate` enum of exactly `uses | depends_on | replaces | supersedes | mentions | relates_to | part_of | owned_by | assigned_to | created_by | other` (lowercase `snake_case`, matching cloud's case-sensitive allow-list) — a triple whose predicate string doesn't match one of these 11 exact values is dropped from the array, not coerced or auto-mapped to `other`.
- [ ] AC-7: Given an atom's extracted `relations[]` (no-hallucination guard), When a triple's `subject` or `object` name is not present in that same atom's own `entities[]` list, Then the triple is dropped and no new entity is auto-created from the relation side — this rule is scoped to the same atom only (a true relation whose two endpoints are named in two different atoms of the same chunk is an accepted, named v1 limitation, not a bug).
- [ ] AC-8: Given `SLICE-2` is dispatched, When FEAT-479's prompt-architecture slice has not yet landed, Then SLICE-2 is not started as an independent parallel builder against `src/distill/prompts/extract.ts` — it is coordinated inside FEAT-479's builder scope per DEC-015, one owner at a time.

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
