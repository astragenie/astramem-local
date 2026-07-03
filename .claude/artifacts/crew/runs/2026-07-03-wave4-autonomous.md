# Run brief — Wave 4 autonomous completion

**Started:** 2026-07-03 · **Owner:** lead (main thread) · **Mode:** autonomous, user away
**Authorization:** auto-merge all inspector-PASS features to main; drive all 9 FEATs to Wave 4 done; lead self-heals on builder FAIL.

## Scope

9 triaged FEATs (`.claude/artifacts/loop/backlog/triaged/FEAT-40[1-9].md`), Given/When/Then ACs hardened.
Builders: `crew:fullstack-dev` (code) / `crew:architect` (408 ADR). Review: `crew:inspector` per feature. Merge PASS → main.

## Wave plan (conflict-aware: search.ts + tests/eval serialize 401/402/404/409)

| Wave | Features | Builder | Notes |
|------|----------|---------|-------|
| 1 | 401, 403, 405, 406, 408 | fullstack-dev ×4 + architect(408) | disjoint files; 408 ADR unblocks 407 |
| 2 | 409, 407 | fullstack-dev ×2 | 407 needs 408 ADR merged first |
| 3 | 402-slice1 | fullstack-dev | distill extract + migration 009 + backfill |
| 4 | 402-slice2 | fullstack-dev | entity query surface + routes + CLI + eval |
| 5 | 404 | fullstack-dev | archival exclusion + cleanup handler |

Critical path: 401 → 409 → 402s1 → 402s2 → 404.

## Gate per feature

Builder must: implement all ACs + tests-per-AC; phase-gate green (`bun run build` tsc, `bun run test` vitest incl ADR-005 eval floors recall@10≥0.90/NDCG@10≥0.70, `node contracts/validate.mjs`); commit on `feat/w4-40X-<slug>`; NOT merge. Lead runs crew:inspector → PASS merge, FAIL self-heal (crew:fix / inline) → re-inspect → merge.

## Risk flags

- 406 security (auth boundary) — inspector must verify no public-endpoint gap.
- 409 six-file coordinated + re-embed migration — highest regression surface.
- 402 first schema migration since v0.6.0 (migration 009).
- 407 cross-service wire contract (SaaS repo absent locally) — validate buildable portion; hold if unverifiable AC-5/6.

## Progress log

- [x] Baseline committed `370ec82`
- [x] Wave 1 dispatched (401, 403, 405, 406 fullstack-dev; 408 architect)
- [x] **FEAT-408 PASS → merged `122a58c`** (ADR-011). 407 depends_on cleared.
- [x] **FEAT-405 PASS → merged** (poison purge). insp-405 re-verified gates + concurrency window.
- [x] **FEAT-406 PASS → merged** (remote /health auth). insp-406 security bypass hunt clean (0.0.0.0 fail-closed).
- [~] 401 as_of — builder hit limit mid-eval-verify, RESUMED for final gate report
- [~] 403 tag hygiene — builder hit limit before writing tests, RESUMED to finish tests+gates
- [x] Wave 2 early-start: **407 sync pull dispatched** (unblocked by 408; disjoint files). 409 held (collides 401 on search.ts).

**Merged to main: 3/9** (405, 406, 408). Main builds clean after each merge.
