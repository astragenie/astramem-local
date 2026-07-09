---
kind: cost-report
feature: FEAT-441
run_title: "FEAT441 SLICE419"
usd: 221.7368
duration_ms: 4391355
total_tokens: 109937819
cache_hit_pct: 98.1
source_project: aggregate
aggregate_all: true
source_count: 4
created_at: 2026-07-09T11:06:19.199Z
---

# Cost Report: FEAT441 SLICE419

- Created: 2026-07-09T11:06:19.199Z
- Run Title: FEAT441 SLICE419
- Window Start: 2026-07-09T09:52:50.013Z
- Window End: 2026-07-09T11:06:01.368Z
- Duration: 73.2 min (4391355 ms)
- Sessions Scanned: 5
- Assistant Messages Counted: 387
- Total Tokens: 109,937,819
- Cache Hit %: 98.1%
- Total USD: $221.7368
- Source Project: aggregate
- Auto-detected: no
- Aggregate All: yes

## Sources (aggregated)

- C--work-mega-memory: 213 msgs, $123.9562
- C--work-mega-astramemory-plugin: 100 msgs, $54.1618
- C--work-mega-astramemory-local: 70 msgs, $41.0873
- C--work-mega-runner: 4 msgs, $2.5315

## Tokens (totals)

- input: 146,559
- cache_create_5m: 0
- cache_create_1h: 1,883,081
- cache_read: 107,315,874
- output: 592,305

## Model Mix

- claude-opus-4-8 (priced as claude-opus-4): 299 msgs (77.26%), $211.1491 (95.23%)
- claude-fable-5 (priced as claude-sonnet-4): 88 msgs (22.74%), $10.5877 (4.77%)

## Conversation Shape

- user_msg_count: 39
- user_msg_avg_len: 1426
- turns_before_first_tool: 2
- compaction_count: 5
- skill_invocations: 2
- subagent_dispatches: 23

## Tool Usage

- Bash: 47
- Edit: 28
- Agent: 23
- PowerShell: 10 (3 failed)
- Read: 8
- SendMessage: 6
- Write: 5
- mcp__plugin_azure_azure__keyvault: 4
- ToolSearch: 3
- TaskStop: 3
- AskUserQuestion: 2
- Skill: 2
- mcp__plugin_azure_azure__group_resource_list: 2
- Artifact: 1

## Tool Result Sizes (bytes)

- count: 144
- sum: 226,941
- p50: 429
- p90: 3,919
- max: 20,791

## File Re-reads

- redundant_read_count: 1
- top paths:
  - 2× C:\Users\serge\AppData\Local\Temp\claude\C--work-mega-astramemory-plugin\0de8119b-b035-4fc1-a4d7-6ee86ed6fc14\scratchpad\arch-gate-plan-v2.md

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- ToolSearch: 3 calls, 346B results, ~827,850 cache_create tok (2392.63×)
- Bash: 46 calls, 49,019B results, ~353,248 cache_create tok (7.21×)
- Agent: 23 calls, 75,868B results, ~262,762 cache_create tok (3.46×)
- Edit: 28 calls, 6,709B results, ~113,204 cache_create tok (16.87×)
- PowerShell: 10 calls, 17,197B results, ~66,369 cache_create tok (3.86×)
- Read: 8 calls, 34,952B results, ~65,854 cache_create tok (1.88×)
- Write: 5 calls, 1,164B results, ~58,073 cache_create tok (49.89×)
- SendMessage: 6 calls, 3,360B results, ~47,100 cache_create tok (14.02×)
- mcp__plugin_azure_azure__keyvault: 4 calls, 22,733B results, ~30,450 cache_create tok (1.34×)
- AskUserQuestion: 2 calls, 218B results, ~17,873 cache_create tok (81.99×)
- mcp__plugin_azure_azure__group_resource_list: 2 calls, 8,961B results, ~13,658 cache_create tok (1.52×)
- Skill: 2 calls, 61B results, ~13,630 cache_create tok (223.44×)
- TaskStop: 3 calls, 600B results, ~4,675 cache_create tok (7.79×)
- Artifact: 1 calls, 222B results, ~544 cache_create tok (2.45×)


## By Model (token detail)

### claude-opus-4-8 (priced as claude-opus-4)
- messages: 299
- usd: $211.1491
- input: 106,657
- cache_create_5m: 0
- cache_create_1h: 1,769,450
- cache_read: 77,687,915
- output: 532,452

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 88
- usd: $10.5877
- input: 39,902
- cache_create_5m: 0
- cache_create_1h: 113,631
- cache_read: 29,627,959
- output: 59,853

