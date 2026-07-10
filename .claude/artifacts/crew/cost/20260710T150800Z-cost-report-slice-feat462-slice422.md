---
kind: cost-report
feature: FEAT-462
run_title: "FEAT462 SLICE422"
usd: 17.7207
duration_ms: 4500698
total_tokens: 48592537
cache_hit_pct: 99.6
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-10T15:08:00.599Z
---

# Cost Report: FEAT462 SLICE422

- Created: 2026-07-10T15:08:00.599Z
- Run Title: FEAT462 SLICE422
- Window Start: 2026-07-10T13:52:46.030Z
- Window End: 2026-07-10T15:07:46.728Z
- Duration: 75.0 min (4500698 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 135
- Total Tokens: 48,592,537
- Cache Hit %: 99.6%
- Total USD: $17.7207
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 18,670
- cache_create_5m: 0
- cache_create_1h: 194,956
- cache_read: 48,244,130
- output: 134,781

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 135 msgs (100%), $17.7207 (100%)

## Conversation Shape

- user_msg_count: 27
- user_msg_avg_len: 2600
- turns_before_first_tool: 2
- compaction_count: 2
- skill_invocations: 0
- subagent_dispatches: 3

## Tool Usage

- Bash: 25 (1 failed)
- SendMessage: 12
- ScheduleWakeup: 4
- Agent: 3
- Write: 2

## Tool Result Sizes (bytes)

- count: 46
- sum: 56,552
- p50: 375
- p90: 3,019
- max: 5,459

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- SendMessage: 12 calls, 30,110B results, ~104,189 cache_create tok (3.46×)
- Bash: 24 calls, 24,260B results, ~48,362 cache_create tok (1.99×)
- ScheduleWakeup: 4 calls, 632B results, ~32,841 cache_create tok (51.96×)
- Agent: 3 calls, 917B results, ~5,482 cache_create tok (5.98×)
- Write: 2 calls, 369B results, ~2,819 cache_create tok (7.64×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 135
- usd: $17.7207
- input: 18,670
- cache_create_5m: 0
- cache_create_1h: 194,956
- cache_read: 48,244,130
- output: 134,781

