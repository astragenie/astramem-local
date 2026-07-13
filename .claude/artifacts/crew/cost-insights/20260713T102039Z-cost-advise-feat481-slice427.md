---
feature: FEAT-481
---
# Cost Advisor

## Performance Grade: B

Target slice: **FEAT481 SLICE427**
Cost: $11.1321 · duration 22.9 min · cache hit 99.6% · grade avg -

## Baseline (last 9 slices)
- median $: $17.72
- p75 $: $157.41
- median cache hit: 99.3%
- median Opus share: 0.0%

## Per-slice findings
### [LOW] large-tool-output
- 90th-percentile tool result is 4,374 bytes.
- **Suggested action:** Prefer Grep with head_limit, Bash | head -N, or narrower file Read offsets over broad output. Big tool results inflate cache_create.

### [MEDIUM] subagent-overuse
- 4 subagent dispatches.
- **Suggested action:** Subagents cold-start with no cache reuse — each one re-derives session context. Reserve for genuinely independent parallel work.

### [MEDIUM] compaction
- 1 compaction/meta event(s) — context was summarised mid-slice.
- **Suggested action:** Slice ran past the context window. Checkpoint to a handoff artifact earlier and split the work.

