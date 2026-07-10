---
kind: cost-report
feature: FEAT-463
run_title: "FEAT463 SLICE421"
usd: 223.8418
duration_ms: 3905687
total_tokens: 164463131
cache_hit_pct: 98.5
source_project: aggregate
aggregate_all: true
source_count: 5
created_at: 2026-07-10T13:51:02.916Z
---

# Cost Report: FEAT463 SLICE421

- Created: 2026-07-10T13:51:02.916Z
- Run Title: FEAT463 SLICE421
- Window Start: 2026-07-10T12:45:36.387Z
- Window End: 2026-07-10T13:50:42.074Z
- Duration: 65.1 min (3905687 ms)
- Sessions Scanned: 5
- Assistant Messages Counted: 618
- Total Tokens: 164,463,131
- Cache Hit %: 98.5%
- Total USD: $223.8418
- Source Project: aggregate
- Auto-detected: no
- Aggregate All: yes

## Sources (aggregated)

- C--work-mega-dev-team: 192 msgs, $160.3145
- C--work-mega-astramemory-plugin: 86 msgs, $29.4508
- C--work-mega-runner-plugin: 133 msgs, $14.0999
- C--work-mega-memory: 119 msgs, $10.8935
- C--work-mega-astramemory-local: 88 msgs, $9.0832

## Tokens (totals)

- input: 164,700
- cache_create_5m: 0
- cache_create_1h: 2,328,019
- cache_read: 161,359,778
- output: 610,634

## Model Mix

- claude-opus-4-8 (priced as claude-opus-4): 278 msgs (44.98%), $189.7652 (84.78%)
- claude-fable-5 (priced as claude-sonnet-4): 340 msgs (55.02%), $34.0766 (15.22%)

## Conversation Shape

- user_msg_count: 50
- user_msg_avg_len: 1835
- turns_before_first_tool: 0
- compaction_count: 0
- skill_invocations: 0
- subagent_dispatches: 9

## Tool Usage

- Bash: 156 (3 failed)
- Edit: 22 (1 failed)
- Read: 17
- SendMessage: 11
- Write: 10
- Agent: 9
- Grep: 9
- TaskCreate: 6
- TaskUpdate: 4
- AskUserQuestion: 2
- ToolSearch: 2

## Tool Result Sizes (bytes)

- count: 248
- sum: 234,371
- p50: 305
- p90: 2,602
- max: 15,212

## File Re-reads

- redundant_read_count: 4
- top paths:
  - 2× C:\work\mega\dev-team\scripts\lib\briefing\workflow.ts
  - 2× C:\work\mega\dev-team\scripts\lib\cost-advisor.ts
  - 2× C:\work\mega\dev-team\scripts\lib\wakeup.mjs
  - 2× C:\work\mega\runner-plugin\.claude\artifacts\loop\ai-loop\slices\pending\SLICE_158_COND-C-WARNING-STUBS-CONFIG-SEEDING-ISSUEBROKER-REUSABLE-OPS.md

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Agent: 9 calls, 3,350B results, ~1,024,512 cache_create tok (305.82×)
- Bash: 155 calls, 146,593B results, ~1,012,010 cache_create tok (6.9×)
- SendMessage: 11 calls, 22,798B results, ~88,846 cache_create tok (3.9×)
- Read: 17 calls, 44,064B results, ~76,695 cache_create tok (1.74×)
- Edit: 22 calls, 4,767B results, ~28,173 cache_create tok (5.91×)
- Write: 10 calls, 2,085B results, ~27,319 cache_create tok (13.1×)
- TaskCreate: 6 calls, 634B results, ~19,639 cache_create tok (30.98×)
- Grep: 9 calls, 7,991B results, ~18,520 cache_create tok (2.32×)
- TaskUpdate: 4 calls, 115B results, ~16,385 cache_create tok (142.48×)
- AskUserQuestion: 2 calls, 1,279B results, ~11,205 cache_create tok (8.76×)
- ToolSearch: 2 calls, 106B results, ~4,171 cache_create tok (39.35×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 340
- usd: $34.0766
- input: 39,725
- cache_create_5m: 0
- cache_create_1h: 824,340
- cache_read: 81,948,000
- output: 295,133

### claude-opus-4-8 (priced as claude-opus-4)
- messages: 278
- usd: $189.7652
- input: 124,975
- cache_create_5m: 0
- cache_create_1h: 1,503,679
- cache_read: 79,411,778
- output: 315,501

