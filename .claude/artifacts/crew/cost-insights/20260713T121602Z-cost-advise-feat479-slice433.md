---
feature: FEAT-479
---
# Cost Advisor

## Performance Grade: C

Target slice: **FEAT479 SLICE433**
Cost: $18.7818 · duration 55.6 min · cache hit 99% · grade avg -

## Baseline (last 9 slices)
- median $: $14.82
- p75 $: $17.72
- median cache hit: 99.6%
- median Opus share: 0.0%

## Per-slice findings
### [MEDIUM] subagent-overuse
- 6 subagent dispatches.
- **Suggested action:** Subagents cold-start with no cache reuse — each one re-derives session context. Reserve for genuinely independent parallel work.

### [MEDIUM] compaction
- 1 compaction/meta event(s) — context was summarised mid-slice.
- **Suggested action:** Slice ran past the context window. Checkpoint to a handoff artifact earlier and split the work.

### [MEDIUM] exploration-heavy
- Exploration:execution tool ratio is 6.1:1 (Reads/Greps/Bashes vs Edits/Writes).
- **Suggested action:** Lots of looking, little doing. After the second exploration pass, write the plan down and start editing; do not keep grepping. Prefer LSP for code-symbol lookups (see `docs/process/grep-guidance.md` in hero-crew); use Grep only for prose, configs, or regex hunts.

