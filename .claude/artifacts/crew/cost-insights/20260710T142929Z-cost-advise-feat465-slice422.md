---
feature: FEAT-465
---
# Cost Advisor

## Performance Grade: D

Target slice: **FEAT465 SLICE422**
Cost: $17.2707 · duration 103.9 min · cache hit 99.4% · grade avg -

## Baseline (last 9 slices)
- median $: $72.34
- p75 $: $221.74
- median cache hit: 98.5%
- median Opus share: 92.8%

## Per-slice findings
### [HIGH] subagent-overuse
- 7 subagent dispatches.
- **Suggested action:** Subagents cold-start with no cache reuse — each one re-derives session context. Reserve for genuinely independent parallel work.

### [MEDIUM] compaction
- 1 compaction/meta event(s) — context was summarised mid-slice.
- **Suggested action:** Slice ran past the context window. Checkpoint to a handoff artifact earlier and split the work.

## Cross-slice trends
### [MEDIUM] trend-opus
- Median Opus $ share is 92.8% across recent slices.
- **Suggested action:** Default to Sonnet; promote to Opus only on slice-start when the problem is design-shaped.

