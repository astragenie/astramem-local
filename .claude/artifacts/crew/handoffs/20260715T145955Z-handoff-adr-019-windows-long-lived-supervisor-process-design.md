# Task Handoff: ADR-019: Windows long-lived supervisor process design

- Created: 2026-07-15T14:59:55.527Z
- From: lead-session
- To: -
- Objective: Designed a hidden, long-lived supervisor process to replace the PT5M/PT3M schtasks keepalive+watchdog dual-task pattern, with a single low-frequency backstop task, wscript+VBS hidden-launch (PowerShell fallback), lock-file reuse via a generalized instance-lock, and a full reinstall/rollback migration sequence.
- Allowed Scope: -
- Forbidden Scope: -
- Deliverable: -
- Changed Files:
  - docs/adr/ADR-019-windows-supervisor-process.md
- Confidence: medium
- Risks: verifier: unavailable (scripts/validate-adr-template.ts does not exist in this repo); ADR's own stated low-confidence item: wscript.exe hidden-launch zero-flash + AV/ASR-policy behavior is unverified pending a live Windows smoke test (Phase 2 blocking AC); no Job Object in v1 leaves a bounded (<=5min) orphan-child window on ungraceful supervisor kill, mitigated by adopt-on-start
- Suggested Next Handoff: Dispatch crew:architect-reviewer for independent design review before crew:fullstack-dev implements Phase 1 (instance-lock generalization) through Phase 6 (doctor canary verification) per the Build Sequence table

