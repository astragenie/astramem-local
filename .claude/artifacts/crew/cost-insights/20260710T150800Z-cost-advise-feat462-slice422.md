---
feature: FEAT-462
---
# Cost Advisor

## Performance Grade: B

Target slice: **FEAT462 SLICE422**
Cost: $17.7207 · duration 75.0 min · cache hit 99.6% · grade avg -

## Baseline (last 9 slices)
- median $: $41.09
- p75 $: $157.41
- median cache hit: 99.3%
- median Opus share: 84.8%

## Per-slice findings
### [LOW] subagent-overuse
- 3 subagent dispatches.
- **Suggested action:** Subagents cold-start with no cache reuse — each one re-derives session context. Reserve for genuinely independent parallel work.

### [MEDIUM] compaction
- 2 compaction/meta event(s) — context was summarised mid-slice.
- **Suggested action:** Slice ran past the context window. Checkpoint to a handoff artifact earlier and split the work.

### [HIGH] exploration-heavy
- Exploration:execution tool ratio is 12.5:1 (Reads/Greps/Bashes vs Edits/Writes).
- **Suggested action:** Lots of looking, little doing. After the second exploration pass, write the plan down and start editing; do not keep grepping. Prefer LSP for code-symbol lookups (see `docs/process/grep-guidance.md` in hero-crew); use Grep only for prose, configs, or regex hunts.

## Cross-slice trends
### [MEDIUM] trend-opus
- Median Opus $ share is 84.8% across recent slices.
- **Suggested action:** Default to Sonnet; promote to Opus only on slice-start when the problem is design-shaped.

