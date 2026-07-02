# ADR-010: Feedback & Learning Loop — usefulness signal from day 1

**Status:** accepted · **Date:** 2026-07-02 · **Confidence:** High on capture; Medium on learning stages
**Context:** Strategy Pass 1 gap #3: offline benchmarks exist (LoCoMo/LongMemEval on cloud) but
zero production signal on whether recalled memory *helps*. Without it: no learning loop, no data
moat, no seed metric. Pass 6 names recall-usefulness rate as THE metric to instrument before
launch. Pass 3 P3: graded trajectories → procedural memory is the moat-maker.

## Decision

**Capture three event families from day 1** (as `usefulness` events in the ADR-002 log — they
ride existing infrastructure):

1. **`recall_served`** — every search/recall: query hash, atom ids, scores, mode, surface
   (MCP/CLI/REST), injection-policy decision (ADR-005).
2. **`recall_used`** — the atom mattered: (a) explicit signal via MCP tool response feedback /
   CLI flag; (b) heuristic client-side detection in adapters (served atom's content referenced in
   a subsequent turn). Heuristic is noisy — label it as such; explicit beats implicit.
3. **`memory_corrected`** — user edited, rejected, invalidated, or demoted an atom shortly after
   it was served (negative signal; also feeds contradiction detection precision, ADR-004 stage 9).

**The metric:** `recall-usefulness rate = used / served` (per project, per atom type, per
surface). This is the seed-deck curve and the internal quality gate.

**Consumption stages (sequenced, each optional until proven):**
- **v1 (launch):** dashboards/doctor only — measure, don't act.
- **v1.x:** usage signal feeds ranking (the fusion contract already has a usage/importance slot
  on both engines — ADR-005 keeps this contract-legal).
- **v2:** consolidation prioritization (ADR-004 stage 9 consolidates high-traffic clusters first);
  injection-policy tuning (when-to-recall learns from served-but-never-used patterns).
- **v2+:** procedural mining — `events`-kind capture (ADR-008) ties runner-plugin grades to
  trajectories; well-graded, repeatedly-useful command/lesson chains become candidate `procedure`
  atoms (new type via registry). Nobody else has grading signal attached to memory — this is the
  compounding moat, and it only compounds if capture starts NOW.

**Privacy constraint:** usefulness events are scope-inherited (ADR-009) — personal-atom events
never sync; team-scope aggregates only.

## Options considered

1. **Event-family capture now, staged consumption (chosen).** Cheap (rides the event log),
   preserves every future option, produces the seed metric immediately.
2. **Full online-learning ranker v1.** Rejected: ML infrastructure against C1, cold-start noise,
   and the eval harness (ADR-005) must exist first to detect regressions.
3. **Defer instrumentation until post-launch.** Rejected: the moat clock and the seed clock both
   start at first install; retrofitted signal loses the earliest (most loyal) cohort.

## Consequences & migration

- Adapters add the `recall_used` heuristic + explicit feedback affordance (MCP tool result field).
- `doctor` and `/health` expose the usefulness rate (also serves ADR-006 metering later).
- 90-day plan item #4 implements the v1 slice of this ADR.
