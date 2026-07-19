---
status: done
---
# Handoff: FEAT-480 — FTS5 OR-join fix

- Objective: Fix `escapeFtsQuery()` in `src/search/search.ts` so multi-word
  natural-language queries produce FTS5/BM25 candidates instead of zero
  (implicit-AND bug: alpha=0.4 fusion weight sat on a dead leg).
- Owner: fullstack-dev
- Branch: `feat/480-fts-or-join`
- PR: https://github.com/astragenie/astramem-local/pull/441 (draft)
- Commit: `8364ff2` fix(search): OR-join FTS5 tokens instead of implicit AND (FEAT-480)

## Deliverable

`escapeFtsQuery()` now:
1. Splits query into whitespace tokens (unchanged).
2. Strips a small closed-class stopword set (`FTS_STOPWORDS` — "a", "the",
   "is", "does", "what", etc. — NOT a general NLP list, deliberately narrow).
3. OR-joins the remaining ("signal") tokens, each still quoted (existing
   operator-char neutralization for `-`, `*`, `"`, `AND`/`OR`/`NOT` is
   unchanged — only the join operator changed from implicit-space-AND to
   explicit ` OR `).
4. Caps signal tokens at `FTS_MAX_OR_TOKENS = 12` to bound candidate-set cost
   on long queries.
5. Falls back to the original AND-of-all-tokens when the query is entirely
   stopwords (e.g. "what is this") — never emits an empty/invalid MATCH
   string, which FTS5 would reject.

```ts
function escapeFtsQuery(q: string): string {
  const rawTokens = q.trim().split(/\s+/).filter(Boolean);
  if (rawTokens.length === 0) return '';
  const quote = (t: string): string => `"${t.replace(/"/g, '""')}"`;

  const signalTokens = rawTokens.filter(t => !FTS_STOPWORDS.has(t.toLowerCase()));
  if (signalTokens.length === 0) {
    return rawTokens.map(quote).join(' ');
  }

  return signalTokens.slice(0, FTS_MAX_OR_TOKENS).map(quote).join(' OR ');
}
```

## Files changed

- `src/search/search.ts` — `FTS_STOPWORDS`, `FTS_MAX_OR_TOKENS`, rewritten
  `escapeFtsQuery()` + updated docstring explaining the trade-off.
- `tests/search/fts-or-join.test.ts` (new) — 4 tests: partial multi-word
  match recovery, all-stopword fallback (no throw), single-token query,
  operator-char sanitization under OR-join (`cat-dog`, `a"b`, `-foo`).

## Evidence

- `bunx vitest run tests/search tests/eval`: 22 files, 328 passed / 1
  skipped. Includes ADR-005 `recall@10 ≥ 0.9` / `NDCG@10 ≥ 0.7` regression
  floors (unaffected — deterministic fake embedder) and the cross-encoder
  rerank gate tests.
- `bunx tsc --noEmit -p .`: clean, no errors.

## Scope discipline

Did not touch: fusion weights (alpha/beta/gamma/delta/epsilon/zeta), vector
leg, rerank, decompose, version/changelog. Diff is 2 files (production code
+ its test).

Reverted an unrelated side-effect (`scripts/eval/consolidation-bench/results/latest-run.json`
timestamp bump written by running the eval suite) before committing, to keep
the diff scoped to FEAT-480.

## Risks / open questions

- The full LoCoMo A/B (does MRR actually improve on real, non-fixture data)
  is explicitly deferred per the brief — separate validation step, not run
  in this slice.
- `FTS_STOPWORDS` and `FTS_MAX_OR_TOKENS` are new tunables local to
  `search.ts`; if the LoCoMo A/B suggests the stopword list is too
  aggressive/permissive or the cap too low/high, both are single-constant
  edits in the same function — no architectural change needed.

## Suggested next handoff

Validator / LoCoMo A/B run against this branch's PR #441 to confirm the FTS
leg's revival actually improves MRR before merging to `main`.
