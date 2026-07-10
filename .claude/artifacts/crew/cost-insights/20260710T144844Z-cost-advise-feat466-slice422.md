---
feature: FEAT-466
---
# Cost Advisor

## Performance Grade: B

Target slice: **FEAT466 SLICE422**
Cost: $13.4700 · duration 56.0 min · cache hit 99.5% · grade avg -

## Baseline (last 9 slices)
- median $: $59.24
- p75 $: $157.41
- median cache hit: 99.1%
- median Opus share: 88.1%

## Per-slice findings
### [LOW] subagent-overuse
- 3 subagent dispatches.
- **Suggested action:** Subagents cold-start with no cache reuse — each one re-derives session context. Reserve for genuinely independent parallel work.

### [MEDIUM] compaction
- 1 compaction/meta event(s) — context was summarised mid-slice.
- **Suggested action:** Slice ran past the context window. Checkpoint to a handoff artifact earlier and split the work.

## Cross-slice trends
### [MEDIUM] trend-opus
- Median Opus $ share is 88.1% across recent slices.
- **Suggested action:** Default to Sonnet; promote to Opus only on slice-start when the problem is design-shaped.

