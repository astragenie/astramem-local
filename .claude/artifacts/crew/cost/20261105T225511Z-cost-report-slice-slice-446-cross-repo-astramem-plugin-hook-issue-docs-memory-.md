---
kind: cost-report
slice: SLICE-446
run_title: "SLICE-446: Cross-repo astramem-plugin hook issue + docs/memory.md write-back"
usd: 61.0066
duration_ms: 9573604842
total_tokens: 108261290
cache_hit_pct: 97.5
review_decision: approved
validation_decision: skipped
source_project: C--work-mega-astramem-local
auto_detected: true
aggregate_all: false
source_count: 1
created_at: 2026-11-05T22:55:11.507Z
---

# Cost Report: SLICE-446: Cross-repo astramem-plugin hook issue + docs/memory.md write-back

- Created: 2026-11-05T22:55:11.507Z
- Run Title: SLICE-446: Cross-repo astramem-plugin hook issue + docs/memory.md write-back
- Window Start: 2026-07-18T03:35:06.172Z
- Window End: 2026-11-05T22:55:11.014Z
- Duration: 159560.1 min (9573604842 ms)
- Sessions Scanned: 1
- Assistant Messages Counted: 396
- Total Tokens: 108,261,290
- Cache Hit %: 97.5%
- Total USD: $61.0066
- Source Project: C--work-mega-astramem-local
- Auto-detected: yes
- Aggregate All: no

## Outcome Linkage

- Slice: SLICE-446
- Grade Avg: -
- Review Decision: approved
- Validation Decision: skipped

## Tokens (totals)

- input: 10,402
- cache_create_5m: 0
- cache_create_1h: 2,689,710
- cache_read: 104,665,340
- output: 895,838

## Model Mix

- claude-fable-5-1 (priced as claude-sonnet-4): 396 msgs (100%), $61.0066 (100%)

## Conversation Shape

- user_msg_count: 10
- user_msg_avg_len: 931
- turns_before_first_tool: 2
- compaction_count: 6
- skill_invocations: 3
- subagent_dispatches: 3

## Tool Usage

- Bash: 197 (6 failed)
- Write: 5
- Skill: 3
- Agent: 3
- ToolSearch: 2
- ListAgents: 2
- Edit: 1
- mcp__claude-in-chrome__navigate: 1 (1 failed)
- mcp__claude-in-chrome__tabs_context_mcp: 1
- PowerShell: 1
- SendMessage: 1
- Workflow: 1

## Tool Result Sizes (bytes)

- count: 218
- sum: 343,705
- p50: 944
- p90: 3,924
- max: 12,475

## File Re-reads

- redundant_read_count: 0

## Cache Priming (per tool, approximate)

Attribution: each tool's tool_result size weighted against the NEXT assistant turn's cache_create tokens. Numbers are directional, not precise — system-prompt drift and prior-turn re-injection inflate ratios.

- Bash: 197 calls, 337,589B results, ~2,240,017 cache_create tok (6.64×)
- Write: 5 calls, 918B results, ~65,756 cache_create tok (71.63×)
- Skill: 3 calls, 100B results, ~56,055 cache_create tok (560.55×)
- Workflow: 1 calls, 1,381B results, ~24,582 cache_create tok (17.8×)
- Agent: 3 calls, 951B results, ~13,455 cache_create tok (14.15×)
- Edit: 1 calls, 125B results, ~6,890 cache_create tok (55.12×)
- ToolSearch: 2 calls, 507B results, ~5,669 cache_create tok (11.18×)
- SendMessage: 1 calls, 376B results, ~4,082 cache_create tok (10.86×)
- ListAgents: 2 calls, 1,019B results, ~1,824 cache_create tok (1.79×)
- mcp__claude-in-chrome__tabs_context_mcp: 1 calls, 492B results, ~750 cache_create tok (1.52×)
- mcp__claude-in-chrome__navigate: 1 calls, 241B results, ~374 cache_create tok (1.55×)
- PowerShell: 1 calls, 6B results, ~250 cache_create tok (41.67×)


## By Model (token detail)

### claude-fable-5-1 (priced as claude-sonnet-4)
- messages: 396
- usd: $61.0066
- input: 10,402
- cache_create_5m: 0
- cache_create_1h: 2,689,710
- cache_read: 104,665,340
- output: 895,838

