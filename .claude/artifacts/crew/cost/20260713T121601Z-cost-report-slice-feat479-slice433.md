---
kind: cost-report
feature: FEAT-479
run_title: "FEAT479 SLICE433"
usd: 18.7818
duration_ms: 3336926
total_tokens: 47779269
cache_hit_pct: 99
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-13T12:16:01.916Z
---

# Cost Report: FEAT479 SLICE433

- Created: 2026-07-13T12:16:01.917Z
- Run Title: FEAT479 SLICE433
- Window Start: 2026-07-13T11:20:24.258Z
- Window End: 2026-07-13T12:16:01.184Z
- Duration: 55.6 min (3336926 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 152
- Total Tokens: 47,779,269
- Cache Hit %: 99%
- Total USD: $18.7818
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 304
- cache_create_5m: 0
- cache_create_1h: 479,375
- cache_read: 47,182,942
- output: 116,648

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 152 msgs (100%), $18.7818 (100%)

## Conversation Shape

- user_msg_count: 28
- user_msg_avg_len: 2466
- turns_before_first_tool: 0
- compaction_count: 1
- skill_invocations: 0
- subagent_dispatches: 6

## Tool Usage

- Bash: 32
- Read: 8
- Agent: 6
- Edit: 4 (1 failed)
- Write: 3
- Grep: 3
- SendMessage: 2
- PowerShell: 1 (1 failed)

## Tool Result Sizes (bytes)

- count: 60
- sum: 45,778
- p50: 309
- p90: 2,039
- max: 4,518

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- SendMessage: 2 calls, 2,734B results, ~215,618 cache_create tok (78.87×)
- Bash: 32 calls, 25,458B results, ~99,328 cache_create tok (3.9×)
- Agent: 6 calls, 1,860B results, ~98,354 cache_create tok (52.88×)
- Read: 8 calls, 8,106B results, ~20,717 cache_create tok (2.56×)
- Grep: 3 calls, 5,063B results, ~16,299 cache_create tok (3.22×)
- Write: 3 calls, 671B results, ~13,975 cache_create tok (20.83×)
- Edit: 4 calls, 556B results, ~10,022 cache_create tok (18.03×)
- PowerShell: 1 calls, 928B results, ~4,524 cache_create tok (4.88×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 152
- usd: $18.7818
- input: 304
- cache_create_5m: 0
- cache_create_1h: 479,375
- cache_read: 47,182,942
- output: 116,648

