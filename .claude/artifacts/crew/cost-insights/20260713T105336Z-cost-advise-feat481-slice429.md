---
feature: FEAT-481
---
# Cost Advisor

## Performance Grade: B

Target slice: **FEAT481 SLICE429**
Cost: $7.2918 · duration 18.3 min · cache hit 99.7% · grade avg -

## Baseline (last 9 slices)
- median $: $15.37
- p75 $: $157.41
- median cache hit: 99.5%
- median Opus share: 0.0%

## Per-slice findings
### [LOW] subagent-overuse
- 3 subagent dispatches.
- **Suggested action:** Subagents cold-start with no cache reuse — each one re-derives session context. Reserve for genuinely independent parallel work.

### [MEDIUM] exploration-heavy
- Exploration:execution tool ratio is 6.0:1 (Reads/Greps/Bashes vs Edits/Writes).
- **Suggested action:** Lots of looking, little doing. After the second exploration pass, write the plan down and start editing; do not keep grepping. Prefer LSP for code-symbol lookups (see `docs/process/grep-guidance.md` in hero-crew); use Grep only for prose, configs, or regex hunts.

