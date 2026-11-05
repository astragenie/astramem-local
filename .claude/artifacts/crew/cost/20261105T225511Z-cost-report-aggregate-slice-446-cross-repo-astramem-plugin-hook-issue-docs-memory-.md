---
kind: cost-report
slice: SLICE-446
run_title: "SLICE-446: Cross-repo astramem-plugin hook issue + docs/memory.md write-back"
usd: 163.5768
duration_ms: 9573604842
total_tokens: 301440433
cache_hit_pct: 97.8
review_decision: approved
validation_decision: skipped
source_project: aggregate
aggregate_all: true
source_count: 8
created_at: 2026-11-05T22:55:11.812Z
---

# Cost Report: SLICE-446: Cross-repo astramem-plugin hook issue + docs/memory.md write-back

- Created: 2026-11-05T22:55:11.812Z
- Run Title: SLICE-446: Cross-repo astramem-plugin hook issue + docs/memory.md write-back
- Window Start: 2026-07-18T03:35:06.172Z
- Window End: 2026-11-05T22:55:11.014Z
- Duration: 159560.1 min (9573604842 ms)
- Sessions Scanned: 9
- Assistant Messages Counted: 1133
- Total Tokens: 301,440,433
- Cache Hit %: 97.8%
- Total USD: $163.5768
- Source Project: aggregate
- Auto-detected: no
- Aggregate All: yes

## Sources (aggregated)

- C--work-mega-astramem-local: 396 msgs, $61.0066
- C--work-mega--wt-prism-ranking-judge-visible: 372 msgs, $53.8120
- C--work-mega-devcrew: 234 msgs, $35.2323
- C--work-mega-kb: 79 msgs, $9.7821
- C--work-mega: 44 msgs, $3.2772
- C--Users-serge-AppData-Local-Temp-claude-C--work-mega-devcrew-3d4e455a-578a-4759-90df-728b77b7f416-scratchpad-hookcheck-repo: 2 msgs, $0.1906
- C--Users-serge-AppData-Local-Temp-claude-C--work-mega-devcrew-3d4e455a-578a-4759-90df-728b77b7f416-scratchpad-hookcheck-repoC: 4 msgs, $0.1785
- C--Users-serge-AppData-Local-Temp-claude-C--work-mega-devcrew-3d4e455a-578a-4759-90df-728b77b7f416-scratchpad-hookcheck-repoB: 2 msgs, $0.0973

## Outcome Linkage

- Slice: SLICE-446
- Grade Avg: -
- Review Decision: approved
- Validation Decision: skipped

## Tokens (totals)

- input: 28,924
- cache_create_5m: 0
- cache_create_1h: 6,620,418
- cache_read: 292,324,211
- output: 2,466,880

## Model Mix

- claude-fable-5-1 (priced as claude-sonnet-4): 1125 msgs (99.29%), $163.1103 (99.71%)
- claude-haiku-4-5-20251001 (priced as claude-haiku-4): 8 msgs (0.71%), $0.4665 (0.29%)

## Conversation Shape

- user_msg_count: 71
- user_msg_avg_len: 2170
- turns_before_first_tool: 11
- compaction_count: 17
- skill_invocations: 6
- subagent_dispatches: 12

## Tool Usage

- Bash: 385 (17 failed)
- Write: 55
- Read: 14
- ToolSearch: 13
- SendMessage: 13
- Agent: 12
- PowerShell: 8 (1 failed)
- mcp__plugin_playwright_playwright__browser_take_screenshot: 8 (1 failed)
- Skill: 6
- mcp__plugin_playwright_playwright__browser_navigate: 6
- Edit: 6
- mcp__claude-in-chrome__navigate: 4 (1 failed)
- Grep: 4
- ListAgents: 3
- mcp__plugin_playwright_playwright__browser_resize: 3
- mcp__plugin_playwright_playwright__browser_evaluate: 3
- mcp__claude-in-chrome__tabs_context_mcp: 2
- mcp__claude-in-chrome__computer: 2 (2 failed)
- mcp__claude-in-chrome__browser_batch: 2 (2 failed)
- mcp__plugin_playwright_playwright__browser_snapshot: 2
- mcp__plugin_playwright_playwright__browser_close: 2
- AskUserQuestion: 2
- mcp__claude-in-chrome__read_page: 1 (1 failed)
- mcp__claude-in-chrome__read_network_requests: 1
- mcp__claude-in-chrome__read_console_messages: 1
- mcp__claude-in-chrome__list_connected_browsers: 1
- mcp__claude-in-chrome__tabs_close_mcp: 1
- mcp__plugin_playwright_playwright__browser_click: 1
- Glob: 1
- mcp__plugin_playwright_playwright__browser_press_key: 1
- Workflow: 1

## Tool Result Sizes (bytes)

- count: 564
- sum: 3,175,573
- p50: 618
- p90: 4,937
- max: 456,309

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 385 calls, 873,780B results, ~4,605,339 cache_create tok (5.27×)
- Write: 55 calls, 10,955B results, ~483,917 cache_create tok (44.17×)
- Edit: 6 calls, 1,196B results, ~281,392 cache_create tok (235.28×)
- ToolSearch: 13 calls, 2,466B results, ~153,603 cache_create tok (62.29×)
- Read: 14 calls, 2,231,003B results, ~116,553 cache_create tok (0.05×)
- Skill: 6 calls, 207B results, ~96,103 cache_create tok (464.27×)
- Agent: 12 calls, 3,800B results, ~94,641 cache_create tok (24.91×)
- SendMessage: 13 calls, 4,978B results, ~70,571 cache_create tok (14.18×)
- Grep: 4 calls, 19,684B results, ~69,070 cache_create tok (3.51×)
- mcp__plugin_playwright_playwright__browser_navigate: 6 calls, 2,566B results, ~27,595 cache_create tok (10.75×)
- PowerShell: 8 calls, 5,041B results, ~25,018 cache_create tok (4.96×)
- Workflow: 1 calls, 1,381B results, ~24,582 cache_create tok (17.8×)
- mcp__plugin_playwright_playwright__browser_snapshot: 2 calls, 396B results, ~19,392 cache_create tok (48.97×)
- mcp__plugin_playwright_playwright__browser_take_screenshot: 8 calls, 2,792B results, ~15,606 cache_create tok (5.59×)
- mcp__plugin_playwright_playwright__browser_evaluate: 3 calls, 6,792B results, ~14,712 cache_create tok (2.17×)
- AskUserQuestion: 2 calls, 330B results, ~14,286 cache_create tok (43.29×)
- mcp__plugin_playwright_playwright__browser_close: 2 calls, 284B results, ~6,124 cache_create tok (21.56×)
- mcp__claude-in-chrome__browser_batch: 2 calls, 972B results, ~6,010 cache_create tok (6.18×)
- mcp__claude-in-chrome__navigate: 4 calls, 1,759B results, ~5,465 cache_create tok (3.11×)
- mcp__plugin_playwright_playwright__browser_resize: 3 calls, 551B results, ~3,716 cache_create tok (6.74×)
- mcp__claude-in-chrome__list_connected_browsers: 1 calls, 181B results, ~3,404 cache_create tok (18.81×)
- mcp__claude-in-chrome__read_network_requests: 1 calls, 430B results, ~2,381 cache_create tok (5.54×)
- mcp__claude-in-chrome__read_console_messages: 1 calls, 436B results, ~2,381 cache_create tok (5.46×)
- mcp__claude-in-chrome__tabs_close_mcp: 1 calls, 146B results, ~2,226 cache_create tok (15.25×)
- Glob: 1 calls, 52B results, ~2,100 cache_create tok (40.38×)
- ListAgents: 3 calls, 1,738B results, ~2,001 cache_create tok (1.15×)
- mcp__claude-in-chrome__tabs_context_mcp: 2 calls, 1,028B results, ~1,886 cache_create tok (1.83×)
- mcp__claude-in-chrome__computer: 2 calls, 130B results, ~680 cache_create tok (5.23×)
- mcp__plugin_playwright_playwright__browser_click: 1 calls, 320B results, ~518 cache_create tok (1.62×)
- mcp__plugin_playwright_playwright__browser_press_key: 1 calls, 121B results, ~332 cache_create tok (2.74×)
- mcp__claude-in-chrome__read_page: 1 calls, 58B results, ~170 cache_create tok (2.93×)


## By Model (token detail)

### claude-haiku-4-5-20251001 (priced as claude-haiku-4)
- messages: 8
- usd: $0.4665
- input: 80
- cache_create_5m: 0
- cache_create_1h: 225,788
- cache_read: 113,678
- output: 694

### claude-fable-5-1 (priced as claude-sonnet-4)
- messages: 1125
- usd: $163.1103
- input: 28,844
- cache_create_5m: 0
- cache_create_1h: 6,394,630
- cache_read: 292,210,533
- output: 2,466,186

