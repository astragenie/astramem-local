---
id: FEAT-483
status: triaged
priority: P1
category: feature
target_release: null
created: 2026-07-13
updated: 2026-07-19
depends_on: []
slices: []
derived_from: null
tags: [stack:typescript, surface:doctor, surface:ci, surface:api, surface:dashboard, surface:providers, surface:config, concern:observability, concern:reliability, concern:testing]
needs_contract: false
needs_ux: false
pm_customer_impact: 0.85
pm_effort_estimate: 0.75
pm_strategic_alignment: 0.85
pm_technical_risk: 0.4
pm_dependency_depth: 0.3
pm_composite_priority: P1
pm_autonomous_safe: true
pm_reviewed: 2026-07-19
autonomous_safe: true
triage_notes: "P1, band rationale for technical_risk (0.40, mid of the 0.3-0.5 'new pattern / no contract change / clean rollback' band): six structurally-independent test/observability deliverables spanning CI config, doctor checks, e2e harness, multiple provider adapters, and dashboard routes -- genuine cross-module reach -- but zero schema/migration changes, zero product-runtime-behavior changes (pure test/canary additions per the operator's own framing), and every deliverable is trivially git-revertible. customer_impact (0.85) and strategic_alignment (0.85) are both empirically grounded (7-for-7 recurring incident pattern, most recently TODAY, directly targeting the repo's worst grade dimensions: reliability 0.425 and observability 0.325) but composite_score (0.69) lands this at P1 rather than P0 for consistency with this repo's own precedent -- FEAT-538 (an even more directly incident-driven '/health must not lie ok' fix, same incident family) was itself scored P1, not P0, and FEAT-483 is one layer more removed (builds detection infrastructure across 6 classes rather than fixing one exact incident). effort_estimate 0.75 crosses the FEAT-168 decomposition threshold (13 points) -- see proposedSlices; each entry isolates one deliverable or one flagged landmine (FEAT-482 sequencing coupling in SLICE-3) rather than bundling, per the runner#393 policy."
proposed_slices:
  - id_suffix: -SLICE-1
    title: Ingest-to-memory CI e2e canary (mock LLM)
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-2
    title: Ingest-to-memory doctor live-daemon freshness row
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-3
    title: Queue-liveness starvation canary (FEAT-482-coupled)
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-4
    title: Cross-provider options wire-assert e2e
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-5
    title: Browser-shaped dashboard route e2e (415 class)
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-6
    title: Config-defaults-vs-docs consistency test
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-7
    title: Capture-chain freshness doctor row + CI wiring
    points: 2
    estimated_tokens: 100000
---
## Description

Live-pipeline e2e test suite + doctor canaries — catch the 2026-07-13 silent-degradation class. Today's incidents, every one silent (no crash, quality just died): (1) extraction model misconfigured to qwen3:8b - returned empty JSON, poisoned 30 distill jobs, nothing alerted; (2) temperature silently dropped on every Ollama call for the code's entire life (double options spread) - all quality baselines invalid; (3) num_ctx never set - v3 prompt silently truncated, recall collapsed 3 atoms to 1; (4) contradiction judge default-enabled burned 200 metered LLM calls per consolidation run and starved the worker - distill frozen at 32 pending / 0 running for an hour, discovered only by hand-run canary; (5) dashboard accept button 415 since the day it shipped (form posts urlencoded, no parser) - manual click was the first exercise; (6) stale global CLI 0.3.4 silently killed the capture chain for days. Build: (A) ingest-to-memory LIVE canary e2e - POST a synthetic transcript with a unique marker phrase, assert a memory containing it is searchable within an SLA (5 min), runnable against a sandboxed daemon in CI (mock LLM) AND against the real local daemon as a doctor check with freshness SLA row; (B) queue-liveness canary - assert distill throughput nonzero while a consolidate job runs (starvation regression, pairs with FEAT-482); (C) provider-options wire asserts - live provider call captures that temperature, num_ctx, num_predict actually reach the request body (regression tests exist post-SLICE-433; add the cross-provider e2e); (D) browser-shaped route e2e - every dashboard form action exercised with the exact content-type a browser sends (the 415 class); (E) config-defaults-vs-docs consistency test - parse doc comments' stated defaults against defaultConfig() values (the judge-enabled-vs-docs-say-off class); (F) capture-chain freshness doctor row - last successful hook capture age vs threshold (the stale-CLI class; extends existing hook_close canary). Wire A+B into CI per-PR with mock providers, and A/F into doctor for the live box. Priority argument: every one of these classes reached the operator's production store undetected in a single day.

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.
## Acceptance criteria (Given-When-Then)

- AC-1 (happy path, CI): Given a sandboxed daemon in CI wired to a mock LLM provider (following the existing tests/e2e/*.e2e.test.ts pattern, e.g. tests/e2e/auto-capture-close.e2e.test.ts), When the canary POSTs a synthetic transcript to POST /ingest/transcript (src/server/routes/ingest.ts) containing a unique, per-run marker phrase, Then a memory containing that exact marker phrase is returned by a search query within the 5-minute SLA and the test fails loudly (not skips) if the SLA is exceeded.
- AC-2 (doctor live-daemon variant, reliability + observability): Given the operator's real local daemon (per CLAUDE.md's `node dist/cli/index.js doctor`), When the doctor-check variant of the same canary runs, Then it reports a `CheckResultWithName`-shaped row (src/doctor/types.ts) carrying the measured ingest-to-searchable latency and returns RED specifically when that latency exceeds the SLA -- following the rate/measurement-not-existence precedent already set by src/doctor/checks/extraction-yield.ts and src/doctor/checks/auto-capture.ts (both read in full).
- AC-3 (starvation regression, edge/failure path, FEAT-482-coupled): Given a heavy background job is running against a scoped test daemon (a synthetic long-running P3/P4-tier job, not the operator's live instance -- see cascade risk), When distill throughput is measured during that job, Then the test asserts throughput stays nonzero; Given FEAT-482's cooperative-yielding fix has not yet landed, Then this test is marked with an explicit, tracked xfail referencing FEAT-482 rather than silently skipped or hard-failing every unrelated PR.
- AC-4 (cross-provider wire asserts): Given each registered LLM provider adapter (at minimum src/providers/llm/ollama.ts, per CLAUDE.md's documented num_ctx/temperature-drop incident), When a live provider call is made with temperature, num_ctx, and num_predict/maxTokens all set, Then the test captures the actual outbound request body for that provider and asserts all three fields are present with the expected values -- extending the existing single-provider regression test (added post-SLICE-433) to every registered provider, not only Ollama.
- AC-5 (browser-shaped route e2e, the 415 class): Given each dashboard form-action route (src/server/routes/dashboard-api-html.ts, src/server/app.ts), When a request is sent with the exact `application/x-www-form-urlencoded` content-type a real browser `<form>` submission sends -- not `application/json` -- Then every such route returns a 2xx/3xx response, not 415, closing the 'accept button 415 since day it shipped' class named in the FEAT body.
- AC-6 (config-defaults-vs-docs consistency, the judge-enabled-vs-docs-say-off class): Given `defaultConfig()` in src/config/config.ts and every doc comment or CLAUDE.md section asserting a stated default value (e.g. `contradictionDetection.mode`), When the consistency test parses both sources, Then it fails loudly if any doc-stated default diverges from the actual `defaultConfig()` value -- the exact drift class that produced CLAUDE.md's own 'Contradiction detection ships enabled -- do not re-fix this' correction section.
- AC-7 (capture-chain freshness, observability weak-dimension target): Given src/doctor/checks/auto-capture.ts's existing count of `capture_source IN ('auto_capture','hook_close')` events (read in full and confirmed real), When the new freshness row runs, Then it reports the age of the most recent successful hook-close capture event against a configured staleness threshold and returns RED with a structured log entry (ADR-015 loud-failure convention) when that age exceeds the threshold -- closing the 'stale global CLI silently killed the capture chain for days' class and directly targeting the observability weak dimension (0.325 avg per the last-5-grade snapshot).

## Proposed slices (PM decomposition)

- SLICE-1: Ingest-to-memory CI e2e canary (mock LLM) (2 pts)
- SLICE-2: Ingest-to-memory doctor live-daemon freshness row (2 pts)
- SLICE-3: Queue-liveness starvation canary (FEAT-482-coupled) (2 pts)
- SLICE-4: Cross-provider options wire-assert e2e (2 pts)
- SLICE-5: Browser-shaped dashboard route e2e (415 class) (2 pts)
- SLICE-6: Config-defaults-vs-docs consistency test (2 pts)
- SLICE-7: Capture-chain freshness doctor row + CI wiring (2 pts)
