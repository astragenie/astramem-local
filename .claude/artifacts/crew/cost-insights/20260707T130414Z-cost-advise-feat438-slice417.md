---
feature: FEAT-438
---
# Cost Advisor

## Performance Grade: F

Target slice: **FEAT438 SLICE417**
Cost: $59.2361 · duration 38.2 min · cache hit 98.4% · grade avg -

## Baseline (last 7 slices)
- median $: $267.36
- p75 $: $467.10
- median cache hit: 98.4%
- median Opus share: 0.0%

## Per-slice findings
### [HIGH] opus-overuse
- Opus accounts for 100.0% of spend — Opus is ~5x Sonnet on every token category.
- **Suggested action:** Switch routine slices to Sonnet via /model. Reserve Opus for design, ambiguous problem framing, or hard refactors.

### [HIGH] subagent-overuse
- 12 subagent dispatches.
- **Suggested action:** Subagents cold-start with no cache reuse — each one re-derives session context. Reserve for genuinely independent parallel work.

