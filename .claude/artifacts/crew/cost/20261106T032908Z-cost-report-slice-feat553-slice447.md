---
kind: cost-report
feature: FEAT-553
run_title: "FEAT553 SLICE447"
usd: 1.5038
duration_ms: 51330
total_tokens: 4094784
cache_hit_pct: 99.5
source_project: C--work-mega-astramem-local
aggregate_all: false
source_count: 1
created_at: 2026-11-06T03:29:08.075Z
---

# Cost Report: FEAT553 SLICE447

- Created: 2026-11-06T03:29:08.075Z
- Run Title: FEAT553 SLICE447
- Window Start: 2026-11-06T03:28:16.487Z
- Window End: 2026-11-06T03:29:07.817Z
- Duration: 0.9 min (51330 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 6
- Total Tokens: 4,094,784
- Cache Hit %: 99.5%
- Total USD: $1.5038
- Source Project: C--work-mega-astramem-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 192
- cache_create_5m: 0
- cache_create_1h: 20,820
- cache_read: 4,063,149
- output: 10,623

## Model Mix

- claude-fable-5-1 (priced as claude-sonnet-4): 6 msgs (100%), $1.5038 (100%)

## Conversation Shape

- user_msg_count: 0
- user_msg_avg_len: 0
- turns_before_first_tool: 2
- compaction_count: 0
- skill_invocations: 0
- subagent_dispatches: 0

## Tool Usage

- Bash: 2
- Write: 1

## Tool Result Sizes (bytes)

- count: 4
- sum: 4,809
- p50: 1,282
- p90: 2,306
- max: 2,306

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 1 calls, 2,306B results, ~4,938 cache_create tok (2.14×)
- Write: 1 calls, 189B results, ~2,469 cache_create tok (13.06×)


## By Model (token detail)

### claude-fable-5-1 (priced as claude-sonnet-4)
- messages: 6
- usd: $1.5038
- input: 192
- cache_create_5m: 0
- cache_create_1h: 20,820
- cache_read: 4,063,149
- output: 10,623

