---
feature: FEAT-481
---
# Cost Advisor

## Performance Grade: A

Target slice: **FEAT481 SLICE428**
Cost: $11.2302 · duration 30.9 min · cache hit 99.6% · grade avg -

## Baseline (last 9 slices)
- median $: $11.13
- p75 $: $17.72
- median cache hit: 99.6%
- median Opus share: 0.0%

## Per-slice findings
### [HIGH] exploration-heavy
- Exploration:execution tool ratio is 9.3:1 (Reads/Greps/Bashes vs Edits/Writes).
- **Suggested action:** Lots of looking, little doing. After the second exploration pass, write the plan down and start editing; do not keep grepping. Prefer LSP for code-symbol lookups (see `docs/process/grep-guidance.md` in hero-crew); use Grep only for prose, configs, or regex hunts.

