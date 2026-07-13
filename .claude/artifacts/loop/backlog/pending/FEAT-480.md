---
id: FEAT-480
status: pending
priority: null
category: bug
target_release: null
created: 2026-07-13
updated: 2026-07-13
depends_on: [RECALL-S1]
slices: []
derived_from: recall-quality investigation 2026-07-13
cross_product: [astramem-local]
autonomous_safe: null
triage_notes: "The BM25/FTS retrieval leg returns ZERO hits for any multi-word natural-language query, because escapeFtsQuery joins tokens as adjacent quoted phrases (FTS5 implicit-AND). 40% of the fusion weight (alpha=0.4) sits on a dead leg. Mechanism confirmed in code + measured 0/50 hits. Whether FIXING it improves MRR is NOT yet proven — do not assume."
---
## Description

**The keyword-search half of hybrid retrieval is dead. It has been since it shipped.**

`src/search/search.ts:257`:

```ts
function escapeFtsQuery(q: string): string {
  return q.trim().split(/\s+/).map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}
```

Every token becomes its own quoted phrase, joined by spaces. **SQLite FTS5 treats
adjacent bare phrases as implicit AND.** So:

> *"what test runner does this repo use"*
> → `"what" "test" "runner" "does" "this" "repo" "use"`
> → matches only memories containing **all seven words literally**

That essentially never happens. The longer the question, the more certainly it matches
nothing.

## Measured

Hit-source breakdown across the 10-case recall harness, live store (13,406 memories):

```
              fts   vec   both
plain-English    0    50     0
literal-kw       0    46     4
```

**Zero hits from the FTS leg on plain-English queries. Zero on literal-keyword queries
too** (4 arrived via `both`). Effectively **all** retrieval is carried by the vector leg
alone.

Meanwhile the fusion weights (`config.ts:387`) are:

```
alpha (bm25) 0.4   beta (cosine) 0.4   gamma 0.1   delta 0.1   epsilon 0.1
```

**40% of the ranking weight is allocated to a leg that returns nothing.** The product
describes itself as "6-signal hybrid retrieval." It is currently running on one.

## What is NOT proven — read this before "fixing" it

This FEAT establishes that **the leg is dead**. It does **NOT** establish that reviving
it will improve recall.

Plausible outcomes, in order of how much they'd change the answer:
- **It helps.** Recovering a 40%-weighted signal lifts MRR, and closes some of the
  residual gap (plain-English 0.658 vs literal-keyword 0.750).
- **It does nothing.** The vector leg already surfaces the right answers; BM25 just
  agrees with it more loudly.
- **It hurts.** OR-semantics BM25 on a 10-word question matches on common words (`what`,
  `does`, `this`) and injects noise into a ranking that currently works.

**All three are live possibilities. Measure before believing.** This investigation has
already produced three confidently-wrong conclusions, every one of which was a plausible
mechanism assumed to explain a number it had not actually been tested against.

## Scope

- Rebuild the FTS query so a multi-word natural-language query can match. Options:
  - `OR`-join the terms (FTS5 supports it) — simplest, and the noise risk above is real.
  - Drop stopwords before joining.
  - Use FTS5's `NEAR`/ranking rather than bare phrase AND.
  - Keep implicit-AND for short/quoted queries, relax it for long natural ones.
  - **Consider whether BM25 should be weighted at all** once the vector leg is fixed —
    `alpha: 0.4` was tuned (if at all) against a *broken* vector leg. Its correct value
    post-RECALL-S1 is unknown.
- **Re-tune the fusion weights against the harness.** They are a guess
  (`alpha 0.4 / beta 0.4`) and have never been swept. With a working vector leg (S1) and
  possibly a working keyword leg (this FEAT), the right split is an open empirical
  question.

## Acceptance criteria

- **AC-1** — Given a multi-word natural-language query, when it is searched, then the FTS
  leg returns a non-zero number of hits. (Today: zero. This is the bug.)
- **AC-2** — Measured against `scripts/eval/recall-quality/run.mjs`: plain-English MRR
  **does not regress** from the post-S1 baseline (0.637). **If reviving BM25 makes recall
  worse, that is a finding, not a failure — report it and consider dropping `alpha` to
  ~0 instead.**
- **AC-3** — The hit-source breakdown (`fts` / `vec` / `both`) is reported before and
  after. A fix that leaves `fts: 0` has not fixed anything.
- **AC-4** — Fusion weights are swept against the harness and set from evidence, not
  inherited from a guess. Record the sweep.
- **AC-5** — Short/exact queries (`"7777"`, a quoted phrase, an error code) must still
  work. Relaxing to OR must not break the case BM25 is genuinely good at.

## Why this matters beyond MRR

The product's own positioning is **hybrid retrieval** — keyword and semantic, fused. It
has been shipping **semantic-only**, with 40% of the ranking budget spent on a leg that
returns nothing, while describing itself as 6-signal. Whatever the fix, the claim and the
code should agree.
