---
kind: cost-report
feature: FEAT-543
run_title: "FEAT543 SLICE437"
usd: 13.4583
duration_ms: 1575561
total_tokens: 39434747
cache_hit_pct: 99.7
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-18T01:41:02.735Z
---

# Cost Report: FEAT543 SLICE437

- Created: 2026-07-18T01:41:02.735Z
- Run Title: FEAT543 SLICE437
- Window Start: 2026-07-18T01:14:45.906Z
- Window End: 2026-07-18T01:41:01.467Z
- Duration: 26.3 min (1575561 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 69
- Total Tokens: 39,434,747
- Cache Hit %: 99.7%
- Total USD: $13.4583
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 133
- cache_create_5m: 0
- cache_create_1h: 99,761
- cache_read: 39,262,820
- output: 72,033

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 69 msgs (100%), $13.4583 (100%)

## Conversation Shape

- user_msg_count: 9
- user_msg_avg_len: 325
- turns_before_first_tool: 2
- compaction_count: 1
- skill_invocations: 0
- subagent_dispatches: 2

## Tool Usage

- Bash: 14
- Edit: 7
- Agent: 2
- Write: 1

## Tool Result Sizes (bytes)

- count: 25
- sum: 20,684
- p50: 303
- p90: 2,075
- max: 6,620

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 14 calls, 10,698B results, ~64,206 cache_create tok (6×)
- Edit: 7 calls, 1,242B results, ~14,621 cache_create tok (11.77×)
- Agent: 2 calls, 1,906B results, ~11,337 cache_create tok (5.95×)
- Write: 1 calls, 218B results, ~0 cache_create tok (0×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 69
- usd: $13.4583
- input: 133
- cache_create_5m: 0
- cache_create_1h: 99,761
- cache_read: 39,262,820
- output: 72,033

