---
kind: cost-report
feature: FEAT-461
run_title: "FEAT461 SLICE420"
usd: 6.032
duration_ms: 2622592
total_tokens: 11926083
cache_hit_pct: 97.9
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-10T12:39:46.427Z
---

# Cost Report: FEAT461 SLICE420

- Created: 2026-07-10T12:39:46.427Z
- Run Title: FEAT461 SLICE420
- Window Start: 2026-07-10T11:56:02.607Z
- Window End: 2026-07-10T12:39:45.199Z
- Duration: 43.7 min (2622592 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 68
- Total Tokens: 11,926,083
- Cache Hit %: 97.9%
- Total USD: $6.0320
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 1,537
- cache_create_5m: 0
- cache_create_1h: 250,705
- cache_read: 11,604,384
- output: 69,457

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 68 msgs (100%), $6.0320 (100%)

## Conversation Shape

- user_msg_count: 17
- user_msg_avg_len: 2179
- turns_before_first_tool: 2
- compaction_count: 0
- skill_invocations: 0
- subagent_dispatches: 4

## Tool Usage

- Bash: 5
- Agent: 4
- SendMessage: 4
- Write: 3
- Edit: 2 (1 failed)
- ToolSearch: 1
- Read: 1

## Tool Result Sizes (bytes)

- count: 21
- sum: 24,448
- p50: 307
- p90: 2,836
- max: 5,560

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- ToolSearch: 1 calls, 53B results, ~150,747 cache_create tok (2844.28×)
- Agent: 4 calls, 1,218B results, ~33,254 cache_create tok (27.3×)
- SendMessage: 4 calls, 8,002B results, ~22,440 cache_create tok (2.8×)
- Bash: 5 calls, 5,673B results, ~16,464 cache_create tok (2.9×)
- Write: 3 calls, 557B results, ~13,798 cache_create tok (24.77×)
- Edit: 2 calls, 281B results, ~4,586 cache_create tok (16.32×)
- Read: 1 calls, 3,104B results, ~1,463 cache_create tok (0.47×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 68
- usd: $6.0320
- input: 1,537
- cache_create_5m: 0
- cache_create_1h: 250,705
- cache_read: 11,604,384
- output: 69,457

