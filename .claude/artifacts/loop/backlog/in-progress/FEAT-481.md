---
id: FEAT-481
status: in-progress
priority: P2
category: feature
target_release: null
created: 2026-07-13
updated: 2026-07-13
depends_on: []
slices: [SLICE-427, SLICE-428, SLICE-429, SLICE-430]
derived_from: null
pm_customer_impact: 0.4
pm_effort_estimate: 0.65
pm_strategic_alignment: 0.65
pm_technical_risk: 0.6
pm_dependency_depth: 0.4
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-13
autonomous_safe: false
triage_notes: "compositePriority derivation via the exact formula in `pm-scorer.mts` (read this session): P0 requires impact≥0.8 — fails (0.40). P1 requires (impact≥0.7 AND alignment≥0.6) — fails (impact 0.40) — OR (alignment≥0.8 AND effort≤0.4) — fails (alignment 0.65, effort 0.65). P3 requires effort≥0.7 AND impact≤0.3 — fails (effort 0.65 < 0.70). Falls through to P2. autonomousSafe computed via the same file's `computeAutonomousSafe`: technical_risk 0.60 is not > 0.6 (passes), dependency_depth 0.40 is not > 0.6 (passes), but effort_estimate 0.65 IS > 0.6 → forces autonomousSafe=false regardless of the other three, independent of and consistent with the FEAT-168 decomposition-gate requirement that a ≥8-point FEAT ship as slices, not a single autonomous dispatch. technical_risk banded at 0.60 (low end of the 0.6-0.8 band: 'new dependency, cross-module reach, OR schema/data-shape change' — satisfied by cross-module reach across storage/distill/mcp AND a new migration/table; landed at the LOW end because the schema change is a clean additive CREATE TABLE with no existing-data reshape, no vec0 interaction, and the single highest-risk item from the prior pass — two builders racing the same prompt file — is now resolved into a coordinated single-owner dependency by DEC-015, not a live collision). Weighted composite score (informational, `computeWeightedCompositeScore`): 0.40×0.35 + 0.65×0.30 + (1-0.65)×0.20 + (1-0.60)×0.10 + (1-0.40)×0.05 = 0.140 + 0.195 + 0.070 + 0.040 + 0.030 = 0.475. FEAT-168 decomposition gate: effort_estimate 0.65 maps via `pm-effort-mapper.mts`'s BANDS table (0.6 ≤ x < 0.85 → 8 points) to effort_points=8, which is ≥8 and mandatorily requires either proposed_slices (option 1) or needs-review (option 2). Per this task's explicit instruction, taking OPTION 1 using the architect's already-produced 4-slice breakdown (`docs/specs/FEAT-481-design.md` §5) rather than needs-review — the prior pass's own recommended path ('human/architect resolves ownership + confidence-field question, THEN PM re-scores with a clean slice boundary') has now literally happened: DEC-015 resolved ownership, the design doc's §6 resolved confidence, and the design doc itself supplies the clean slice boundary this pass uses verbatim. P2 (not P1) despite improved strategic_alignment because customer_impact remains capped below the P1 threshold (0.7) — the demand signal, while now concrete (CI-gated manifest parity, cloud already shipping this), is still an internal-parity argument rather than evidence of acute external user pain, and effort_estimate at 0.65 fails the P1 alternate path's effort≤0.4 requirement too."
proposed_slices:
  - id_suffix: -SLICE-1
    title: "Migration 027 + EntityRelationRepo (storage primitive, valid-time reuse)"
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-2
    title: "Extraction wiring: relations schema (coordinated inside FEAT-479 builder scope)"
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-3
    title: "MCP tools: get_entity_related + get_entity_timeline, manifest owner flip"
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-4
    title: Fixtures/eval + doctor invocation canary + docs
    points: 2
    estimated_tokens: 100000
started_at: 2026-07-13
slices_complete: [SLICE-427]
---
## Description

Entity-to-entity relations table — close the 'one join short of a knowledge graph' gap. Add entity_relations (subject_entity_id, relation_type SCREAMING_SNAKE_CASE, object_entity_id, valid_from, valid_to, source_memory_id, confidence) + migration; extend extraction to emit relation triples (coordinate with the merged extraction-prompt FEAT — same prompt surface; borrow Graphiti's possessor-qualification + no-hallucination patterns from the 2026-07-13 competitor research); supersession on edges reusing existing valid-time machinery; v1 retrieval surface = entity_graph MCP tool (neighbors + timeline) + optional 1-hop recall expansion. Explicitly OUT of v1 scope: graph algebra, path queries, community detection. Value: reaches Graphiti/Zep structural starting point while keeping local-first; unlocks honest knowledge-graph positioning currently banned by the language-discipline list; enables temporal relational queries (who owned X when Y happened). Est 4-6 dev-days. Depends-on: extraction-prompt FEAT (shared prompt surface); benefits from BYO/codex extraction flip for triple precision.

## Acceptance criteria (Given / When / Then)

Derived from `docs/specs/FEAT-481-design.md` (amended, commit 5f8e43f). Field
names below are the amended ones (`predicate`, `evidence_memory_id`), not the
FEAT description's original `relation_type`/`source_memory_id` wording.

- AC-1: Given migration 027 applied, When the schema is inspected, Then `entity_relations(id, subject_entity_id, predicate, object_entity_id, evidence_memory_id, source_excerpt NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, valid_from NOT NULL, valid_to, invalidated_by, created_at)` exists with `subject_entity_id`/`object_entity_id`/`evidence_memory_id` as `ON DELETE CASCADE` FKs (not cloud's `RESTRICT`) and indexes on `(subject_entity_id, predicate)`, `(object_entity_id, predicate)`, `valid_to`, and `evidence_memory_id`.
- AC-2: Given two independent memories each asserting the identical `(subject_entity_id, predicate, object_entity_id)` triple concurrently, When both writes race against `EntityRelationRepo`'s insert path, Then the dedup guard's `INSERT...SELECT...WHERE NOT EXISTS` runs as one atomic prepared statement (single `db.prepare(...).run(...)` call, no separate SELECT-then-INSERT round trip) and at most one currently-valid row survives for that tuple — no TOCTOU duplicate.
- AC-3: Given a relation sourced from a memory that is later `invalidate()`d, When `getForSubject`/`getForObject`/`getForEntity` is queried with an `asOf` timestamp past that memory's own `valid_to`, Then the relation is excluded from the result — the query `JOIN`s `memories` and computes effective validity as `MIN(entity_relations.valid_to, memories.valid_to)` / `MAX(entity_relations.valid_from, memories.valid_from)` (both `+inf`/open when NULL), not a filter on `entity_relations.valid_to` alone.
- AC-4: Given a memory is superseded via `supersede()`, When the supersession transaction commits, Then every `entity_relations` row with `evidence_memory_id` = the old memory's id is deleted in that same transaction (mirrors the existing `memory_entities` unlink behavior).
- AC-5: Given a memory has one or more `entity_relations` rows citing it via `evidence_memory_id` (ADR-006 erasure cascade), When `erase_memory` hard-deletes that memory, Then the citing `entity_relations` rows are removed automatically via `ON DELETE CASCADE` — a query for `entity_relations` rows whose `evidence_memory_id` no longer resolves to a `memories` row returns 0, and `erase_memory` does not fail with an FK-violation error (this is the reason CASCADE was chosen over cloud's `RESTRICT`).
- AC-6: Given the shared extraction call runs on a chunk (this slice is blocked-by FEAT-479 per DEC-015), When an atom's `relations` field is populated, Then each triple validates against a closed `predicate` enum of exactly `uses | depends_on | replaces | supersedes | mentions | relates_to | part_of | owned_by | assigned_to | created_by | other` (lowercase `snake_case`, matching cloud's case-sensitive allow-list) — a triple whose predicate string doesn't match one of these 11 exact values is dropped from the array, not coerced or auto-mapped to `other`.
- AC-7: Given an atom's extracted `relations[]` (no-hallucination guard), When a triple's `subject` or `object` name is not present in that same atom's own `entities[]` list, Then the triple is dropped and no new entity is auto-created from the relation side — this rule is scoped to the same atom only (a true relation whose two endpoints are named in two different atoms of the same chunk is an accepted, named v1 limitation, not a bug).
- AC-8: Given `SLICE-2` is dispatched, When FEAT-479's prompt-architecture slice has not yet landed, Then SLICE-2 is not started as an independent parallel builder against `src/distill/prompts/extract.ts` — it is coordinated inside FEAT-479's builder scope per DEC-015, one owner at a time.
- AC-9: Given an entity has related triples in the store, When `get_entity_related` is called with `entityId`, optional `asOf`, `direction` (`subject`\|`object`\|`both`, default `both`), and `limit` (default 50, max 500), Then it returns `{ entity_id, relationships: [{ id, subject_entity_id, predicate, object_entity_id, evidence_memory_id, source_excerpt, confidence, valid_from, valid_to }] }` — field names byte-identical to cloud's shipped `get_entity_related` output, requiring zero client-side mapping.
- AC-10: Given an entity has linked memories, When `get_entity_timeline` is called with `entityId` and an optional `since` bound, Then memories mentioning that entity are returned newest-first, reusing `EntityRepo.memoryIdsForEntities`/`memoryIdsForEntitiesAsOf` — no new table, no new time-tracking machinery.
- AC-11: Given `get_entity_related` and `get_entity_timeline` are registered in `src/mcp/server.ts`, When the same commit also flips both entries in `contracts/manifests/mcp-tools.v1.json` from `"owner": "cloud"` to `"owner": "both"`, Then `tests/contracts/mcp-tool-manifest-parity.test.ts` passes with no drift between the manifest and the actually-registered tools.
- AC-12: Given a doctor invocation runs after a real transcript is ingested and distilled (built-wired-never-invoked canary), When the transcript contains extractable entity relations, Then the doctor canary confirms `entity_relations` rows actually exist in the store — not merely that the extraction/storage code compiles and unit-tests pass in isolation.
- AC-13: Given SLICE-4 lands, When the eval/fixtures suite and docs are updated, Then fixtures cover at least one currently-valid relation, one `as_of`-excluded (superseded/invalidated-source) relation, and one dropped-triple case (unresolved endpoint or invalid predicate); README's MCP tool count and CLAUDE.md are updated to reflect the two new tools and the `entity_relations` table.

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.
## Proposed slices (PM decomposition)

- SLICE-1: Migration 027 + EntityRelationRepo (storage primitive, valid-time reuse) (2 pts)
- SLICE-2: Extraction wiring: relations schema (coordinated inside FEAT-479 builder scope) (2 pts)
- SLICE-3: MCP tools: get_entity_related + get_entity_timeline, manifest owner flip (2 pts)
- SLICE-4: Fixtures/eval + doctor invocation canary + docs (2 pts)
