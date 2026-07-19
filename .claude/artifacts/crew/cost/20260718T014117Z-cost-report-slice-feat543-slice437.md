---
kind: cost-report
feature: FEAT-543
run_title: "FEAT543 SLICE437"
usd: 13.8346
duration_ms: 1590660
total_tokens: 40622734
cache_hit_pct: 99.7
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-18T01:41:17.913Z
---

# Cost Report: FEAT543 SLICE437

- Created: 2026-07-18T01:41:17.913Z
- Run Title: FEAT543 SLICE437
- Window Start: 2026-07-18T01:14:45.906Z
- Window End: 2026-07-18T01:41:16.566Z
- Duration: 26.5 min (1590660 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 71
- Total Tokens: 40,622,734
- Cache Hit %: 99.7%
- Total USD: $13.8346
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 136
- cache_create_5m: 0
- cache_create_1h: 101,772
- cache_read: 40,448,223
- output: 72,603

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 71 msgs (100%), $13.8346 (100%)

## Conversation Shape

- user_msg_count: 9
- user_msg_avg_len: 325
- turns_before_first_tool: 2
- compaction_count: 1
- skill_invocations: 0
- subagent_dispatches: 2

## Tool Usage

- Bash: 15
- Edit: 8
- Agent: 2
- Write: 1

## Tool Result Sizes (bytes)

- count: 27
- sum: 21,164
- p50: 303
- p90: 2,075
- max: 6,620

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 15 calls, 10,950B results, ~64,828 cache_create tok (5.92×)
- Edit: 8 calls, 1,470B results, ~14,621 cache_create tok (9.95×)
- Agent: 2 calls, 1,906B results, ~11,337 cache_create tok (5.95×)
- Write: 1 calls, 218B results, ~1,389 cache_create tok (6.37×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 71
- usd: $13.8346
- input: 136
- cache_create_5m: 0
- cache_create_1h: 101,772
- cache_read: 40,448,223
- output: 72,603

