# Task Handoff: Event-loop stall investigation: unyielded embed-index atom loop is top culprit

- Created: 2026-07-19T22:26:48.366Z
- From: performance-engineer
- To: dispatcher
- Objective: blocking_risk — primary: embedAndIndex (08-embed-index.ts) Phase A/C atom loop runs the WHOLE distill job's atom batch fully synchronously with zero cooperative yields (unlike consolidate.ts, which ADR-019 already hardened for this exact class); secondary: consolidation.contradictionDetection ships mode:'enabled' by default doing sequential per-pair LLM judge calls; tertiary: hourly db.pragma wal_checkpoint(TRUNCATE) is a genuine blocking full-checkpoint call
- Allowed Scope:
  - Read-only static investigation of distill/consolidate/storage hot paths on a 54
  - 823-memory store to find the sync op blocking the event loop 5-45s (watchdog restart storm). No code changed.
- Forbidden Scope: -
- Deliverable: Ranked candidate list with file:symbol, why-unbounded/unyielded, which log-gap marker it explains, and fix direction — see final chat response for full table.
- Changed Files:
  - src/distill/stages/08-embed-index.ts
  - src/consolidate/consolidate.ts
  - src/config/config.ts
  - src/cli/serve.ts
  - src/pipeline/worker.ts
  - src/providers/embed/onnx.ts
  - src/providers/embed/onnx-worker-host.ts
  - src/server/lib/deadline.ts
  - src/doctor/checks/event-loop-lag.ts
  - src/distill/pipeline.ts
- Confidence: medium
- Risks: Primary finding is strong static evidence (readable absence-of-yield pattern matching the repo's own previously-fixed ADR-019 class) but magnitude at 54k-row scale is unconfirmed without a profiler run; secondary/tertiary candidates are plausible contributors, not yet isolated by measurement
- Suggested Next Handoff: Instrument src/distill/stages/08-embed-index.ts Phase A/C loops with the existing event-loop-lag monitor (src/doctor/checks/event-loop-lag.ts) before/after adding a yieldEveryNAtoms cooperative yield (same setImmediate pattern as consolidate.ts); reproduce with a synthetic large-atom-count distill job against a 54k-row fixture DB to confirm magnitude before shipping the fix

