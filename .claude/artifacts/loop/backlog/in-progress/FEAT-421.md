---
id: FEAT-421
status: triaged
priority: P2
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: [SLICE-414]
derived_from: test-inventory-2026-07-04
pm_customer_impact: 0.5
pm_effort_estimate: 0.4
pm_strategic_alignment: 0.5
pm_technical_risk: 0.5
pm_dependency_depth: 0.2
pm_effort_points: 3
composite_score: 0.55
composite_priority: P2
autonomous_safe: true
pm_demand_evidence: "Concrete prior incident: the nomic-embed-text-v2-moe (768-dim) vs mxbai-embed-large (1024-dim) mismatch forced hotfix v0.2.1; a live-provider CI lane would have caught it pre-release. INTEGRATION_LIVE=ollama tests already exist but run nowhere automatically today."
pm_scope_notes: Wiring only — no new test authorship (live-gated tests already exist). Keep this a non-blocking nightly lane (workflow_dispatch + schedule) separate from PR CI; do not make PR merges depend on Ollama-runner availability.
pm_risks: ["\"Main risk is feasibility", "not correctness: installing Ollama and pulling models on a GitHub-hosted runner while staying under a reasonable time/cost budget (~15 min) may not be achievable without self-hosted runners or aggressive caching.\"", Flaky or red nightly runs need a clear owner and triage path (pinned issue) or the lane gets ignored like a lot of nightly CI does., "\"Model cache invalidation on model version bumps needs to be automatic", "or stale cached models silently drift from what production actually uses.\""]
reasoning: "P2: real prior-incident evidence argues for this, but it is a non-blocking nightly lane (slower feedback than PR-gating) and the dominant risk is CI-runner feasibility rather than product risk. Low effort since it wires existing tests rather than authoring new ones."
slices_complete: [SLICE-415]
---
# FEAT-421: Nightly live-provider CI lane (INTEGRATION_LIVE=ollama)

## Problem
All CI runs use mock providers. The INTEGRATION_LIVE=ollama gated tests exist but never run anywhere automatically — real-Ollama drift (model renames, API changes, embed-dim changes like the nomic 768 vs mxbai 1024 incident that forced hotfix v0.2.1) is only caught when a human runs them locally or a user hits it in production.

## Proposal
Scheduled GitHub Actions workflow (nightly cron + manual dispatch): install Ollama on the runner, pull mxbai-embed-large + the small default LLM, run the INTEGRATION_LIVE=ollama test subset + the smoke suite against real providers. Failure notifies (issue or existing alert channel), does NOT block PRs (separate lane from push CI). Cache the Ollama model blobs between runs to keep the job under ~15 min.

## Acceptance sketch
- Workflow file: nightly schedule + workflow_dispatch; PR CI untouched.
- Runs live-gated tests + smoke with real Ollama; green on current main.
- Red run auto-opens/updates a pinned issue with the failing test names.
- Model cache keyed on model name; cold-start documented.

## Evidence
Test-inventory review 2026-07-04. Embed-dim incident (v0.2.1 hotfix) is the concrete prior: a live-provider lane would have caught it pre-release. Live tests exist (INTEGRATION_LIVE gating) — this is wiring, not new test authorship.
