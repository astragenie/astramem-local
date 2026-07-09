---
kind: cost-report
feature: FEAT-441
run_title: "FEAT441 SLICE419"
usd: 41.0873
duration_ms: 4390446
total_tokens: 19035720
cache_hit_pct: 99.1
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-09T11:06:01.352Z
---

# Cost Report: FEAT441 SLICE419

- Created: 2026-07-09T11:06:01.352Z
- Run Title: FEAT441 SLICE419
- Window Start: 2026-07-09T09:52:50.013Z
- Window End: 2026-07-09T11:06:00.459Z
- Duration: 73.2 min (4390446 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 70
- Total Tokens: 19,035,720
- Cache Hit %: 99.1%
- Total USD: $41.0873
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 17,346
- cache_create_5m: 0
- cache_create_1h: 145,287
- cache_read: 18,762,082
- output: 111,005

## Model Mix

- claude-opus-4-8 (priced as claude-opus-4): 70 msgs (100%), $41.0873 (100%)

## Conversation Shape

- user_msg_count: 8
- user_msg_avg_len: 2136
- turns_before_first_tool: 2
- compaction_count: 0
- skill_invocations: 0
- subagent_dispatches: 7

## Tool Usage

- PowerShell: 10 (3 failed)
- Agent: 7
- Read: 1
- Edit: 1
- AskUserQuestion: 1
- Bash: 1

## Tool Result Sizes (bytes)

- count: 21
- sum: 31,736
- p50: 953
- p90: 3,919
- max: 5,531

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- PowerShell: 10 calls, 17,197B results, ~66,369 cache_create tok (3.86×)
- Agent: 7 calls, 6,671B results, ~57,139 cache_create tok (8.57×)
- AskUserQuestion: 1 calls, 180B results, ~8,601 cache_create tok (47.78×)
- Read: 1 calls, 1,901B results, ~2,858 cache_create tok (1.5×)
- Edit: 1 calls, 256B results, ~2,529 cache_create tok (9.88×)


## By Model (token detail)

### claude-opus-4-8 (priced as claude-opus-4)
- messages: 70
- usd: $41.0873
- input: 17,346
- cache_create_5m: 0
- cache_create_1h: 145,287
- cache_read: 18,762,082
- output: 111,005

