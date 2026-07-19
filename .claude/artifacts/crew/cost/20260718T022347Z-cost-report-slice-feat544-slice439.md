---
kind: cost-report
feature: FEAT-544
run_title: "FEAT544 SLICE439"
usd: 10.7487
duration_ms: 889643
total_tokens: 31850647
cache_hit_pct: 99.8
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-18T02:23:47.477Z
---

# Cost Report: FEAT544 SLICE439

- Created: 2026-07-18T02:23:47.477Z
- Run Title: FEAT544 SLICE439
- Window Start: 2026-07-18T02:08:56.619Z
- Window End: 2026-07-18T02:23:46.262Z
- Duration: 14.8 min (889643 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 48
- Total Tokens: 31,850,647
- Cache Hit %: 99.8%
- Total USD: $10.7487
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 92
- cache_create_5m: 0
- cache_create_1h: 66,489
- cache_read: 31,728,671
- output: 55,395

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 48 msgs (100%), $10.7487 (100%)

## Conversation Shape

- user_msg_count: 5
- user_msg_avg_len: 649
- turns_before_first_tool: 0
- compaction_count: 1
- skill_invocations: 0
- subagent_dispatches: 2

## Tool Usage

- Bash: 11
- Edit: 7 (1 failed)
- Agent: 2
- Read: 1

## Tool Result Sizes (bytes)

- count: 22
- sum: 14,276
- p50: 352
- p90: 953
- max: 4,020

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 11 calls, 10,839B results, ~34,127 cache_create tok (3.15×)
- Edit: 7 calls, 1,092B results, ~15,866 cache_create tok (14.53×)
- Agent: 2 calls, 1,906B results, ~15,765 cache_create tok (8.27×)
- Read: 1 calls, 423B results, ~346 cache_create tok (0.82×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 48
- usd: $10.7487
- input: 92
- cache_create_5m: 0
- cache_create_1h: 66,489
- cache_read: 31,728,671
- output: 55,395

