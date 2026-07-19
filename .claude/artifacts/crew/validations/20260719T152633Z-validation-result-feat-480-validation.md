---
findings: "pass:1,partial:1"
decision: pass
---
# Validation Result: FEAT-480 round 3: FTS AND/OR branch probe (b4f0d01, measurement only)

- Created: 2026-07-19T16:18:16.724Z
- Validator: verifier
- Environment: local (fresh isolated copy of prod 54k-memory store, port 7788, ASTRA_FTS_INSTRUMENT=1, workers/consolidation disabled, zero codex-subscription calls confirmed)
- Decision: passed_with_notes
- Scenario: Probe REFUTES the pure-never-engages hypothesis but confirms the practical failure mode: AND fired on only 3/20 real queries (test-runner-literal, zod-strip-literal, latency-budget-literal), OR fired on 17/20 -- residual OR exposure is large enough to explain the round-2 literal-MRR regression and junk flood. Coverage histogram shows only 3% of FTS-sourced top-K hits (2/79) are single-signal-token matches, meaning a coverage>=2 gate would prune almost nothing -- NOT a clean lever for the junk problem observed. Measurement-only change, no ranking behavior altered; this is not itself a merge candidate.
- Evidence Collected:
  - Full probe output (20 queries = 10 cases x plain+literal): AND-rows>0 on 3/20 (test-runner literal=11 rows
  - zod-strip literal=1 row
  - latency-budget literal=1 row); OR-fired on the other 17/20 including ALL 10 plain-English queries and 7/10 literal queries. Coverage histogram (79 FTS-sourced top-K hits pooled): coverage=1: 2 (3%)
  - coverage=2: 22 (28%)
  - coverage=3: 23 (29%)
  - coverage=4: 13 (16%)
  - coverage=5: 14 (18%)
  - coverage=6: 4 (5%)
  - coverage=7: 1 (1%). Daemon boot confirmed zero codex-subscription log lines; ollama/qwen3:8b only for the one orphaned distill job auto-drained per boot. Prod daemon on :7777 (pid 34948) verified running before and after
  - untouched.
- Files / Surfaces Checked: -
- Risks: A coverage>=2 gate would only remove 2/79 (3%) of FTS-sourced candidates -- it does not size a lever that explains the observed +6pp junk-rate flood or literal-MRR regression from round 2; those are dominated by the 17/20 OR-fallback-fired queries pulling in many coverage 2-3 (57% of the pool) low-specificity matches, not pure coverage=1 noise. A coverage-gated OR design as originally proposed (round 2's suggested 3rd design) would NOT clean up the junk pollution on this real corpus -- a higher threshold (coverage>=3 or 4) would need modeling against the recall harness before it's worth building, since it also risks cutting the plain-English recovery this FEAT exists for.
- Required Follow-up: Coverage-gate-at-2 is ruled out as the fix. Before building a 3rd design: model a coverage>=3 (or higher) threshold's effect on both plain-MRR and junk rate using this same probe + run.mjs pairing (same fresh-copy method), since coverage 2-3 together are 57% of the FTS-sourced candidate pool and any gate placed there is a real recall/junk tradeoff, not a free win. Alternatively, defer FEAT-480 to 0.21 per the coordinator's stated fallback.

