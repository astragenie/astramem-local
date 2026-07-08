---
kind: cost-report
feature: FEAT-438
run_title: "FEAT438 SLICE417"
usd: 59.2361
duration_ms: 2291889
total_tokens: 22970325
cache_hit_pct: 98.4
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-07T13:04:14.581Z
---

# Cost Report: FEAT438 SLICE417

- Created: 2026-07-07T13:04:14.582Z
- Run Title: FEAT438 SLICE417
- Window Start: 2026-07-07T12:26:02.281Z
- Window End: 2026-07-07T13:04:14.170Z
- Duration: 38.2 min (2291889 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 103
- Total Tokens: 22,970,325
- Cache Hit %: 98.4%
- Total USD: $59.2361
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 41,858
- cache_create_5m: 0
- cache_create_1h: 313,644
- cache_read: 22,406,977
- output: 207,846

## Model Mix

- claude-opus-4-8 (priced as claude-opus-4): 103 msgs (100%), $59.2361 (100%)

## Conversation Shape

- user_msg_count: 11
- user_msg_avg_len: 2276
- turns_before_first_tool: 2
- compaction_count: 0
- skill_invocations: 0
- subagent_dispatches: 12

## Tool Usage

- Agent: 12
- Bash: 10
- Edit: 8
- Read: 5
- Write: 1

## Tool Result Sizes (bytes)

- count: 37
- sum: 44,568
- p50: 953
- p90: 2,794
- max: 6,454

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Agent: 12 calls, 11,436B results, ~135,084 cache_create tok (11.81×)
- Bash: 10 calls, 10,456B results, ~86,100 cache_create tok (8.23×)
- Read: 5 calls, 15,252B results, ~38,613 cache_create tok (2.53×)
- Edit: 8 calls, 1,807B results, ~34,084 cache_create tok (18.86×)
- Write: 1 calls, 186B results, ~2,351 cache_create tok (12.64×)


## By Model (token detail)

### claude-opus-4-8 (priced as claude-opus-4)
- messages: 103
- usd: $59.2361
- input: 41,858
- cache_create_5m: 0
- cache_create_1h: 313,644
- cache_read: 22,406,977
- output: 207,846

