---
kind: cost-report
feature: FEAT-481
run_title: "FEAT481 SLICE428"
usd: 11.2302
duration_ms: 1854983
total_tokens: 31061565
cache_hit_pct: 99.6
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-13T13:31:40.072Z
---

# Cost Report: FEAT481 SLICE428

- Created: 2026-07-13T13:31:40.072Z
- Run Title: FEAT481 SLICE428
- Window Start: 2026-07-13T13:00:44.412Z
- Window End: 2026-07-13T13:31:39.395Z
- Duration: 30.9 min (1854983 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 104
- Total Tokens: 31,061,565
- Cache Hit %: 99.6%
- Total USD: $11.2302
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 208
- cache_create_5m: 0
- cache_create_1h: 132,400
- cache_read: 30,850,286
- output: 78,671

## Model Mix

- claude-fable-5 (priced as claude-sonnet-4): 104 msgs (100%), $11.2302 (100%)

## Conversation Shape

- user_msg_count: 8
- user_msg_avg_len: 1756
- turns_before_first_tool: 2
- compaction_count: 0
- skill_invocations: 0
- subagent_dispatches: 2

## Tool Usage

- Bash: 28 (1 failed)
- Read: 9
- PowerShell: 6
- Edit: 3
- Agent: 2
- SendMessage: 2
- Write: 1

## Tool Result Sizes (bytes)

- count: 51
- sum: 44,027
- p50: 303
- p90: 1,487
- max: 10,043

## File Re-reads

- redundant_read_count: 2
- top paths:
  - 2× C:\work\mega\astramemory-local\src\server\app.ts
  - 2× C:\Users\serge\AppData\Local\Temp\claude\C--work-mega-astramemory-local\e08b8f83-3c57-4a1c-8134-fd9b38adb8fe\tasks\bh5xg4fpy.output

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 27 calls, 14,181B results, ~48,824 cache_create tok (3.44×)
- PowerShell: 6 calls, 11,899B results, ~26,874 cache_create tok (2.26×)
- SendMessage: 2 calls, 1,168B results, ~18,673 cache_create tok (15.99×)
- Read: 9 calls, 7,870B results, ~13,210 cache_create tok (1.68×)
- Agent: 2 calls, 1,256B results, ~9,992 cache_create tok (7.96×)
- Edit: 3 calls, 526B results, ~2,829 cache_create tok (5.38×)
- Write: 1 calls, 219B results, ~1,483 cache_create tok (6.77×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 104
- usd: $11.2302
- input: 208
- cache_create_5m: 0
- cache_create_1h: 132,400
- cache_read: 30,850,286
- output: 78,671

