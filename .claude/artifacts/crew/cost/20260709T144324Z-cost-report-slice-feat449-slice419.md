---
kind: cost-report
feature: FEAT-449
run_title: "FEAT449 SLICE419"
usd: 72.3407
duration_ms: 3361870
total_tokens: 37707907
cache_hit_pct: 99.5
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-09T14:43:24.883Z
---

# Cost Report: FEAT449 SLICE419

- Created: 2026-07-09T14:43:24.883Z
- Run Title: FEAT449 SLICE419
- Window Start: 2026-07-09T13:47:22.481Z
- Window End: 2026-07-09T14:43:24.351Z
- Duration: 56.0 min (3361870 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 84
- Total Tokens: 37,707,907
- Cache Hit %: 99.5%
- Total USD: $72.3407
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 11,967
- cache_create_5m: 0
- cache_create_1h: 192,022
- cache_read: 37,365,896
- output: 138,022

## Model Mix

- claude-opus-4-8 (priced as claude-opus-4): 84 msgs (100%), $72.3407 (100%)

## Conversation Shape

- user_msg_count: 8
- user_msg_avg_len: 1477
- turns_before_first_tool: 2
- compaction_count: 0
- skill_invocations: 0
- subagent_dispatches: 4

## Tool Usage

- Bash: 12
- Edit: 4
- Agent: 4
- Read: 4
- Write: 1

## Tool Result Sizes (bytes)

- count: 26
- sum: 40,119
- p50: 953
- p90: 4,448
- max: 6,500

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 12 calls, 13,343B results, ~81,696 cache_create tok (6.12×)
- Agent: 4 calls, 3,812B results, ~38,318 cache_create tok (10.05×)
- Read: 4 calls, 16,474B results, ~31,893 cache_create tok (1.94×)
- Edit: 4 calls, 727B results, ~19,064 cache_create tok (26.22×)
- Write: 1 calls, 163B results, ~10,143 cache_create tok (62.23×)


## By Model (token detail)

### claude-opus-4-8 (priced as claude-opus-4)
- messages: 84
- usd: $72.3407
- input: 11,967
- cache_create_5m: 0
- cache_create_1h: 192,022
- cache_read: 37,365,896
- output: 138,022

