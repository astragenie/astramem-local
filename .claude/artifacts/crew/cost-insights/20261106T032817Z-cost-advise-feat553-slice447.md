---
feature: FEAT-553
---
# Cost Advisor

## Performance Grade: D

Target slice: **FEAT553 SLICE447**
Cost: $115.1648 · duration 159833.2 min · cache hit 98.4% · grade avg -

## Baseline (last 9 slices)
- median $: $87.69
- p75 $: $163.58
- median cache hit: 98.2%
- median Opus share: 0.0%

## Per-slice findings
### [MEDIUM] subagent-overuse
- 4 subagent dispatches.
- **Suggested action:** Subagents cold-start with no cache reuse — each one re-derives session context. Reserve for genuinely independent parallel work.

### [HIGH] compaction
- 7 compaction/meta event(s) — context was summarised mid-slice.
- **Suggested action:** Slice ran past the context window. Checkpoint to a handoff artifact earlier and split the work.

### [HIGH] exploration-heavy
- Exploration:execution tool ratio is 42.4:1 (Reads/Greps/Bashes vs Edits/Writes).
- **Suggested action:** Lots of looking, little doing. After the second exploration pass, write the plan down and start editing; do not keep grepping. Prefer LSP for code-symbol lookups (see `docs/process/grep-guidance.md` in hero-crew); use Grep only for prose, configs, or regex hunts.

