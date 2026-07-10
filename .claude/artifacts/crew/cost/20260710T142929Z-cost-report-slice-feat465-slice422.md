---
kind: cost-report
feature: FEAT-465
run_title: "FEAT465 SLICE422"
usd: 17.2707
duration_ms: 6232492
total_tokens: 43430699
cache_hit_pct: 99.4
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-10T14:29:29.718Z
---

# Cost Report: FEAT465 SLICE422

- Created: 2026-07-10T14:29:29.718Z
- Run Title: FEAT465 SLICE422
- Window Start: 2026-07-10T12:45:36.387Z
- Window End: 2026-07-10T14:29:28.879Z
- Duration: 103.9 min (6232492 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 152
- Total Tokens: 43,430,699
- Cache Hit %: 99.4%
- Total USD: $17.2707
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 33,099
- cache_create_5m: 0
- cache_create_1h: 242,876
- cache_read: 42,966,444
- output: 188,280

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 152 msgs (100%), $17.2707 (100%)

## Conversation Shape

- user_msg_count: 41
- user_msg_avg_len: 2342
- turns_before_first_tool: 0
- compaction_count: 1
- skill_invocations: 0
- subagent_dispatches: 7

## Tool Usage

- SendMessage: 16
- Bash: 15
- Agent: 7
- Write: 3
- ScheduleWakeup: 2
- AskUserQuestion: 1
- Edit: 1

## Tool Result Sizes (bytes)

- count: 46
- sum: 57,937
- p50: 598
- p90: 3,019
- max: 4,789

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- SendMessage: 16 calls, 39,310B results, ~145,580 cache_create tok (3.7×)
- Agent: 7 calls, 2,111B results, ~36,972 cache_create tok (17.51×)
- Bash: 15 calls, 13,810B results, ~34,899 cache_create tok (2.53×)
- ScheduleWakeup: 2 calls, 316B results, ~13,344 cache_create tok (42.23×)
- AskUserQuestion: 1 calls, 1,059B results, ~6,759 cache_create tok (6.38×)
- Write: 3 calls, 563B results, ~4,457 cache_create tok (7.92×)
- Edit: 1 calls, 179B results, ~321 cache_create tok (1.79×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 152
- usd: $17.2707
- input: 33,099
- cache_create_5m: 0
- cache_create_1h: 242,876
- cache_read: 42,966,444
- output: 188,280

