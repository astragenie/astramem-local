---
kind: cost-report
run_title: "FEAT-480 deferred to 0.21 — no clean FTS revival"
usd: 68.7016
duration_ms: 136562645
total_tokens: 24059630
cache_hit_pct: 97.6
source_project: C--work-mega-astramem-local
aggregate_all: false
source_count: 1
created_at: 2026-07-19T17:31:08.913Z
---

# Cost Report: FEAT-480 deferred to 0.21 — no clean FTS revival

- Created: 2026-07-19T17:31:08.913Z
- Run Title: FEAT-480 deferred to 0.21 — no clean FTS revival
- Window Start: 2026-07-18T03:35:06.172Z
- Window End: 2026-07-19T17:31:08.817Z
- Duration: 2276.0 min (136562645 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 168
- Total Tokens: 24,059,630
- Cache Hit %: 97.6%
- Total USD: $68.7016
- Source Project: C--work-mega-astramem-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 302
- cache_create_5m: 0
- cache_create_1h: 579,022
- cache_read: 23,261,178
- output: 219,128

## Model Mix

- claude-opus-4-8 (priced as claude-opus-4): 168 msgs (100%), $68.7016 (100%)

## Conversation Shape

- user_msg_count: 8
- user_msg_avg_len: 1610
- turns_before_first_tool: 2
- compaction_count: 3
- skill_invocations: 1
- subagent_dispatches: 4

## Tool Usage

- Bash: 39 (1 failed)
- SendMessage: 5
- AskUserQuestion: 4
- Agent: 4
- Grep: 3
- PowerShell: 2
- Read: 1
- Skill: 1
- ToolSearch: 1

## Tool Result Sizes (bytes)

- count: 60
- sum: 90,611
- p50: 517
- p90: 2,969
- max: 17,416

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 39 calls, 52,750B results, ~155,301 cache_create tok (2.94×)
- PowerShell: 2 calls, 19,553B results, ~70,720 cache_create tok (3.62×)
- SendMessage: 5 calls, 2,580B results, ~56,518 cache_create tok (21.91×)
- Agent: 4 calls, 8,932B results, ~42,318 cache_create tok (4.74×)
- AskUserQuestion: 4 calls, 894B results, ~40,527 cache_create tok (45.33×)
- Skill: 1 calls, 27B results, ~30,048 cache_create tok (1112.89×)
- Grep: 3 calls, 3,238B results, ~16,158 cache_create tok (4.99×)
- Read: 1 calls, 2,584B results, ~4,179 cache_create tok (1.62×)
- ToolSearch: 1 calls, 53B results, ~1,544 cache_create tok (29.13×)


## By Model (token detail)

### claude-opus-4-8 (priced as claude-opus-4)
- messages: 168
- usd: $68.7016
- input: 302
- cache_create_5m: 0
- cache_create_1h: 579,022
- cache_read: 23,261,178
- output: 219,128

