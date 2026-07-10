---
kind: cost-report
feature: FEAT-463
run_title: "FEAT463 SLICE421"
usd: 9.0832
duration_ms: 3904500
total_tokens: 22592187
cache_hit_pct: 99.3
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-10T13:50:42.064Z
---

# Cost Report: FEAT463 SLICE421

- Created: 2026-07-10T13:50:42.064Z
- Run Title: FEAT463 SLICE421
- Window Start: 2026-07-10T12:45:36.387Z
- Window End: 2026-07-10T13:50:40.887Z
- Duration: 65.1 min (3904500 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 88
- Total Tokens: 22,592,187
- Cache Hit %: 99.3%
- Total USD: $9.0832
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 16,804
- cache_create_5m: 0
- cache_create_1h: 131,110
- cache_read: 22,341,359
- output: 102,914

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 88 msgs (100%), $9.0832 (100%)

## Conversation Shape

- user_msg_count: 25
- user_msg_avg_len: 2185
- turns_before_first_tool: 0
- compaction_count: 0
- skill_invocations: 0
- subagent_dispatches: 4

## Tool Usage

- Bash: 8
- SendMessage: 8
- Agent: 4
- Write: 2
- AskUserQuestion: 1
- Edit: 1

## Tool Result Sizes (bytes)

- count: 24
- sum: 27,083
- p50: 589
- p90: 2,720
- max: 3,066

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- SendMessage: 8 calls, 18,736B results, ~70,584 cache_create tok (3.77×)
- Agent: 4 calls, 1,194B results, ~31,490 cache_create tok (26.37×)
- Bash: 7 calls, 4,972B results, ~19,110 cache_create tok (3.84×)
- AskUserQuestion: 1 calls, 1,059B results, ~6,759 cache_create tok (6.38×)
- Write: 2 calls, 354B results, ~2,302 cache_create tok (6.5×)
- Edit: 1 calls, 179B results, ~321 cache_create tok (1.79×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 88
- usd: $9.0832
- input: 16,804
- cache_create_5m: 0
- cache_create_1h: 131,110
- cache_read: 22,341,359
- output: 102,914

