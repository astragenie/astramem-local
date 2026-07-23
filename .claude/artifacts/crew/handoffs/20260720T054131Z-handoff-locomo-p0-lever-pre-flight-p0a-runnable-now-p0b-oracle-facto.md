# Task Handoff: LoCoMo P0 lever pre-flight: P0a runnable now, P0b (oracle factorial) not yet built

- Created: 2026-07-20T05:41:31.235Z
- From: researcher
- To: dispatcher
- Objective: P0a (--llm-judge on an archived cat1-4 run) is a ready-to-run harness flag; P0b 'oracle factorial' is a Phase-1 design concept with no existing script, so it cannot be executed as-is without new code — stopping per the ambiguity rule rather than guessing an implementation.
- Allowed Scope:
  - Read docs/research/20260720-locomo-implementation-plan-and-overnight-runbook.md
  - docs/research/20260720-locomo-improvement-v2-post-crossreview.md
  - docs/research/20260719-zep-locomo-947-audit.md
  - docs/eval-runs/README.md + LEDGER.md
  - CLAUDE.md eval section; grepped scripts/eval/locomo/*.mts for --llm-judge and oracle/factorial support. Read-only — no eval runs executed
  - no LEDGER rows written
  - no daemons spawned.
- Forbidden Scope: -
- Deliverable: Findings only (below) plus the exact command plan for P0a and the gap blocking P0b. No code executed, no artifacts produced beyond this handoff.
- Changed Files:
  - docs/research/20260720-locomo-implementation-plan-and-overnight-runbook.md
  - docs/research/20260720-locomo-improvement-v2-post-crossreview.md
  - docs/research/20260719-zep-locomo-947-audit.md
  - docs/eval-runs/README.md
  - docs/eval-runs/LEDGER.md
  - scripts/eval/locomo/judge.mts
  - scripts/eval/locomo/diagnose-retrieval.mts
  - scripts/eval/locomo/run.mts
- Confidence: high
- Risks: P0b as literally requested ('cheap oracle-retrieval run') does not exist as runnable code — Phase 1 of the v2 plan (docs/research/20260720-locomo-improvement-v2-post-crossreview.md lines 67-71) describes it conceptually (answer each question from gold-source-turns / gold-atoms / retrieved-atoms / retrieved-source-spans, crossed with current-answerer vs canonical-renderer) but no script implements it — diagnose-retrieval.mts is a DIFFERENT, already-built tool (not-extracted / rank-miss / rank-ok attribution, not an answer-from-oracle-source factorial). Running P0b requires either building the factorial harness first (a builder task, out of researcher scope) or the dispatcher clarifying that diagnose-retrieval.mts (which already exists and is cheap) is what was actually meant by 'oracle retrieval run'.
- Suggested Next Handoff: Dispatcher decision needed on P0b before execution: (a) treat existing diagnose-retrieval.mts as the P0b substitute and dispatch execution of that, or (b) dispatch a builder (crew:fullstack-dev/backend-dev) to build the Phase-1 oracle-factorial harness per the v2 plan spec, or (c) defer P0b and proceed with P0a only. Either way, actual command EXECUTION (running bun judge.mts --llm-judge, running any harness, and the archive-run.mts + LEDGER.md write-back) must go to an implementer-class agent — researcher has no Bash-mutation/Edit access.

