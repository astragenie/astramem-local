# Final synthesis — FEAT-552 deterministic hardening wave, 2026-07-18

owner: lead (orchestrator)
branch: chore/bench-onnx-embed, merged tip 439f52db (pushed)
spec: .claude/artifacts/loop/backlog/done/FEAT-552.md (operator-directed, base 98515925)

## Build phase (3 parallel worktrees, complete)

| Sub | Scope | Tip | Review |
|---|---|---|---|
| A parse-hardening | JSON truncation salvage + dup-key pre-parse detector + evidence-first sweeper prompt | 362f0ee3 | approved, ZERO findings |
| B type-tier | type-hints.ts (default ON) + `backfill-types` CLI (dry-run default, --apply batched/resumable, audit events) | a75a7082 | approved_with_notes after 1 HIGH fix |
| C merge-guard | command-token merge guard (threshold + dup-judge + containment) + fuzzy evidence tier (>=90% overlap) | 8a3509da | approved after 1 MEDIUM fix |

Merged A->B->C, zero conflicts. Sweep on merged tip: tsc(tests,eval) clean; 76 files /
1359 tests green. Post-merge hook rebuilt + reinstalled prod at 439f52db.

## Review gate scorecard — 2 real bugs tests missed

1. **B HIGH (case-order):** `normalizeText()`'s ENTITY_DICT capitalizes `bun`->`Bun`
   BEFORE the hint tier at both real call sites; `COMMAND_LEAD_RE` was lowercase-only ->
   bun-/vitest-led commands never fired in production while the census (measuring raw
   pre-normalize text) claimed they did. Fix: `i` flag + drop `make` (collides with
   decision-imperative "Make" once case-insensitive) + end-to-end regression tests through
   `memoryNormalize()` and `runTypeBackfillBatch()` with genuinely-normalized seeds.
2. **C MEDIUM (containment bypass):** containment tier auto-merged without consulting the
   command guard at two call sites (processPair autoMergeContained, sweepContainedProposals).
   Fixed both + repro regression test (the prod false-merge pair).

Both = the house class: unit test passes, real call-site path differs. End-to-end
assertions through production entry points are what caught/locked them.

## Prod census (corrected, dry-run, read-only)

50,091 scanned, **419 would-change** (first census 308 — the case fix restored 111
silently-dropped fires). Top: fact->command 209, todo->decision 47, fact->event 26,
event->command 24. `--apply` = operator decision, not run.

## Follow-ups

- backfill checkpoint write: plain writeFileSync, not tmp+rename (B review MEDIUM; self-heals via malformed-JSON fallback)
- live re-measure of sweeper evidence-compliance (A3 follow-up, GPU lane)
- type-aware merge-guard prose isolation (C review MEDIUM-1, carried from earlier)
- `--apply` run on prod after operator sign-off
