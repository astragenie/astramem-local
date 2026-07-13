---
kind: cost-report
feature: FEAT-479
run_title: "FEAT479 SLICE432"
usd: 16.1712
duration_ms: 2701753
total_tokens: 48317988
cache_hit_pct: 99.8
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-13T11:20:22.924Z
---

# Cost Report: FEAT479 SLICE432

- Created: 2026-07-13T11:20:22.924Z
- Run Title: FEAT479 SLICE432
- Window Start: 2026-07-13T10:35:20.075Z
- Window End: 2026-07-13T11:20:21.828Z
- Duration: 45.0 min (2701753 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 90
- Total Tokens: 48,317,988
- Cache Hit %: 99.8%
- Total USD: $16.1712
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 180
- cache_create_5m: 0
- cache_create_1h: 116,268
- cache_read: 48,132,654
- output: 68,886

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 90 msgs (100%), $16.1712 (100%)

## Conversation Shape

- user_msg_count: 21
- user_msg_avg_len: 2266
- turns_before_first_tool: 2
- compaction_count: 0
- skill_invocations: 0
- subagent_dispatches: 6

## Tool Usage

- Bash: 11
- Agent: 6
- SendMessage: 6
- PowerShell: 4
- Write: 2
- Read: 1

## Tool Result Sizes (bytes)

- count: 30
- sum: 18,357
- p50: 315
- p90: 1,488
- max: 3,460

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- SendMessage: 6 calls, 6,191B results, ~49,620 cache_create tok (8.01×)
- Agent: 6 calls, 1,842B results, ~34,815 cache_create tok (18.9×)
- Bash: 11 calls, 7,970B results, ~23,378 cache_create tok (2.93×)
- Write: 2 calls, 435B results, ~2,687 cache_create tok (6.18×)
- PowerShell: 3 calls, 680B results, ~2,347 cache_create tok (3.45×)
- Read: 1 calls, 646B results, ~445 cache_create tok (0.69×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 90
- usd: $16.1712
- input: 180
- cache_create_5m: 0
- cache_create_1h: 116,268
- cache_read: 48,132,654
- output: 68,886

