---
id: FEAT-402
status: done
priority: null
category: null
target_release: null
created: 2026-07-03
updated: 2026-07-03
depends_on: []
slices: []
derived_from: null
github_issue: null
github_milestone: null
github_url: null
pm_customer_impact: 0.60
pm_effort_estimate: 0.75
pm_strategic_alignment: 0.75
pm_technical_risk: 0.70
pm_dependency_depth: 0.20
pm_effort_points: 13
composite_score: 0.57
composite_priority: P2
autonomous_safe: false
pm_demand_evidence: "docs/hardening-roadmap.md:70-73 - 'Motivation (observed): recall for \"sql\" returns lexically/semantically similar hits across ALL projects - a Postgres project gets another project's \"SQLite over Postgres\" decisions.' Concrete observed cross-project leakage, not a fabricated user quote."
pm_scope_notes: "Smallest deliverable: cannot shrink below the roadmap's own 2-slice split (extraction+schema+backfill, then query+CLI+eval) - see proposed_slices below, mirrors docs/hardening-roadmap.md:95-96 'Effort: ~2 slices'. If forced to halve further: ship extraction+schema+ranking-bonus-off (zeta=0) only, defer autocomplete/entities-list CLI. Overlap check: no existing entity table in repo (grep for 'migration' across src/ shows src/storage/migrate.ts as the runner but no entities schema yet) - confirmed net-new. AC quality: concrete and wire-additive, but distill prompt change and entity-normalization ('alias table seedable later') are underspecified - flagging as open question, not inventing the normalization scheme. No grade history (grades dir has only template) - no weak dimension to target. No cost analog under .claude/artifacts/crew/cost/ (directory absent)."
proposed_slices:
  - id_suffix: -SLICE-1
    title: Entity extraction distill stage + migration 009 schema + backfill
    points: 8
  - id_suffix: -SLICE-2
    title: Entity query surface (search/recall filter, /entities routes, CLI) + eval fixtures
    points: 8
pm_risks:
  - "Pre-mortem: most likely 2-weeks-later failure cause is entity name normalization drift (e.g. 'Postgres' vs 'postgres flexible' vs 'pg' not collapsing to one entity id) producing split/duplicate entities that undermine the 'everything about X' promise the FEAT exists to deliver."
  - "Rollback: migration required. Migration 009 (entities + memory_entities tables) is the first schema migration since v0.6.0 per docs/hardening-roadmap.md:96 - a bad migration needs a down-migration or restore-from-backup, not a plain git revert; distill prompt change also needs re-backfill coordination if reverted mid-flight."
  - "Coverage gap: the ADR-005 retrieval eval (tests/eval/retrieval-eval.test.ts) has no entity-tagged fixtures today - a regression that mis-joins memory_entities (e.g. cross-tenant leakage through a shared entity id) would not be caught until entity golden queries are added, per the FEAT's own AC."
reasoning: "High strategic value (fixes an observed cross-project leakage) but technical_risk band 0.6-0.8 - first schema migration since v0.6.0 plus distill prompt change plus new query path; effort_points=13 triggers the FEAT-168 decomposition gate, satisfied via proposed_slices mirroring the roadmap's own 2-slice split. autonomous_safe=false pending human review of the migration and entity-normalization scheme."
---
# FEAT-402: Entity-based search (W4.2)

## Description

"Everything about <entity> X" across wordings. Recall today matches lexical/semantic
similarity across ALL projects — a Postgres project surfaces another project's
"SQLite over Postgres" decisions. Nothing understands that "Postgres", "postgres
flexible", and "pg" are the same THING, or lets a user ask for everything known
about a named entity. This adds distill-time entity extraction and an entity query path.

## Acceptance criteria (Given / When / Then)

**AC-1 (extraction)** Given a distilled atom mentioning "Postgres", When the distill-time entity stage runs, Then a `memory_entities` row links it to an `entities` row whose name is normalized (lowercased) and `kind='tech'`.
**AC-2 (schema, migration 009)** Given migration 009 applied, When the schema is inspected, Then `entities(id, name UNIQUE, kind)` and `memory_entities(memory_id, entity_id, PK(memory_id,entity_id))` exist with an index on `entity_id`.
**AC-3 (cascade)** Given a memory that is superseded or erased, When the cascade runs, Then its `memory_entities` links are removed — a query for orphaned links returns 0 rows.
**AC-4 (query)** Given memories linked to entity X under differing wordings ("Postgres"/"pg"/"postgres flexible" → same entity), When `search`/`recall` runs with `entity=X`, Then all and only X-linked members of the FTS+vec candidate set are returned (intersection applied before fusion).
**AC-5 (routes)** Given `GET /entities?q=pg`, When called, Then matching entities are returned; Given `GET /entities/:id/memories`, Then every memory linked to that entity is returned.
**AC-6 (ranking safety)** Given `search.zeta=0` (default), When ranking runs, Then result order is identical to no-entity ranking (snapshot); the zeta bonus alters order only when `zeta > 0`.
**AC-7 (backfill)** Given an existing corpus with no entities, When the backfill command runs, Then entities are extracted and linked without re-distilling or altering memory text.
**AC-8 (eval)** Given entity-tagged fixtures + entity queries added to the ADR-005 corpus, When the suite runs, Then recall@10 ≥ 0.90 / NDCG@10 ≥ 0.70 floors hold, and this passes BEFORE `zeta` is moved off 0.
**AC-9 (normalization, open→resolved)** Given entity names differing only by case/known alias, When extraction normalizes, Then they collapse to one `entities.id` (lowercase + trim now; alias table deferred but the normalize function is a single seam) — resolves the PM-flagged normalization gap.

## Notes

Roadmap W4.2. Complexity: High — migration 009 (first since v0.6.0), distill prompt
change, new query path, eval fixtures. Est 16–24h (2 slices). Full design sketch in
docs/hardening-roadmap.md §W4.x. Soft prereq: W4.3 tag hygiene makes entity scoping
more useful. Suggested activation order: 4th.
