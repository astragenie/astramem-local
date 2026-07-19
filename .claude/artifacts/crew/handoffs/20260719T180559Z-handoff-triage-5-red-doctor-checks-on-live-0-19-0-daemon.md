# Task Handoff: Triage: 5 red doctor checks on live 0.19.0 daemon

- Created: 2026-07-19T18:05:59.850Z
- From: researcher
- To: dispatcher
- Objective: All 5 reds are either by-design WARNs or box-local operational state, not code defects; only the consolidation candidateSelection default is a plausible 0.20 code lever, and event-loop-lag hypothesis about memory-health.ts scans is refuted.
- Allowed Scope:
  - Read-only triage of doctor checks: restart-storm.ts
  - event-loop-lag.ts
  - budget-cap-codex-blind.ts
  - dev-no-auth.ts
  - consolidation-run.ts + health-state.ts/serve.ts wiring. No daemon run
  - no doctor pass
  - no edits.
- Forbidden Scope: -
- Deliverable: Per-check file:line, red-condition, root-cause, A/B/C classification, minimal fix (see inline table below).
- Changed Files:
  - src/doctor/checks/restart-storm.ts
  - src/doctor/checks/event-loop-lag.ts
  - src/doctor/checks/budget-cap-codex-blind.ts
  - src/doctor/checks/dev-no-auth.ts
  - src/doctor/checks/consolidation-run.ts
  - src/server/health-state.ts
  - src/cli/serve.ts
  - src/config/config.ts
- Confidence: medium
- Risks: Root causes for restart-storm and event-loop-lag are inferred from code+comments, not from actually reading watchdog-kills.jsonl or daemon.live.log on this box (out of scope per read-only/no-daemon-run constraint) — confirm by tailing those files before deciding severity. consolidation candidateSelection default-flip recommendation not validated against knn mode's own test coverage/perf profile.
- Suggested Next Handoff: If 0.20 wants to close the consolidation gap: crew:architect or crew:fullstack-dev to evaluate flipping config.ts:1595 candidateSelection default from 'full' to 'knn' (or raising maxGroupSize) — read docs/specs/20260713-teardown-remediation-plan.md P2.1 section first. For restart-storm/event-loop-lag, a quick tail of %LOCALAPPDATA%/Astramem/watchdog-kills.jsonl and daemon.live.log would upgrade the inferred root causes to verified.

