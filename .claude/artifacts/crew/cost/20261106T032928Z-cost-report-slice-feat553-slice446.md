---
kind: cost-report
feature: FEAT-553
run_title: "FEAT553 SLICE446"
usd: 116.6686
duration_ms: 9590062159
total_tokens: 250383887
cache_hit_pct: 98.4
source_project: C--work-mega-astramem-local
aggregate_all: false
source_count: 1
created_at: 2026-11-06T03:29:28.540Z
---

# Cost Report: FEAT553 SLICE446

- Created: 2026-11-06T03:29:28.540Z
- Run Title: FEAT553 SLICE446
- Window Start: 2026-07-18T03:35:06.172Z
- Window End: 2026-11-06T03:29:28.331Z
- Duration: 159834.4 min (9590062159 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 640
- Total Tokens: 250,383,887
- Cache Hit %: 98.4%
- Total USD: $116.6686
- Source Project: C--work-mega-astramem-local
- Auto-detected: no
- Aggregate All: no

## Tokens (totals)

- input: 17,190
- cache_create_5m: 0
- cache_create_1h: 3,956,094
- cache_read: 245,120,993
- output: 1,289,610

## Model Mix

- claude-fable-5-1 (priced as claude-sonnet-4): 640 msgs (100%), $116.6686 (100%)

## Conversation Shape

- user_msg_count: 22
- user_msg_avg_len: 2329
- turns_before_first_tool: 2
- compaction_count: 7
- skill_invocations: 3
- subagent_dispatches: 4

## Tool Usage

- Bash: 297 (10 failed)
- Write: 6
- Agent: 4
- Workflow: 4
- mcp__plugin_playwright_playwright__browser_navigate: 4 (1 failed)
- ToolSearch: 3
- Skill: 3
- ListAgents: 3
- Edit: 2
- mcp__plugin_playwright_playwright__browser_take_screenshot: 2 (1 failed)
- Read: 2
- mcp__claude-in-chrome__navigate: 1 (1 failed)
- mcp__claude-in-chrome__tabs_context_mcp: 1
- PowerShell: 1
- SendMessage: 1
- mcp__plugin_playwright_playwright__browser_resize: 1
- mcp__plugin_playwright_playwright__browser_snapshot: 1
- AskUserQuestion: 1

## Tool Result Sizes (bytes)

- count: 337
- sum: 766,143
- p50: 763
- p90: 3,453
- max: 186,364

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 297 calls, 428,760B results, ~3,410,505 cache_create tok (7.95×)
- Write: 6 calls, 1,107B results, ~68,225 cache_create tok (61.63×)
- Workflow: 4 calls, 5,458B results, ~62,596 cache_create tok (11.47×)
- Skill: 3 calls, 100B results, ~56,055 cache_create tok (560.55×)
- Agent: 4 calls, 1,256B results, ~25,449 cache_create tok (20.26×)
- ToolSearch: 3 calls, 970B results, ~14,013 cache_create tok (14.45×)
- mcp__plugin_playwright_playwright__browser_navigate: 4 calls, 1,428B results, ~10,747 cache_create tok (7.53×)
- AskUserQuestion: 1 calls, 1,348B results, ~8,364 cache_create tok (6.2×)
- Read: 2 calls, 320,780B results, ~7,880 cache_create tok (0.02×)
- Edit: 2 calls, 395B results, ~7,248 cache_create tok (18.35×)
- SendMessage: 1 calls, 376B results, ~4,082 cache_create tok (10.86×)
- ListAgents: 3 calls, 1,811B results, ~4,062 cache_create tok (2.24×)
- mcp__plugin_playwright_playwright__browser_resize: 1 calls, 157B results, ~2,283 cache_create tok (14.54×)
- mcp__plugin_playwright_playwright__browser_snapshot: 1 calls, 755B results, ~2,216 cache_create tok (2.94×)
- mcp__plugin_playwright_playwright__browser_take_screenshot: 2 calls, 703B results, ~989 cache_create tok (1.41×)
- mcp__claude-in-chrome__tabs_context_mcp: 1 calls, 492B results, ~750 cache_create tok (1.52×)
- mcp__claude-in-chrome__navigate: 1 calls, 241B results, ~374 cache_create tok (1.55×)
- PowerShell: 1 calls, 6B results, ~250 cache_create tok (41.67×)


## By Model (token detail)

### claude-fable-5-1 (priced as claude-sonnet-4)
- messages: 640
- usd: $116.6686
- input: 17,190
- cache_create_5m: 0
- cache_create_1h: 3,956,094
- cache_read: 245,120,993
- output: 1,289,610

