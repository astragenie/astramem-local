---
id: FEAT-444
status: done
priority: P1
category: feature
target_release: null
created: 2026-07-08
updated: 2026-07-09
completed_at: 2026-07-09
depends_on: []
slices: []
closure_note: "Verified already-implemented 2026-07-09. AC-1 doctor memory-health row (src/doctor/checks.ts). AC-2 GET /health memory_health block (src/server/routes/health.ts:64, cheap-tier). AC-3 `memory health` CLI exits 0, no mutation; `--deep` adds near-duplicate estimate + junk heuristic + opt-in LLM-judged sample (src/cli/memory-health.ts). AC-4 empty store returns n/a not error. AC-5 heuristic-only unless config opt-in. Tests green: tests/cli/memory-health.test.ts, tests/doctor/memory-health-check.test.ts, tests/server/queries/memory-health-queries.test.ts (29 passed)."
derived_from: null
tags: [stack:typescript, surface:api, concern:observability]
needs_contract: true
needs_ux: false
pm_customer_impact: 0.65
pm_effort_estimate: 0.25
pm_strategic_alignment: 0.8
pm_technical_risk: 0.15
pm_dependency_depth: 0.15
pm_composite_priority: P1
pm_autonomous_safe: true
pm_reviewed: 2026-07-08
autonomous_safe: true
triage_notes: "Frontmatter-only correction pass: scores, compositePriority=P1, and autonomousSafe=true are unchanged from the 20260708T140000Z reconciliation. Purpose is solely to record, in the durable triage record, that AC-1's type citation is factually wrong per my own anti-hallucination verification (I read src/doctor/types.ts directly) and to give the correct mapping so a future builder isn't misled by an AC I already endorsed once for reconciliation reasons."
---
## Description

Memory-health score: per-store health metrics — junk rate (heuristic + optional LLM-judged sample), duplication rate (containment/near-dup scan reusing consolidation similarity), staleness distribution, poison/partial session counts — surfaced as a doctor row, a /health detail block, and a 'memory health' CLI report. Productizes the audit methodology that exposed Mem0's 97.8% junk problem; our own published self-audit becomes a marketing asset (2026-07-08 research CTO rec #1). Read-only over existing tables; no new pipeline stages.

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.
## Acceptance criteria (Given-When-Then)

- AC-1: Given a populated encrypted SQLite store with existing memories, When the operator runs `node dist/cli/index.js doctor`, Then the output includes a memory-health row matching the `CheckResultWithName` shape defined in `src/doctor/types.ts` reporting junk rate, duplication rate, staleness distribution, and poison/partial session counts, computed read-only with no writes to any table.
- AC-2: Given the daemon is running, When a client calls `GET /health` (src/server/routes/health.ts), Then the JSON response includes a new `memory_health` detail block alongside the existing `status`/`embed` fields, and every pre-existing field is still present unchanged (preserving the wire-compat guarantee documented in that file's header comment).
- AC-3: Given the daemon's SQLite store, When the operator runs the new `node dist/cli/index.js memory health` CLI report, Then a human-readable summary of the per-store health metrics is printed and the process exits `0` without mutating the memories, memory_events, or consolidation_proposals tables.
- AC-4: Given an empty or newly-initialized store with zero memories, When the memory-health check/report runs, Then it returns all-zero metrics without throwing (no division-by-zero/NaN), and doctor/health/CLI surfaces all show a clean 'no data yet' state rather than an error.
- AC-5: Given the LLM-judged junk-sample option is not explicitly enabled via config, When the health check/report runs, Then junk rate is computed using the heuristic method only and no LLM provider call is made — the optional judged sample only activates when explicitly turned on in config.
