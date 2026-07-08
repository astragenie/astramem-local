---
findings: "🔴:0,🟡:0,❓:1"
status: completed
decision: approved
---
# Review Result: Review Result

- Created: 2026-07-05T13:47:50.941Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: FEAT-426 agent soft-boost (commit 8716cc4, worktree wt-boost): all 6 verdict criteria verified with direct evidence — config back-compat, byte-equality default, fused<=1 invariant, cross-surface plumbing, eta/zeta parity, and eval floors all hold.
- Evidence Checked:
  - Diff matches expected 12 files exactly (git diff origin/main...feat/FEAT-boost-agent --stat). (1) Ran a live repro: wrote an old-style config.yaml with no eta key
  - loaded via loadConfigFromDisk -> output {alpha:0.4
  - ...
  - zeta:0
  - eta:0} — deep-merge over defaultConfig() means missing eta silently defaults to 0
  - no throw (loader.ts has no zod/strict schema
  - just a permissive custom parser + deepMerge). The 'Property eta is missing' error the builder saw was a TS compile-time literal-typing issue
  - not a runtime config-parse issue — tsc -p . now builds clean with 0 errors. (2) tests/search/project-filter.test.ts 'default (agentMode omitted) is byte-identical to the pre-FEAT-426 hard filter' freezes Date.now() and asserts withFilterMode toEqual(withoutMode) — real test
  - passed. (3) fuse.ts score = raw/weightSum is a weighted average of components all in [0
  - 1]
  - so score<=1 holds structurally regardless of how many optional components stack; tests/search/fuse.test.ts 'fused score stays <= 1 even with eta stacked on top of every other maxed component' maxes normBm25/normCosine/importance/freshness/usefulness/entityBonus/agentBonus=1 and all weights active
  - asserts <=1 and ~1. (4) agentMode plumbed with identical field name through GET /search (silently ignores invalid value
  - defaults 'filter')
  - POST /recall (zod z.enum(['filter'
  - 'boost']) -> safeParse -> 400 on invalid
  - never 500)
  - MCP search_memory/recall_memory (same zod enum)
  - CLI --agent-mode (forwarded verbatim). No crash path found on any surface for a garbage agentMode value. (5) agentBonusForFilter mirrors entityBonusForQuery exactly: SQL WHERE id IN(...) AND agent IN(...) with parameterized placeholders
  - map only ever holds 1 for matches
  - fuseScores uses identical (weight ?? 0)*(bonus ?? 0) pattern for both zeta/entityBonus and eta/agentBonus -- faithful binary bonus
  - no double counting. (6) Ran bunx vitest run tests/eval/retrieval-eval.test.ts directly: 9/9 pass
  - meanRecall>=0.9 and meanNdcg>=0.7 both asserted and green. Full suite: bun run test (vitest) => 128 files / 1269 tests passed
  - 4 skipped
  - 0 failed. tsc -p . clean.
- Files Reviewed:
  - src/search/fuse.ts
  - src/search/search.ts
  - src/config/config.ts
  - src/config/writer.ts
  - src/config/loader.ts (read for merge behavior
  - unchanged)
  - src/server/routes/search.ts
  - src/cli/search.ts
  - src/cli/index.ts
  - src/mcp/server.ts
  - src/server/routes/dashboard-search-html.ts
  - tests/search/fuse.test.ts
  - tests/search/project-filter.test.ts
  - .claude/artifacts/loop/backlog/pending/FEAT-426.md
- Test Adequacy: New behavior fully covered: fuse.test.ts adds 5 unit tests for eta incl. the maxed-components <=1 invariant and a fuseHits rank-vs-membership pair; project-filter.test.ts adds 4 integration tests incl. a frozen-clock byte-equality regression proving default behavior is unchanged. All new + pre-existing tests green (128 files/1269 tests via vitest), eval floors (recall@10>=0.9, NDCG@10>=0.7) independently re-run and confirmed passing, tsc build clean.
- Risks: LOW/theoretical only: in src/search/search.ts, if filters.agentMode were ever set to a value outside 'filter'|'boost' (bypassing every shipped boundary — all three surfaces are TS-typed and/or zod-enum-validated so this isn't reachable today), the current code (agentMode==='boost' / agentMode==='filter' as separate ifs) would silently apply NEITHER hard-filter NOR boost rather than falling back to 'filter'. Not blocking since no live caller can reach this state, but worth a defensive 'else treat as filter' if agentMode plumbing is extended later (e.g. a 4th surface without validation).
- Required Follow-up: Optional hardening only, no blocking follow-up: consider normalizing agentMode to the 'filter' literal at the top of search.ts (e.g. const agentMode = filters.agentMode === 'boost' ? 'boost' : 'filter') so any future unvalidated caller fails safe. Not required for this merge.

