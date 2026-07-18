---
kind: cost-report
feature: FEAT-542
run_title: "FEAT542 SLICE438"
usd: 12.84
duration_ms: 1555721
total_tokens: 37872918
cache_hit_pct: 99.7
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-18T02:07:54.706Z
---

# Cost Report: FEAT542 SLICE438

- Created: 2026-07-18T02:07:54.706Z
- Run Title: FEAT542 SLICE438
- Window Start: 2026-07-18T01:41:57.581Z
- Window End: 2026-07-18T02:07:53.302Z
- Duration: 25.9 min (1555721 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 61
- Total Tokens: 37,872,918
- Cache Hit %: 99.7%
- Total USD: $12.8400
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 118
- cache_create_5m: 0
- cache_create_1h: 100,312
- cache_read: 37,710,853
- output: 61,635

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 61 msgs (100%), $12.8400 (100%)

## Conversation Shape

- user_msg_count: 7
- user_msg_avg_len: 579
- turns_before_first_tool: 0
- compaction_count: 0
- skill_invocations: 0
- subagent_dispatches: 2

## Tool Usage

- Bash: 14
- Write: 3
- Agent: 2
- Edit: 2
- SendMessage: 1

## Tool Result Sizes (bytes)

- count: 23
- sum: 11,008
- p50: 296
- p90: 953
- max: 2,793

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 14 calls, 7,526B results, ~64,280 cache_create tok (8.54×)
- Write: 3 calls, 572B results, ~14,267 cache_create tok (24.94×)
- Agent: 2 calls, 1,906B results, ~11,664 cache_create tok (6.12×)
- Edit: 2 calls, 374B results, ~7,650 cache_create tok (20.45×)
- SendMessage: 1 calls, 511B results, ~1,849 cache_create tok (3.62×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 61
- usd: $12.8400
- input: 118
- cache_create_5m: 0
- cache_create_1h: 100,312
- cache_read: 37,710,853
- output: 61,635

