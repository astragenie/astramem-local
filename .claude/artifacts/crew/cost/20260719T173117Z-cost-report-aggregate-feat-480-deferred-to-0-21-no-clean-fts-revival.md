---
kind: cost-report
run_title: "FEAT-480 deferred to 0.21 — no clean FTS revival"
usd: 1825.2636
duration_ms: 136562645
total_tokens: 2225828335
cache_hit_pct: 98.9
source_project: aggregate
aggregate_all: true
source_count: 10
created_at: 2026-07-19T17:31:17.688Z
---

# Cost Report: FEAT-480 deferred to 0.21 — no clean FTS revival

- Created: 2026-07-19T17:31:17.688Z
- Run Title: FEAT-480 deferred to 0.21 — no clean FTS revival
- Window Start: 2026-07-18T03:35:06.172Z
- Window End: 2026-07-19T17:31:08.817Z
- Duration: 2276.0 min (136562645 ms)
- Sessions Scanned: 19
- Assistant Messages Counted: 8651
- Total Tokens: 2,225,828,335
- Cache Hit %: 98.9%
- Total USD: $1825.2636
- Source Project: aggregate
- Auto-detected: no
- Aggregate All: yes

## Sources (aggregated)

- C--work-mega-devops: 3321 msgs, $565.4672
- C--work-mega-runner-plugin: 1792 msgs, $275.1829
- C--work-mega-astramemory-local: 1681 msgs, $235.2910
- C--work-mega-runner: 446 msgs, $230.4007
- C--work-mega-common: 605 msgs, $215.3002
- C--work-mega-astra-render: 293 msgs, $138.4018
- C--work-mega-astramem-local: 171 msgs, $87.1473
- C--work-mega-governiq: 143 msgs, $51.9038
- C--work-mega-kb: 110 msgs, $21.7707
- C--work-demo-repo: 89 msgs, $4.3980

## Tokens (totals)

- input: 16,520
- cache_create_5m: 0
- cache_create_1h: 24,971,080
- cache_read: 2,192,231,703
- output: 8,609,032

## Model Mix

- claude-opus-4-8 (priced as claude-opus-4): 2388 msgs (27.6%), $1110.7282 (60.85%)
- claude-fable-5 (priced as claude-sonnet-4): 6263 msgs (72.4%), $714.5354 (39.15%)

## Conversation Shape

- user_msg_count: 720
- user_msg_avg_len: 1565
- turns_before_first_tool: 2
- compaction_count: 50
- skill_invocations: 9
- subagent_dispatches: 230

## Tool Usage

- Bash: 2209 (61 failed)
- Edit: 352 (19 failed)
- Agent: 230
- Read: 201 (1 failed)
- PowerShell: 159 (11 failed)
- Write: 136
- SendMessage: 111
- ToolSearch: 44
- Monitor: 39 (1 failed)
- TaskUpdate: 39
- AskUserQuestion: 38 (4 failed)
- TaskCreate: 28 (5 failed)
- Grep: 22
- TaskStop: 14
- Skill: 9
- mcp__plugin_azure_azure__monitor: 6 (1 failed)
- WebFetch: 5
- Glob: 4
- TaskOutput: 3 (1 failed)
- mcp__plugin_crew_astramem__search_memory: 3
- mcp__plugin_azure_azure__keyvault: 2
- mcp__plugin_azure_azure__containerapps: 2
- Artifact: 2
- mcp__plugin_azure_azure__subscription_list: 1
- mcp__plugin_crew_astramem__remember: 1 (1 failed)
- EnterWorktree: 1
- TaskList: 1

## Tool Result Sizes (bytes)

- count: 3671
- sum: 4,005,492
- p50: 303
- p90: 2,079
- max: 314,844

## File Re-reads

- redundant_read_count: 41
- top paths:
  - 7× C:\work\mega\runner-plugin\src\scripts\lib\memory-snapshot.mts
  - 5× C:\Users\serge\.claude\projects\C--work-mega-devops\memory\MEMORY.md
  - 5× C:\work\mega\runner-plugin\src\scripts\dispatch.mts
  - 4× C:\Users\serge\AppData\Local\Temp\p2-apply\infra\envs\oidc-aws\main.tf
  - 3× C:\work\mega\astramemory-local\scripts\eval\shared\spawn-daemon.ts

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 2215 calls, 1,935,379B results, ~12,153,161 cache_create tok (6.28×)
- Agent: 231 calls, 187,677B results, ~2,643,673 cache_create tok (14.09×)
- Write: 136 calls, 25,086B results, ~1,877,183 cache_create tok (74.83×)
- Edit: 353 calls, 63,009B results, ~1,644,797 cache_create tok (26.1×)
- AskUserQuestion: 38 calls, 13,010B results, ~1,555,665 cache_create tok (119.57×)
- SendMessage: 111 calls, 81,501B results, ~1,157,687 cache_create tok (14.2×)
- PowerShell: 158 calls, 142,951B results, ~988,194 cache_create tok (6.91×)
- Read: 203 calls, 1,352,107B results, ~935,776 cache_create tok (0.69×)
- TaskStop: 14 calls, 15,312B results, ~591,568 cache_create tok (38.63×)
- Skill: 8 calls, 247B results, ~346,937 cache_create tok (1404.6×)
- Monitor: 39 calls, 10,066B results, ~212,474 cache_create tok (21.11×)
- Grep: 22 calls, 20,053B results, ~120,092 cache_create tok (5.99×)
- ToolSearch: 44 calls, 3,162B results, ~118,435 cache_create tok (37.46×)
- Glob: 4 calls, 12,561B results, ~111,829 cache_create tok (8.9×)
- TaskCreate: 28 calls, 8,833B results, ~94,891 cache_create tok (10.74×)
- TaskUpdate: 39 calls, 957B results, ~92,343 cache_create tok (96.49×)
- mcp__plugin_azure_azure__monitor: 6 calls, 42,220B results, ~61,494 cache_create tok (1.46×)
- mcp__plugin_crew_astramem__search_memory: 3 calls, 30,864B results, ~38,883 cache_create tok (1.26×)
- WebFetch: 5 calls, 24,994B results, ~33,234 cache_create tok (1.33×)
- mcp__plugin_azure_azure__keyvault: 2 calls, 21,161B results, ~17,071 cache_create tok (0.81×)
- mcp__plugin_azure_azure__containerapps: 2 calls, 11,520B results, ~14,473 cache_create tok (1.26×)
- Artifact: 2 calls, 1,176B results, ~14,433 cache_create tok (12.27×)
- mcp__plugin_azure_azure__subscription_list: 1 calls, 513B results, ~11,601 cache_create tok (22.61×)
- mcp__plugin_crew_astramem__remember: 1 calls, 24B results, ~9,014 cache_create tok (375.58×)
- TaskOutput: 3 calls, 426B results, ~1,415 cache_create tok (3.32×)
- EnterWorktree: 1 calls, 232B results, ~552 cache_create tok (2.38×)
- TaskList: 1 calls, 14B results, ~74 cache_create tok (5.29×)


## By Model (token detail)

### claude-fable-5 (priced as claude-sonnet-4)
- messages: 6263
- usd: $714.5354
- input: 12,116
- cache_create_5m: 0
- cache_create_1h: 17,296,508
- cache_read: 1,748,707,038
- output: 5,740,525

### claude-opus-4-8 (priced as claude-opus-4)
- messages: 2388
- usd: $1110.7282
- input: 4,404
- cache_create_5m: 0
- cache_create_1h: 7,674,572
- cache_read: 443,524,665
- output: 2,868,507

