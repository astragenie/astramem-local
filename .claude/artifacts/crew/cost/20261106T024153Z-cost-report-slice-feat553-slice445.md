---
kind: cost-report
feature: FEAT-553
run_title: "FEAT553 SLICE445"
usd: 98.298
duration_ms: 9587206724
total_tokens: 200833373
cache_hit_pct: 98.1
source_project: C--work-mega-astramem-local
aggregate_all: false
source_count: 1
created_at: 2026-11-06T02:41:53.112Z
---

# Cost Report: FEAT553 SLICE445

- Created: 2026-11-06T02:41:53.112Z
- Run Title: FEAT553 SLICE445
- Window Start: 2026-07-18T03:35:06.172Z
- Window End: 2026-11-06T02:41:52.896Z
- Duration: 159786.8 min (9587206724 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 564
- Total Tokens: 200,833,373
- Cache Hit %: 98.1%
- Total USD: $98.2980
- Source Project: C--work-mega-astramem-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 14,788
- cache_create_5m: 0
- cache_create_1h: 3,729,672
- cache_read: 195,949,528
- output: 1,139,385

## Model Mix

- claude-fable-5-1 (priced as claude-sonnet-4): 564 msgs (100%), $98.2980 (100%)

## Conversation Shape

- user_msg_count: 21
- user_msg_avg_len: 2418
- turns_before_first_tool: 2
- compaction_count: 7
- skill_invocations: 3
- subagent_dispatches: 3

## Tool Usage

- Bash: 261 (8 failed)
- Write: 5
- Workflow: 4
- mcp__plugin_playwright_playwright__browser_navigate: 4 (1 failed)
- ToolSearch: 3
- Skill: 3
- Agent: 3
- Edit: 2
- ListAgents: 2
- mcp__plugin_playwright_playwright__browser_take_screenshot: 2 (1 failed)
- Read: 2
- mcp__claude-in-chrome__navigate: 1 (1 failed)
- mcp__claude-in-chrome__tabs_context_mcp: 1
- PowerShell: 1
- SendMessage: 1
- mcp__plugin_playwright_playwright__browser_resize: 1
- mcp__plugin_playwright_playwright__browser_snapshot: 1

## Tool Result Sizes (bytes)

- count: 296
- sum: 733,532
- p50: 823
- p90: 3,622
- max: 186,364

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 260 calls, 398,783B results, ~3,209,148 cache_create tok (8.05×)
- Write: 5 calls, 918B results, ~65,756 cache_create tok (71.63×)
- Workflow: 4 calls, 5,458B results, ~62,596 cache_create tok (11.47×)
- Skill: 3 calls, 100B results, ~56,055 cache_create tok (560.55×)
- ToolSearch: 3 calls, 970B results, ~14,013 cache_create tok (14.45×)
- Agent: 3 calls, 951B results, ~13,455 cache_create tok (14.15×)
- mcp__plugin_playwright_playwright__browser_navigate: 4 calls, 1,428B results, ~10,747 cache_create tok (7.53×)
- Read: 2 calls, 320,780B results, ~7,880 cache_create tok (0.02×)
- Edit: 2 calls, 395B results, ~7,248 cache_create tok (18.35×)
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
- messages: 564
- usd: $98.2980
- input: 14,788
- cache_create_5m: 0
- cache_create_1h: 3,729,672
- cache_read: 195,949,528
- output: 1,139,385

