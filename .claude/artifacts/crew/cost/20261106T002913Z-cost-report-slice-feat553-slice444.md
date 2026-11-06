---
kind: cost-report
feature: FEAT-553
run_title: "FEAT553 SLICE444"
usd: 93.0283
duration_ms: 9579246689
total_tokens: 195868114
cache_hit_pct: 98.4
source_project: C--work-mega-astramem-local
aggregate_all: false
source_count: 1
created_at: 2026-11-06T00:29:13.376Z
---

# Cost Report: FEAT553 SLICE444

- Created: 2026-11-06T00:29:13.376Z
- Run Title: FEAT553 SLICE444
- Window Start: 2026-07-18T03:35:06.172Z
- Window End: 2026-11-06T00:29:12.861Z
- Duration: 159654.1 min (9579246689 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 556
- Total Tokens: 195,868,114
- Cache Hit %: 98.4%
- Total USD: $93.0283
- Source Project: C--work-mega-astramem-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 14,652
- cache_create_5m: 0
- cache_create_1h: 3,087,318
- cache_read: 191,634,808
- output: 1,131,336

## Model Mix

- claude-fable-5-1 (priced as claude-sonnet-4): 556 msgs (100%), $93.0283 (100%)

## Conversation Shape

- user_msg_count: 19
- user_msg_avg_len: 2160
- turns_before_first_tool: 2
- compaction_count: 7
- skill_invocations: 3
- subagent_dispatches: 3

## Tool Usage

- Bash: 258 (8 failed)
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

- count: 293
- sum: 732,164
- p50: 823
- p90: 3,622
- max: 186,364

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 257 calls, 397,415B results, ~2,566,794 cache_create tok (6.46×)
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
- messages: 556
- usd: $93.0283
- input: 14,652
- cache_create_5m: 0
- cache_create_1h: 3,087,318
- cache_read: 191,634,808
- output: 1,131,336

