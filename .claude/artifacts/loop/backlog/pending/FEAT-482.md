---
id: FEAT-482
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

Job-queue priority tiers + cooperative yielding — fix worker starvation class found 2026-07-13. Evidence: a single consolidate run with contradictionDetection enabled (200 sequential LLM judge calls x 2-4s) wedged the sole in-process worker for 10+ minutes; distill queue froze at 32 pending / 0 running; live ingest canary timed out. Design: (1) priority tiers - P1 distill (extract/compact/embed), P2 spool drain/backfills, P3 consolidate similarity sweep, P4 contradiction judge + llm junk sampling, P5 cleanup; (2) cooperative yielding - long runs chunk their work and requeue remainder when P1 work is pending (this alone fixes the observed starvation); (3) two lanes - local-sqlite jobs never blocked behind network-LLM jobs; (4) wall-clock caps per P3/P4 run alongside existing maxPerRun; (5) anti-starvation aging for housekeeping tiers. Related defect shipped separately: contradictionDetection.mode default 'enabled' means every consolidation run silently burns up to 200 extraction-provider calls - with codex-subscription extraction that is ChatGPT subscription quota; default should be re-evaluated or at minimum doctor-surfaced with a cost note. Operator config set mode 'off' 2026-07-13 pending this FEAT; re-enable after yielding ships.

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.