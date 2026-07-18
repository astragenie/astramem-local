---
feature: FEAT-543
---
# Cost Advisor

## Performance Grade: A

Target slice: **FEAT543 SLICE437**
Cost: $12.6603 · duration 25.7 min · cache hit 99.7% · grade avg -

## Baseline (last 9 slices)
- median $: $11.13
- p75 $: $16.17
- median cache hit: 99.6%
- median Opus share: 0.0%

## Per-slice findings
### [MEDIUM] compaction
- 1 compaction/meta event(s) — context was summarised mid-slice.
- **Suggested action:** Slice ran past the context window. Checkpoint to a handoff artifact earlier and split the work.

