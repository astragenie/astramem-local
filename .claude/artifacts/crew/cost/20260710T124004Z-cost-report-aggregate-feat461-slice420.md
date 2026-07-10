---
kind: cost-report
feature: FEAT-461
run_title: "FEAT461 SLICE420"
usd: 157.4054
duration_ms: 2623830
total_tokens: 120667210
cache_hit_pct: 99.3
source_project: aggregate
aggregate_all: true
source_count: 3
created_at: 2026-07-10T12:40:04.684Z
---

# Cost Report: FEAT461 SLICE420

- Created: 2026-07-10T12:40:04.684Z
- Run Title: FEAT461 SLICE420
- Window Start: 2026-07-10T11:56:02.607Z
- Window End: 2026-07-10T12:39:46.437Z
- Duration: 43.7 min (2623830 ms)
- Sessions Scanned: 3
- Assistant Messages Counted: 517
- Total Tokens: 120,667,210
- Cache Hit %: 99.3%
- Total USD: $157.4054
- Source Project: aggregate
- Auto-detected: no
- Aggregate All: yes

## Sources (aggregated)

- C--work-mega-dev-team: 292 msgs, $138.6989
- C--work-mega-runner-plugin: 154 msgs, $12.4432
- C--work-mega-astramemory-local: 71 msgs, $6.2634

## Tokens (totals)

- input: 47,334
- cache_create_5m: 0
- cache_create_1h: 735,404
- cache_read: 119,481,304
- output: 403,168

## Model Mix

- claude-opus-4-8 (priced as claude-opus-4): 292 msgs (56.48%), $138.6989 (88.12%)
- claude-fable-5 (priced as claude-sonnet-4): 225 msgs (43.52%), $18.7066 (11.88%)

## Conversation Shape

- user_msg_count: 28
- user_msg_avg_len: 2188
- turns_before_first_tool: 2
- compaction_count: 3
- skill_invocations: 0
- subagent_dispatches: 8

## Tool Usage

- Bash: 147 (3 failed)
- Edit: 40 (7 failed)
- Read: 11 (1 failed)
- TaskUpdate: 9
- Agent: 8
- Write: 6
- SendMessage: 4
- ToolSearch: 1
- TaskList: 1
- TaskCreate: 1

## Tool Result Sizes (bytes)

- count: 228
- sum: 137,458
- p50: 267
- p90: 1,661
- max: 5,560

## File Re-reads

- redundant_read_count: 2
- top paths:
  - 3× C:\work\mega\plugins-common\packages\plugin-registry\src\cli.ts

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 146 calls, 91,486B results, ~350,018 cache_create tok (3.83×)
- ToolSearch: 1 calls, 53B results, ~150,747 cache_create tok (2844.28×)
- Edit: 40 calls, 7,438B results, ~72,948 cache_create tok (9.81×)
- Agent: 8 calls, 2,448B results, ~53,752 cache_create tok (21.96×)
- Read: 11 calls, 20,529B results, ~45,249 cache_create tok (2.2×)
- SendMessage: 4 calls, 8,002B results, ~22,440 cache_create tok (2.8×)
- Write: 6 calls, 1,194B results, ~17,670 cache_create tok (14.8×)
- TaskUpdate: 9 calls, 198B results, ~8,288 cache_create tok (41.86×)
- TaskCreate: 1 calls, 128B results, ~5,785 cache_create tok (45.2×)
- TaskList: 1 calls, 422B results, ~554 cache_create tok (1.31×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 225
- usd: $18.7066
- input: 16,379
- cache_create_5m: 0
- cache_create_1h: 416,605
- cache_read: 45,205,877
- output: 173,069

### claude-opus-4-8 (priced as claude-opus-4)
- messages: 292
- usd: $138.6989
- input: 30,955
- cache_create_5m: 0
- cache_create_1h: 318,799
- cache_read: 74,275,427
- output: 230,099

