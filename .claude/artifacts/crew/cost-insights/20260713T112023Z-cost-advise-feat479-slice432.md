---
feature: FEAT-479
---
# Cost Advisor

## Performance Grade: C

Target slice: **FEAT479 SLICE432**
Cost: $16.1712 · duration 45.0 min · cache hit 99.8% · grade avg -

## Baseline (last 9 slices)
- median $: $12.30
- p75 $: $17.72
- median cache hit: 99.5%
- median Opus share: 0.0%

## Per-slice findings
### [MEDIUM] subagent-overuse
- 6 subagent dispatches.
- **Suggested action:** Subagents cold-start with no cache reuse — each one re-derives session context. Reserve for genuinely independent parallel work.

### [MEDIUM] exploration-heavy
- Exploration:execution tool ratio is 6.0:1 (Reads/Greps/Bashes vs Edits/Writes).
- **Suggested action:** Lots of looking, little doing. After the second exploration pass, write the plan down and start editing; do not keep grepping. Prefer LSP for code-symbol lookups (see `docs/process/grep-guidance.md` in hero-crew); use Grep only for prose, configs, or regex hunts.

## Cross-slice trends
### [MEDIUM] subagent-creep
- Subagent dispatch count has grown across the last 3 slices: 0 → 3 → 6. Each cold-start re-derives session context.
- **Suggested action:** Bundle review + validation into a single subagent when scope is small. Reserve parallel dispatches for genuinely independent parallel work.

### [HIGH] cost-regression
- Current slice cost $16.1712 is 122% above the last-3 median of $7.2918.
- **Suggested action:** Audit what drove the spike: Opus usage, subagent cold-starts, cache busts, or long exploration loops. Mandate Sonnet-default and a written plan before the next similar slice.

