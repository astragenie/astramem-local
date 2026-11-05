---
kind: cost-report
feature: FEAT-553
run_title: "FEAT553 SLICE442"
usd: 82.3545
duration_ms: 9575524563
total_tokens: 166294173
cache_hit_pct: 98.2
source_project: C--work-mega-astramem-local
aggregate_all: false
source_count: 1
created_at: 2026-11-05T23:27:11.022Z
---

# Cost Report: FEAT553 SLICE442

- Created: 2026-11-05T23:27:11.022Z
- Run Title: FEAT553 SLICE442
- Window Start: 2026-07-18T03:35:06.172Z
- Window End: 2026-11-05T23:27:10.735Z
- Duration: 159592.1 min (9575524563 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 506
- Total Tokens: 166,294,173
- Cache Hit %: 98.2%
- Total USD: $82.3545
- Source Project: C--work-mega-astramem-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 13,352
- cache_create_5m: 0
- cache_create_1h: 2,957,846
- cache_read: 162,263,757
- output: 1,059,218

## Model Mix

- claude-fable-5-1 (priced as claude-sonnet-4): 506 msgs (100%), $82.3545 (100%)

## Conversation Shape

- user_msg_count: 15
- user_msg_avg_len: 1375
- turns_before_first_tool: 2
- compaction_count: 7
- skill_invocations: 3
- subagent_dispatches: 3

## Tool Usage

- Bash: 240 (7 failed)
- Write: 5
- mcp__plugin_playwright_playwright__browser_navigate: 4 (1 failed)
- ToolSearch: 3
- Skill: 3
- Agent: 3
- ListAgents: 2
- Workflow: 2
- mcp__plugin_playwright_playwright__browser_take_screenshot: 2 (1 failed)
- Read: 2
- Edit: 1
- mcp__claude-in-chrome__navigate: 1 (1 failed)
- mcp__claude-in-chrome__tabs_context_mcp: 1
- PowerShell: 1
- SendMessage: 1
- mcp__plugin_playwright_playwright__browser_resize: 1
- mcp__plugin_playwright_playwright__browser_snapshot: 1

## Tool Result Sizes (bytes)

- count: 272
- sum: 713,836
- p50: 847
- p90: 3,653
- max: 186,364

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 239 calls, 382,097B results, ~2,456,284 cache_create tok (6.43×)
- Write: 5 calls, 918B results, ~65,756 cache_create tok (71.63×)
- Skill: 3 calls, 100B results, ~56,055 cache_create tok (560.55×)
- Workflow: 2 calls, 2,718B results, ~43,992 cache_create tok (16.19×)
- ToolSearch: 3 calls, 970B results, ~14,013 cache_create tok (14.45×)
- Agent: 3 calls, 951B results, ~13,455 cache_create tok (14.15×)
- mcp__plugin_playwright_playwright__browser_navigate: 4 calls, 1,428B results, ~10,747 cache_create tok (7.53×)
- Read: 2 calls, 320,780B results, ~7,880 cache_create tok (0.02×)
- Edit: 1 calls, 125B results, ~6,890 cache_create tok (55.12×)
- SendMessage: 1 calls, 376B results, ~4,082 cache_create tok (10.86×)
- mcp__plugin_playwright_playwright__browser_resize: 1 calls, 157B results, ~2,283 cache_create tok (14.54×)
- mcp__plugin_playwright_playwright__browser_snapshot: 1 calls, 755B results, ~2,216 cache_create tok (2.94×)
- ListAgents: 2 calls, 1,019B results, ~1,824 cache_create tok (1.79×)
- mcp__plugin_playwright_playwright__browser_take_screenshot: 2 calls, 703B results, ~989 cache_create tok (1.41×)
- mcp__claude-in-chrome__tabs_context_mcp: 1 calls, 492B results, ~750 cache_create tok (1.52×)
- mcp__claude-in-chrome__navigate: 1 calls, 241B results, ~374 cache_create tok (1.55×)
- PowerShell: 1 calls, 6B results, ~250 cache_create tok (41.67×)


## By Model (token detail)

### claude-fable-5-1 (priced as claude-sonnet-4)
- messages: 506
- usd: $82.3545
- input: 13,352
- cache_create_5m: 0
- cache_create_1h: 2,957,846
- cache_read: 162,263,757
- output: 1,059,218

