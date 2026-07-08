---
kind: cost-report
feature: FEAT-438
run_title: "FEAT438 SLICE416"
usd: 67.6244
duration_ms: 11180366
total_tokens: 83091239
cache_hit_pct: 98.4
source_project: C--work-mega-astramemory-local
aggregate_all: false
source_count: 1
created_at: 2026-07-07T12:22:48.335Z
---

# Cost Report: FEAT438 SLICE416

- Created: 2026-07-07T12:22:48.336Z
- Run Title: FEAT438 SLICE416
- Window Start: 2026-07-07T09:16:27.717Z
- Window End: 2026-07-07T12:22:48.083Z
- Duration: 186.3 min (11180366 ms)
- Sessions Scanned: 3
- Assistant Messages Counted: 344
- Total Tokens: 83,091,239
- Cache Hit %: 98.4%
- Total USD: $67.6244
- Source Project: C--work-mega-astramemory-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 228,483
- cache_create_5m: 0
- cache_create_1h: 1,115,216
- cache_read: 81,419,834
- output: 327,706

## Model Mix

- claude-opus-4-8 (priced as claude-opus-4): 101 msgs (29.36%), $38.6327 (57.13%)
- claude-fable-5 (priced as claude-sonnet-4): 243 msgs (70.64%), $28.9918 (42.87%)

## Conversation Shape

- user_msg_count: 28
- user_msg_avg_len: 459
- turns_before_first_tool: 2
- compaction_count: 10
- skill_invocations: 6
- subagent_dispatches: 9

## Tool Usage

- PowerShell: 59 (3 failed)
- Bash: 26 (2 failed)
- Read: 16
- Edit: 13 (3 failed)
- Agent: 9
- Grep: 6
- Skill: 6
- Write: 6
- Glob: 2 (1 failed)
- AskUserQuestion: 1
- ToolSearch: 1

## Tool Result Sizes (bytes)

- count: 145
- sum: 277,973
- p50: 491
- p90: 2,824
- max: 136,005

## File Re-reads

- redundant_read_count: 4
- top paths:
  - 2× C:\Users\serge\.claude\projects\C--work-mega-astramemory-local\memory\sibling-repos.md
  - 2× C:\work\mega\astramemory-local\.claude\artifacts\loop\plans\20260707T091627Z-plan-SLICE-416.md
  - 2× C:\work\mega\astramemory-local\.claude\artifacts\loop\ai-loop\slices\pending\SLICE_416_RELEASE-DIR-MATERIALIZATION-DIST-PROD-NODE-MODULES-AC-5-FAIL.md
  - 2× C:\work\mega\astramemory-plugin\tests\hooks\shim.test.ts

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- PowerShell: 59 calls, 49,815B results, ~270,500 cache_create tok (5.43×)
- Bash: 25 calls, 22,203B results, ~214,042 cache_create tok (9.64×)
- Skill: 6 calls, 206B results, ~166,248 cache_create tok (807.03×)
- Glob: 2 calls, 120B results, ~86,586 cache_create tok (721.55×)
- Read: 16 calls, 35,332B results, ~85,437 cache_create tok (2.42×)
- Agent: 9 calls, 10,557B results, ~79,014 cache_create tok (7.48×)
- Grep: 6 calls, 14,828B results, ~58,334 cache_create tok (3.93×)
- Write: 6 calls, 1,171B results, ~27,429 cache_create tok (23.42×)
- Edit: 13 calls, 138,097B results, ~23,803 cache_create tok (0.17×)
- AskUserQuestion: 1 calls, 180B results, ~3,632 cache_create tok (20.18×)
- ToolSearch: 1 calls, 49B results, ~2,991 cache_create tok (61.04×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 243
- usd: $28.9918
- input: 137,630
- cache_create_5m: 0
- cache_create_1h: 784,139
- cache_read: 71,108,246
- output: 169,437

### claude-opus-4-8 (priced as claude-opus-4)
- messages: 101
- usd: $38.6327
- input: 90,853
- cache_create_5m: 0
- cache_create_1h: 331,077
- cache_read: 10,311,588
- output: 158,269

