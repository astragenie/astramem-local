---
id: FEAT-409
status: pending
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
pm_customer_impact: 0.25
pm_effort_estimate: 0.55
pm_strategic_alignment: 0.35
pm_technical_risk: 0.75
pm_dependency_depth: 0.00
pm_effort_points: 8
composite_score: 0.4175
composite_priority: P3
autonomous_safe: false
pm_demand_evidence: "none - infra flexibility for future model swaps, no user complaint. CLAUDE.md itself flags this as a known coordinated-change hazard ('Six-file coordinated change. Backlog: parameterize.') rather than a demand signal."
pm_scope_notes: "Smallest deliverable per proposed_slices below. Overlap/blast-radius check: grep for literal '1024' across src/ found 15 files (src/doctor/hardening-checks.ts, src/cli/backup.ts, src/doctor/checks.ts, src/server/app.ts, src/cli/init.ts, src/search/search.ts, src/distill/stages/08-embed-index.ts, src/config/config.ts, src/providers/embed/ollama.ts, src/contracts/embed.ts, src/config/persist-envs.ts, src/pipeline/mock-providers.ts, src/providers/embed/azure-openai.ts, src/doctor/probes/embed-probe.ts, src/vector/sqlite-vec.ts) - broader than CLAUDE.md's 'six-file' framing, which raises technical_risk above what the FEAT body's 'Med-high' label alone would suggest. AC quality: concrete end-to-end test case given (non-1024 dim, fresh DB, ingest, search); re-embed migration path for an EXISTING db (not just fresh) is under-specified on how in-flight vectors get converted. No grade history / no cost analog available."
proposed_slices:
  - id_suffix: -SLICE-1
    title: Single-source-of-truth dim (schema FLOAT[N], config, embed provider dim)
    points: 5
  - id_suffix: -SLICE-2
    title: Contracts + eval + re-embed migration path + boot preflight test
    points: 5
pm_risks:
  - "Pre-mortem (technical_risk>=0.6 mandatory): most likely failure cause is one of the 15 files referencing '1024' being missed during the parameterization pass (broader blast radius than the FEAT's 'six-file' framing), leaving a stale hardcoded assumption that silently breaks only when a non-default dim is configured."
  - "Rollback: needs migration/state cleanup. Changing an existing DB's dim requires the re-embed migration path itself (re-embedding all vectors) - there is no clean git-revert once a non-1024 DB has live data; restoring requires the pre-change backup."
  - "Coverage gap: current tests presumably hardcode 1024 throughout (contracts/eval per CLAUDE.md's six-file list) - there is no existing test that exercises a second dim value end-to-end, which is exactly what this FEAT's own AC requires as new coverage."
reasoning: "Technical_risk band 0.6-0.8, upper end - actual blast radius (15 files via grep) exceeds CLAUDE.md's own 'six-file' framing, plus a schema/data-shape change requiring re-embed migration for existing DBs. effort_points=8 triggers the decomposition gate, satisfied via proposed_slices. autonomous_safe=false given the touchy coordinated-change history CLAUDE.md itself flags."
---
# FEAT-409: Parameterized embedding dim (W4.9)

## Description

Kill the hardcoded 1024-dim assumption. Make embedding dimension a single
parameter across the six coordinated surfaces (schema, config, providers,
contracts, eval) so models can be swapped without manual surgery.

## Acceptance criteria (Given / When / Then)

**AC-1** Given config dim = D, When the schema is created, Then `memories_vec` is `FLOAT[D]` (not a literal 1024) and D flows from one source of truth into config default + embed provider `dim` + contracts + eval.
**AC-2** Given a fresh DB configured to a non-1024 dim (e.g. 768), When ingest + search run end-to-end, Then embeddings store and recall works with no dimension-mismatch error.
**AC-3** Given a provider whose output dim ≠ schema dim, When the daemon boots, Then the preflight fails loud (the existing boot-time dim guard is preserved, now derived from config).
**AC-4** Given an existing 1024-dim DB with live data and a configured dim change, When the re-embed migration path runs, Then all vectors are re-embedded to the new dim via a documented, resumable procedure (the pre-change backup is the rollback).
**AC-5** Given the parameterization complete, When grepping for a hardcoded `1024` across the coordinated surfaces (the 15 files in `pm_scope_notes`), Then none remain — each reads the config parameter.
**AC-6** Given no dim override (default config), When the daemon runs, Then behavior is byte-identical to pre-change 1024-dim (snapshot; no accidental behavior shift for existing users).

## Notes

Roadmap W4.9. Complexity: Med-high — touchy six-file coordinated change; needs
re-embed migration path. Est 8–12h. Suggested activation order: 6th.
