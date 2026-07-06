---
id: FEAT-426
status: done
priority: null
category: platform
target_release: null
created: 2026-07-05
depends_on: [FEAT-423]
slices: []
derived_from: FEAT-423
tags: [concern:recall, concern:ranking, surface:api, surface:cli, surface:mcp]
autonomous_safe: null
triage_notes: "Direct follow-up to FEAT-423's 'Nice-to-have' section — the agent filter shipped as a HARD exact-match only. runner-plugin FEAT-219 (role-scoped pre-work memory injection) wants role relevance blended into ranking, not a hard exclusion: a reviewer agent should still see a builder's memories when nothing else is relevant, just ranked lower. Implemented in worktree wt-boost / branch feat/FEAT-boost-agent by reusing the existing ADR-010/FEAT-402 (epsilon/zeta) additive-bonus machinery in src/search/fuse.ts — no new scoring axis invented."
---

# FEAT-426: agent soft-boost — rank by agent preference instead of hard-filtering

## Problem

FEAT-423 shipped `agent` as a HARD exact-match filter on `/recall` and `/search`
(`SearchFilters.agent`, applied post-fusion as `agent = ?` / `agent IN (...)`
in `src/search/search.ts`). That is the right default for "only show me
`crew:reviewer` memories," but FEAT-423's own nice-to-have section flagged a
second, distinct need from the runner-plugin consumer (FEAT-219, role-scoped
pre-work memory injection):

> runner-plugin FEAT-219 wants role-scoped recall (reviewer sees prior review
> failures, builder sees prior build lessons) as a **soft boost**, so a filter
> or a score-boost hook on `agent` would let the consumer blend role
> relevance without a hard filter.

A hard filter is wrong for that use case: if a reviewer agent has no
reviewer-tagged memories relevant to the current query, a hard filter
returns nothing, even though a builder-tagged memory might still be useful.
The caller wants agent match to *raise* relevance, not *gate* it.

## Requested capability

1. **A soft-boost mode for the existing `agent` filter.** Add
   `SearchFilters.agentMode?: 'filter' | 'boost'` (default `'filter'` —
   current hard-filter behavior, byte-identical for every existing caller
   that doesn't pass the field). When `'boost'` is selected, `agent` is not
   applied as a SQL exclusion; instead, atoms whose `memories.agent` matches
   get a ranking bonus and stay in the result set alongside non-matches.
2. **Reuse the existing ADR-010/FEAT-402 additive-bonus fusion machinery**
   (`src/search/fuse.ts` — the ε usefulness component and the ζ
   entity-relevance bonus are the precedent) rather than inventing a new
   scoring axis. A new η (eta) weight + `agentBonus` component, structurally
   identical to ζ/`entityBonus` (0 or 1, no-signal default 0, DEFAULT weight
   0 = OFF), covers this without touching the wire-contract normalization
   (`fuseScores` continues to divide by the active weight sum, so the fused
   score stays ≤ 1 regardless of how many optional components are active).
3. **Plumb `agentMode` end-to-end** the same way FEAT-423 plumbed `agent`:
   `SearchFilters` → `GET /search?agentMode=` / `POST /recall`
   `filters.agentMode` → the `search`/`recall` CLI (`--agent-mode`) → the MCP
   `search_memory`/`recall_memory` tools. Default omitted/`'filter'` must not
   change behavior for any existing caller.

## Acceptance criteria (proposed — re-triage as you see fit)

- Given `agentMode` is omitted (or explicitly `'filter'`), When `agent` is
  set, Then behavior is identical to pre-FEAT-426: non-matching atoms are
  excluded at the SQL layer (regression test: same assertions as the
  FEAT-423 hard-filter test).
- Given `agentMode: 'boost'` and `search.eta > 0`, When two otherwise-tied
  candidates differ only in `agent`, Then the agent-matching candidate
  ranks first and BOTH candidates remain in the result set (rank changes,
  membership does not).
- Given `agentMode: 'boost'` and the default `search.eta = 0`, When the
  search runs, Then results are identical to an unfiltered/unscoped search
  (the boost is a documented no-op at the default weight, mirroring ζ's
  AC-6 zero-weight guarantee).
- Given the ADR-005 retrieval-eval harness / focused fuse-level tests, When
  run with the default config, Then `recall@10 >= 0.9` and `NDCG@10 >= 0.7`
  continue to hold (the new `eta: 0` key is additive and inert by default).
- Given the smoke suite's fused-score wire-contract assertion, When any
  combination of ε/ζ/η weights is active, Then the fused score is always
  `<= 1`.

## Refs

- Precedent: FEAT-402 slice 2 AC-6 (ζ entity-relevance bonus — the direct
  structural template for η), ADR-010 (ε usefulness component).
- Requester: astragenie/runner-plugin FEAT-219, via FEAT-423's nice-to-have
  section.
- Implementation: worktree `wt-boost`, branch `feat/FEAT-boost-agent` —
  `src/search/fuse.ts` (η/agentBonus), `src/search/search.ts`
  (`agentMode`, `agentBonusForFilter`), `src/config/config.ts` (`eta`
  default 0), routes/CLI/MCP plumbing, `tests/search/fuse.test.ts` +
  `tests/search/project-filter.test.ts` (focused rank-vs-membership tests).
