---
id: SLICE-430
title: Fixtures/eval + doctor invocation canary + docs
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
# SLICE-430: Fixtures/eval + doctor invocation canary + docs

Implements FEAT-481. See [feature file](../../../backlog/in-progress/FEAT-481.md) for product context.

## Objective

Entity-to-entity relations table — close the 'one join short of a knowledge graph' gap. Add entity_relations (subject_entity_id, relation_type SCREAMING_SNAKE_CASE, object_entity_id, valid_from, valid_to, source_memory_id, confidence) + migration; extend extraction to emit relation triples (coordinate with the merged extraction-prompt FEAT — same prompt surface; borrow Graphiti's possessor-qualification + no-hallucination patterns from the 2026-07-13 competitor research); supersession on edges reusing existing valid-time machinery; v1 retrieval surface = entity_graph MCP tool (neighbors + timeline) + optional 1-hop recall expansion. Explicitly OUT of v1 scope: graph algebra, path queries, community detection. Value: reaches Graphiti/Zep structural starting point while keeping local-first; unlocks honest knowledge-graph positioning currently banned by the language-discipline list; enables temporal relational queries (who owned X when Y happened). Est 4-6 dev-days. Depends-on: extraction-prompt FEAT (shared prompt surface); benefits from BYO/codex extraction flip for triple precision.

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

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
