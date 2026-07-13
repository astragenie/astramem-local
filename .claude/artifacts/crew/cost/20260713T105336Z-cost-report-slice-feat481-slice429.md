---
kind: cost-report
feature: FEAT-481
run_title: "FEAT481 SLICE429"
usd: 7.2918
duration_ms: 1095810
total_tokens: 21363251
cache_hit_pct: 99.7
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-13T10:53:36.652Z
---

# Cost Report: FEAT481 SLICE429

- Created: 2026-07-13T10:53:36.652Z
- Run Title: FEAT481 SLICE429
- Window Start: 2026-07-13T10:35:20.075Z
- Window End: 2026-07-13T10:53:35.885Z
- Duration: 18.3 min (1095810 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 41
- Total Tokens: 21,363,251
- Cache Hit %: 99.7%
- Total USD: $7.2918
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 82
- cache_create_5m: 0
- cache_create_1h: 61,383
- cache_read: 21,265,545
- output: 36,241

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 41 msgs (100%), $7.2918 (100%)

## Conversation Shape

- user_msg_count: 9
- user_msg_avg_len: 2288
- turns_before_first_tool: 2
- compaction_count: 0
- skill_invocations: 0
- subagent_dispatches: 3

## Tool Usage

- Bash: 6
- Agent: 3
- SendMessage: 2
- Write: 1

## Tool Result Sizes (bytes)

- count: 13
- sum: 8,325
- p50: 315
- p90: 1,010
- max: 3,460

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- SendMessage: 2 calls, 1,450B results, ~23,972 cache_create tok (16.53×)
- Agent: 3 calls, 927B results, ~20,090 cache_create tok (21.67×)
- Bash: 6 calls, 5,129B results, ~13,241 cache_create tok (2.58×)
- Write: 1 calls, 226B results, ~1,104 cache_create tok (4.88×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 41
- usd: $7.2918
- input: 82
- cache_create_5m: 0
- cache_create_1h: 61,383
- cache_read: 21,265,545
- output: 36,241

