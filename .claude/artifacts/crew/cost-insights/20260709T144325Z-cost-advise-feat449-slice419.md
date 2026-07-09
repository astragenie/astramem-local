---
feature: FEAT-449
---
# Cost Advisor

## Performance Grade: B

Target slice: **FEAT449 SLICE419**
Cost: $72.3407 · duration 56.0 min · cache hit 99.5% · grade avg -

## Baseline (last 8 slices)
- median $: $67.62
- p75 $: $467.10
- median cache hit: 98.4%
- median Opus share: 0.0%

## Per-slice findings
### [HIGH] opus-overuse
- Opus accounts for 100.0% of spend — Opus is ~5x Sonnet on every token category.
- **Suggested action:** Switch routine slices to Sonnet via /model. Reserve Opus for design, ambiguous problem framing, or hard refactors.

### [LOW] large-tool-output
- 90th-percentile tool result is 4,448 bytes.
- **Suggested action:** Prefer Grep with head_limit, Bash | head -N, or narrower file Read offsets over broad output. Big tool results inflate cache_create.

### [MEDIUM] subagent-overuse
- 4 subagent dispatches.
- **Suggested action:** Subagents cold-start with no cache reuse — each one re-derives session context. Reserve for genuinely independent parallel work.

