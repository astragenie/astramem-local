---
id: FEAT-483
status: pending
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

Live-pipeline e2e test suite + doctor canaries — catch the 2026-07-13 silent-degradation class. Today's incidents, every one silent (no crash, quality just died): (1) extraction model misconfigured to qwen3:8b - returned empty JSON, poisoned 30 distill jobs, nothing alerted; (2) temperature silently dropped on every Ollama call for the code's entire life (double options spread) - all quality baselines invalid; (3) num_ctx never set - v3 prompt silently truncated, recall collapsed 3 atoms to 1; (4) contradiction judge default-enabled burned 200 metered LLM calls per consolidation run and starved the worker - distill frozen at 32 pending / 0 running for an hour, discovered only by hand-run canary; (5) dashboard accept button 415 since the day it shipped (form posts urlencoded, no parser) - manual click was the first exercise; (6) stale global CLI 0.3.4 silently killed the capture chain for days. Build: (A) ingest-to-memory LIVE canary e2e - POST a synthetic transcript with a unique marker phrase, assert a memory containing it is searchable within an SLA (5 min), runnable against a sandboxed daemon in CI (mock LLM) AND against the real local daemon as a doctor check with freshness SLA row; (B) queue-liveness canary - assert distill throughput nonzero while a consolidate job runs (starvation regression, pairs with FEAT-482); (C) provider-options wire asserts - live provider call captures that temperature, num_ctx, num_predict actually reach the request body (regression tests exist post-SLICE-433; add the cross-provider e2e); (D) browser-shaped route e2e - every dashboard form action exercised with the exact content-type a browser sends (the 415 class); (E) config-defaults-vs-docs consistency test - parse doc comments' stated defaults against defaultConfig() values (the judge-enabled-vs-docs-say-off class); (F) capture-chain freshness doctor row - last successful hook capture age vs threshold (the stale-CLI class; extends existing hook_close canary). Wire A+B into CI per-PR with mock providers, and A/F into doctor for the live box. Priority argument: every one of these classes reached the operator's production store undetected in a single day.

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.