---
id: SLICE-429
title: "MCP tools: get_entity_related + get_entity_timeline, manifest owner flip"
status: completed
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
completed_at: 2026-07-13
---
# SLICE-429: MCP tools: get_entity_related + get_entity_timeline, manifest owner flip

Implements FEAT-481. See [feature file](../../../backlog/in-progress/FEAT-481.md) for product context.

## Objective

Entity-to-entity relations table — close the 'one join short of a knowledge graph' gap. Add entity_relations (subject_entity_id, relation_type SCREAMING_SNAKE_CASE, object_entity_id, valid_from, valid_to, source_memory_id, confidence) + migration; extend extraction to emit relation triples (coordinate with the merged extraction-prompt FEAT — same prompt surface; borrow Graphiti's possessor-qualification + no-hallucination patterns from the 2026-07-13 competitor research); supersession on edges reusing existing valid-time machinery; v1 retrieval surface = entity_graph MCP tool (neighbors + timeline) + optional 1-hop recall expansion. Explicitly OUT of v1 scope: graph algebra, path queries, community detection. Value: reaches Graphiti/Zep structural starting point while keeping local-first; unlocks honest knowledge-graph positioning currently banned by the language-discipline list; enables temporal relational queries (who owned X when Y happened). Est 4-6 dev-days. Depends-on: extraction-prompt FEAT (shared prompt surface); benefits from BYO/codex extraction flip for triple precision.

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [x] AC-9: Given an entity has related triples in the store, When `get_entity_related` is called with `entityId`, optional `asOf`, `direction` (`subject`\|`object`\|`both`, default `both`), and `limit` (default 50, max 500), Then it returns `{ entity_id, relationships: [{ id, subject_entity_id, predicate, object_entity_id, evidence_memory_id, source_excerpt, confidence, valid_from, valid_to }] }` — field names byte-identical to cloud's shipped `get_entity_related` output, requiring zero client-side mapping.
- [x] AC-10: Given an entity has linked memories, When `get_entity_timeline` is called with `entityId` and an optional `since` bound, Then memories mentioning that entity are returned newest-first, reusing `EntityRepo.memoryIdsForEntities`/`memoryIdsForEntitiesAsOf` — no new table, no new time-tracking machinery.
- [x] AC-11: Given `get_entity_related` and `get_entity_timeline` are registered in `src/mcp/server.ts`, When the same commit also flips both entries in `contracts/manifests/mcp-tools.v1.json` from `"owner": "cloud"` to `"owner": "both"`, Then `tests/contracts/mcp-tool-manifest-parity.test.ts` passes with no drift between the manifest and the actually-registered tools.

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
