---
kind: cost-report
feature: FEAT-553
run_title: "FEAT553 SLICE442"
usd: 0.8158
duration_ms: 30237
total_tokens: 2293184
cache_hit_pct: 99.7
source_project: C--work-mega-astramem-local
aggregate_all: false
source_count: 1
created_at: 2026-11-05T23:27:41.124Z
---

# Cost Report: FEAT553 SLICE442

- Created: 2026-11-05T23:27:41.124Z
- Run Title: FEAT553 SLICE442
- Window Start: 2026-11-05T23:27:10.735Z
- Window End: 2026-11-05T23:27:40.972Z
- Duration: 0.5 min (30237 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 4
- Total Tokens: 2,293,184
- Cache Hit %: 99.7%
- Total USD: $0.8158
- Source Project: C--work-mega-astramem-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 128
- cache_create_5m: 0
- cache_create_1h: 7,404
- cache_read: 2,279,852
- output: 5,800

## Model Mix

- claude-fable-5-1 (priced as claude-sonnet-4): 4 msgs (100%), $0.8158 (100%)

## Conversation Shape

- user_msg_count: 0
- user_msg_avg_len: 0
- turns_before_first_tool: 2
- compaction_count: 0
- skill_invocations: 0
- subagent_dispatches: 0

## Tool Usage

- Bash: 2

## Tool Result Sizes (bytes)

- count: 2
- sum: 786
- p50: 691
- p90: 691
- max: 691

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 1 calls, 95B results, ~1,851 cache_create tok (19.48×)


## By Model (token detail)

### claude-fable-5-1 (priced as claude-sonnet-4)
- messages: 4
- usd: $0.8158
- input: 128
- cache_create_5m: 0
- cache_create_1h: 7,404
- cache_read: 2,279,852
- output: 5,800

