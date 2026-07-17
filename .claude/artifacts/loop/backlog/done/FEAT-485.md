---
id: FEAT-485
status: done
priority: null
category: feature
target_release: null
created: 2026-07-13
updated: 2026-07-13
depends_on: []
slices: []
derived_from: null
---
## Description

Evidence and source provenance are wired but almost never populated — the 'built, wired, never invoked' class again, this time on the field that makes a memory auditable. Measured live 2026-07-13 against the operator's real store (~14k memories): sampled 10 recent memories across two queries — evidence excerpt present in 1/10; transcript_ref present in 0/10; session (repo/branch/agent/session_id) present in 0/10. Entities by contrast work well (12 entities across 4 memories, correctly typed: gpt-5.4-mini, codex-subscription, SLICE-435, 05-extract.ts, filterAtomRelations). What exists already: AtomSchema carries an optional evidence field; the v3 engineering prompt explicitly demands provenance in the atom text; memories table has transcript_ref + session linkage; /memory/:id/why + the why_memory MCP tool expose bitemporal history; entity_relations carries source_excerpt + evidence_memory_id (SLICE-427/435). So the machinery is complete — the data is just missing. Consequences: you cannot answer 'where did this claim come from?' for ~90% of memories; a hallucinated or inverted fact (the consolidation judge sweep found several — an inverted SQLite/Postgres decision, a port 17777 typo, placeholder commit hashes) cannot be traced back to its source turn to verify or refute it; supersession decisions have no citable basis. NOTE a possible regression: an older memory (53211546, 2026-07-09, repo=runner) DID carry transcript_ref + session while today's carry neither — so this may be a path-dependent gap or a regression, not a never-worked feature. Investigate before assuming. Scope: (1) find where transcript_ref/session get dropped on the current ingest path (hook-built envelopes vs wire callers vs spool drain) and restore them; (2) make the extraction prompt's evidence requirement actually bite — measure evidence-population rate per profile/model, and consider making evidence non-optional for lesson/decision atoms (the types whose whole value is the reasoning); (3) doctor canary for evidence coverage, mirroring checkEntityRelations from SLICE-430: WARN when recent distill activity exists but evidence-population rate is below a floor, splitting 'model never emits evidence' from 'evidence dropped in the pipeline'; (4) dashboard/why surface so an operator can click a memory and see its source excerpt. Acceptance must include a live canary: ingest a transcript, assert the resulting memory carries BOTH an evidence excerpt and a resolvable transcript_ref + session — not merely that the columns exist.

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.
> **Closed 2026-07-17.** core already shipped #291 (evidence guard + rate canaries + e2e canary); dashboard evidence/'traced' surface added #409. No regression — transcript_ref gaps were remember()/memory-tool born-at-scope rows by design (ADR-009)
