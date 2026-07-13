---
kind: cost-report
feature: FEAT-481
run_title: "FEAT481 SLICE427"
usd: 11.1321
duration_ms: 1373635
total_tokens: 32393673
cache_hit_pct: 99.6
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-13T10:20:38.971Z
---

# Cost Report: FEAT481 SLICE427

- Created: 2026-07-13T10:20:38.971Z
- Run Title: FEAT481 SLICE427
- Window Start: 2026-07-13T09:57:44.517Z
- Window End: 2026-07-13T10:20:38.152Z
- Duration: 22.9 min (1373635 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 71
- Total Tokens: 32,393,673
- Cache Hit %: 99.6%
- Total USD: $11.1321
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 142
- cache_create_5m: 0
- cache_create_1h: 120,616
- cache_read: 32,223,519
- output: 49,396

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 71 msgs (100%), $11.1321 (100%)

## Conversation Shape

- user_msg_count: 17
- user_msg_avg_len: 2224
- turns_before_first_tool: 2
- compaction_count: 1
- skill_invocations: 1
- subagent_dispatches: 4

## Tool Usage

- SendMessage: 7
- Bash: 6
- Agent: 4
- PowerShell: 2
- Skill: 1

## Tool Result Sizes (bytes)

- count: 20
- sum: 32,864
- p50: 733
- p90: 4,374
- max: 15,623

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- SendMessage: 7 calls, 6,959B results, ~39,453 cache_create tok (5.67×)
- Bash: 6 calls, 9,017B results, ~26,717 cache_create tok (2.96×)
- Agent: 4 calls, 1,230B results, ~17,571 cache_create tok (14.29×)
- PowerShell: 1 calls, 6B results, ~7,692 cache_create tok (1282×)
- Skill: 1 calls, 29B results, ~7,664 cache_create tok (264.28×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 71
- usd: $11.1321
- input: 142
- cache_create_5m: 0
- cache_create_1h: 120,616
- cache_read: 32,223,519
- output: 49,396

