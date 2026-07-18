---
feature: FEAT-544
---
# Cost Advisor

## Performance Grade: B

Target slice: **FEAT544 SLICE439**
Cost: $10.7487 · duration 14.8 min · cache hit 99.8% · grade avg -

## Baseline (last 9 slices)
- median $: $13.15
- p75 $: $16.17
- median cache hit: 99.7%
- median Opus share: 0.0%

## Per-slice findings
### [MEDIUM] compaction
- 1 compaction/meta event(s) — context was summarised mid-slice.
- **Suggested action:** Slice ran past the context window. Checkpoint to a handoff artifact earlier and split the work.

