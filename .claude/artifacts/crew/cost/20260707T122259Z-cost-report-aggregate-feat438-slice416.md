---
kind: cost-report
feature: FEAT-438
run_title: "FEAT438 SLICE416"
usd: 467.1022
duration_ms: 11180640
total_tokens: 267782451
cache_hit_pct: 98.4
source_project: aggregate
aggregate_all: true
source_count: 6
created_at: 2026-07-07T12:22:59.429Z
---

# Cost Report: FEAT438 SLICE416

- Created: 2026-07-07T12:22:59.429Z
- Run Title: FEAT438 SLICE416
- Window Start: 2026-07-07T09:16:27.717Z
- Window End: 2026-07-07T12:22:48.357Z
- Duration: 186.3 min (11180640 ms)
- Sessions Scanned: 11
- Assistant Messages Counted: 1188
- Total Tokens: 267,782,451
- Cache Hit %: 98.4%
- Total USD: $467.1022
- Source Project: aggregate
- Auto-detected: no
- Aggregate All: yes

## Sources (aggregated)

- C--work-mega-dev-team: 336 msgs, $160.4643
- C--work-mega-memory: 246 msgs, $147.0183
- C--work-mega-astramemory-local: 344 msgs, $67.6244
- C--work-mega-devops: 144 msgs, $46.8079
- C--work-mega-runner-plugin: 80 msgs, $28.5377
- C--work-mega-astramemory-plugin: 38 msgs, $16.6495

## Tokens (totals)

- input: 754,643
- cache_create_5m: 0
- cache_create_1h: 3,617,525
- cache_read: 262,220,810
- output: 1,189,473

## Model Mix

- claude-opus-4-8 (priced as claude-opus-4): 904 msgs (76.09%), $433.2810 (92.76%)
- claude-fable-5 (priced as claude-sonnet-4): 284 msgs (23.91%), $33.8212 (7.24%)

## Conversation Shape

- user_msg_count: 90
- user_msg_avg_len: 448
- turns_before_first_tool: 2
- compaction_count: 17
- skill_invocations: 6
- subagent_dispatches: 19

## Tool Usage

- Bash: 220 (2 failed)
- PowerShell: 62 (3 failed)
- Read: 59 (1 failed)
- Edit: 50 (3 failed)
- Agent: 19
- Write: 17
- Grep: 14
- Skill: 6
- ToolSearch: 6
- SendMessage: 5 (1 failed)
- Glob: 3 (1 failed)
- AskUserQuestion: 2
- TaskList: 1
- TaskUpdate: 1

## Tool Result Sizes (bytes)

- count: 464
- sum: 640,893
- p50: 361
- p90: 3,326
- max: 136,005

## File Re-reads

- redundant_read_count: 10
- top paths:
  - 4× C:\work\mega\memory-redis-fix\.github\workflows\deploy-azure-prod.yml
  - 3× C:\work\mega\memory\.github\workflows\deploy-azure-prod.yml
  - 2× C:\work\mega\astramemory-local\.claude\artifacts\loop\ai-loop\slices\pending\SLICE_416_RELEASE-DIR-MATERIALIZATION-DIST-PROD-NODE-MODULES-AC-5-FAIL.md
  - 2× C:\work\mega\astramemory-local\.claude\artifacts\loop\plans\20260707T091627Z-plan-SLICE-416.md
  - 2× C:\work\mega\astramemory-plugin\tests\hooks\shim.test.ts

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 219 calls, 188,694B results, ~1,556,104 cache_create tok (8.25×)
- Read: 59 calls, 176,936B results, ~422,353 cache_create tok (2.39×)
- ToolSearch: 6 calls, 417B results, ~334,917 cache_create tok (803.16×)
- PowerShell: 62 calls, 59,941B results, ~326,631 cache_create tok (5.45×)
- Grep: 14 calls, 24,225B results, ~187,898 cache_create tok (7.76×)
- Skill: 6 calls, 206B results, ~166,248 cache_create tok (807.03×)
- Glob: 3 calls, 10,707B results, ~163,163 cache_create tok (15.24×)
- Agent: 18 calls, 21,595B results, ~152,267 cache_create tok (7.05×)
- Edit: 50 calls, 144,935B results, ~140,033 cache_create tok (0.97×)
- Write: 17 calls, 3,493B results, ~124,695 cache_create tok (35.7×)
- SendMessage: 5 calls, 3,933B results, ~24,858 cache_create tok (6.32×)
- AskUserQuestion: 2 calls, 360B results, ~9,509 cache_create tok (26.41×)
- TaskList: 1 calls, 14B results, ~498 cache_create tok (35.57×)
- TaskUpdate: 1 calls, 22B results, ~176 cache_create tok (8×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 284
- usd: $33.8212
- input: 145,957
- cache_create_5m: 0
- cache_create_1h: 817,985
- cache_read: 85,341,756
- output: 191,527

### claude-opus-4-8 (priced as claude-opus-4)
- messages: 904
- usd: $433.2810
- input: 608,686
- cache_create_5m: 0
- cache_create_1h: 2,799,540
- cache_read: 176,879,054
- output: 997,946

