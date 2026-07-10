---
kind: cost-report
feature: FEAT-466
run_title: "FEAT466 SLICE422"
usd: 13.47
duration_ms: 3357041
total_tokens: 36252058
cache_hit_pct: 99.5
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-10T14:48:43.709Z
---

# Cost Report: FEAT466 SLICE422

- Created: 2026-07-10T14:48:43.709Z
- Run Title: FEAT466 SLICE422
- Window Start: 2026-07-10T13:52:46.030Z
- Window End: 2026-07-10T14:48:43.071Z
- Duration: 56.0 min (3357041 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 104
- Total Tokens: 36,252,058
- Cache Hit %: 99.5%
- Total USD: $13.4700
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 11,057
- cache_create_5m: 0
- cache_create_1h: 155,422
- cache_read: 35,971,387
- output: 114,192

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 104 msgs (100%), $13.4700 (100%)

## Conversation Shape

- user_msg_count: 23
- user_msg_avg_len: 2660
- turns_before_first_tool: 2
- compaction_count: 1
- skill_invocations: 0
- subagent_dispatches: 3

## Tool Usage

- Bash: 16
- SendMessage: 11
- Agent: 3
- ScheduleWakeup: 3

## Tool Result Sizes (bytes)

- count: 34
- sum: 46,947
- p50: 380
- p90: 3,194
- max: 5,459

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- SendMessage: 11 calls, 27,845B results, ~100,191 cache_create tok (3.6×)
- Bash: 16 calls, 17,447B results, ~27,468 cache_create tok (1.57×)
- ScheduleWakeup: 3 calls, 474B results, ~21,018 cache_create tok (44.34×)
- Agent: 3 calls, 917B results, ~5,482 cache_create tok (5.98×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 104
- usd: $13.4700
- input: 11,057
- cache_create_5m: 0
- cache_create_1h: 155,422
- cache_read: 35,971,387
- output: 114,192

