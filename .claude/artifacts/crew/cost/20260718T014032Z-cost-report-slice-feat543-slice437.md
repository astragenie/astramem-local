---
kind: cost-report
feature: FEAT-543
run_title: "FEAT543 SLICE437"
usd: 12.6603
duration_ms: 1544775
total_tokens: 37063611
cache_hit_pct: 99.7
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-18T01:40:32.477Z
---

# Cost Report: FEAT543 SLICE437

- Created: 2026-07-18T01:40:32.477Z
- Run Title: FEAT543 SLICE437
- Window Start: 2026-07-18T01:14:45.906Z
- Window End: 2026-07-18T01:40:30.681Z
- Duration: 25.7 min (1544775 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 65
- Total Tokens: 37,063,611
- Cache Hit %: 99.7%
- Total USD: $12.6603
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 125
- cache_create_5m: 0
- cache_create_1h: 95,187
- cache_read: 36,900,385
- output: 67,914

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 65 msgs (100%), $12.6603 (100%)

## Conversation Shape

- user_msg_count: 9
- user_msg_avg_len: 325
- turns_before_first_tool: 2
- compaction_count: 1
- skill_invocations: 0
- subagent_dispatches: 2

## Tool Usage

- Bash: 13
- Edit: 7
- Agent: 2

## Tool Result Sizes (bytes)

- count: 23
- sum: 18,740
- p50: 303
- p90: 2,075
- max: 6,620

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 13 calls, 8,972B results, ~59,632 cache_create tok (6.65×)
- Edit: 7 calls, 1,242B results, ~14,621 cache_create tok (11.77×)
- Agent: 2 calls, 1,906B results, ~11,337 cache_create tok (5.95×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 65
- usd: $12.6603
- input: 125
- cache_create_5m: 0
- cache_create_1h: 95,187
- cache_read: 36,900,385
- output: 67,914

