---
id: FEAT-487
status: done
priority: null
category: retrieval
target_release: null
created: 2026-07-13
updated: 2026-07-13
depends_on: []
slices: []
derived_from: LoCoMo full-suite run 2026-07-13 (n=1986, overall F1 0.4610)
cross_product: [astramem-local]
tags: ["concern:retrieval", "stack:typescript", "surface:search"]
---

# FEAT-487: Turn on the ranking signals that ship at zero

## The measurement this comes from

First **full-suite** LoCoMo run (n=1986, not the n=199 single conversation every
prior number came from). Codex extraction, `429e99c`, k=10:

```
1 (multi-hop)   : 0.3145   (282)
2 (temporal)    : 0.1318   (321)
3 (open-domain) : 0.2318   (96)
4 (single-hop)  : 0.4332   (841)   <- 42% of the benchmark
5 (adversarial) : 0.8924   (446)

Category-averaged : 0.4007
Overall (F1)      : 0.4610   n=1986
```

Note the overall is **flattered by adversarial** (446 questions where abstaining
is correct, scored binary). Category-averaged 0.4007 is the harsher and more
honest number. Optimise against the categories, not the headline.

## The thing that makes this worth doing

Three ranking signals are **fully built, fully wired, and multiplied by zero**
(`src/config/config.ts:559`, `:562`, `:564`):

```
alpha 0.4 (bm25)   beta 0.4 (cosine)   gamma 0.1 (importance)
delta 0.1 (freshness)   epsilon 0.1 (usefulness — inert, every atom is 0.5)
zeta  0   <- ENTITY relevance      OFF
eta   0   <- agent match           OFF
crossEncoder: { enabled: false }   <- reranker, BUILT, OFF
multiHop:     { enabled: false }   <- query decomposition, BUILT, OFF
```

`search.ts` even computes the entity bonus **only if it would count**:
`const entityBonus = zeta > 0 ? entityBonusForQuery(...) : undefined;` — and it
never counts.

**ζ=0 was CORRECT until today.** Entity extraction was ~87% broken; a ranking term
over a three-quarters-empty table is noise. That changed: entity linkage is now
**99.6%** on fresh data (2477/2488 atoms in the eval store; live prod reads 0.0%
unlinked). **For the first time there is real entity data under that weight, and
the weight is zero.** This is `built-wired-never-invoked` in its most expensive
form — we built the extractor, the table, the relation graph, the MCP traversal
tools, AND the ranking term.

## SLICE-0 — the diagnostic is a GATE, not a formality

**Do not build anything until this runs.** `scripts/eval/locomo/diagnose-retrieval.mts`
already exists and buckets every wrong answer into three groups that need
**opposite** remedies:

| bucket | meaning | remedy |
|---|---|---|
| `not-in-DB` | the fact was never extracted | **distill work — this FEAT is worthless** |
| `rank-miss` | extracted, but ranked below k=10 | **fusion/rerank — this FEAT** |
| `rank-ok` | retrieved fine, answered wrong | answerer/ambiguity — **out of scope** |

Single-hop is **841 questions, 42% of the benchmark**. Guessing which bucket
dominates risks spending the largest lever on the board on the wrong fix.

**Kill condition:** if `not-in-DB` dominates single-hop misses, **close this FEAT**
and put the effort into extraction. Say so plainly rather than shipping ranking
work that cannot help.

The diagnostic already fixed its own pool-composition bug (a deeper `--limit`
silently changes `vecK`, which changes min-max normalisation, which changes rank)
— read its header before trusting a number from it.

**ETA: 1-2h** (script exists; run against the completed eval datadir).

## SLICE-1 — ζ (entity relevance) sweep

Only if SLICE-0 says `rank-miss`.

- ζ ∈ {0, 0.05, 0.1, 0.15}, η ∈ {0, 0.05}
- Isolated eval daemon (own port, own datadir — config is read once per process
  at boot, so this cannot touch prod)
- **Gate on the ADR-005 floors** (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7) **AND** on the
  LoCoMo per-category table. A win on the headline that regresses a category is
  not a win.

**Known risk, stated up front:** `entityBonusForQuery` is a blunt substring match
(`q.includes(r.name)`), so a boost can promote a coincidental name collision over
a semantically better hit. Single-hop (42% of questions) is what would pay for it
— and also what would suffer most if the dilution is real. Measure, don't hope.

Note η (agent match) is **structurally unmeasurable on LoCoMo** — there is no agent
dimension in the dataset. Sweep it for the ADR-005 floors only; do not read a
LoCoMo delta into it.

**ETA: 3-4h** (one config value, existing harness; the sweep is the cost).

## SLICE-2 — cross-encoder rerank

`src/search/rerank.ts` is complete and off by default (`crossEncoder.enabled:
false`, `topK: 50`, `timeoutMs: 300`).

Reranking the top-50 is the standard +5-10 in retrieval and attacks `rank-miss`
**directly**. It is the highest-expected-value slice **if** SLICE-0 says rank-miss
— and near-worthless if it says not-in-DB.

- Flip `crossEncoder.enabled`, measure, gate on the same floors
- The 300ms timeout is a real latency budget: measure p95 recall latency, not just
  the score. A +6 F1 that doubles recall latency is a product decision, not a free
  win.

**ETA: 4-6h** including the latency measurement.

## SLICE-3 — multi-hop query decomposition

`src/search/decompose.ts` exists, `multiHop.enabled: false`, `minQueryWords: 6`,
`maxSubQueries: 3`.

Multi-hop scores **0.3145 on 282 questions (14%)**. Headroom to 0.55 is worth
**~+3.4 overall points**. Smaller mass than single-hop, but the mechanism is
purpose-built for exactly this category.

⚠️ **`provider: 'mock'` is the default** — flipping `enabled` alone gets you a mock
decomposer. Wiring the real LLM decomposer means an **extra LLM call per query**,
which is a latency AND cost decision, not just a config flip. Do not present it as
one.

**ETA: 6-8h.**

## Explicitly OUT of scope

- **Touching `scripts/eval/locomo/answer.mts`'s prompt, model, or k.** It is the
  deliberately-fixed cheap answerer. Changing it inflates the score while telling
  us nothing about whether memory improved — that is how vendors publish 70s.
- **Temporal (0.1318).** It is the worst category and the biggest single hole, but
  it is **not a ranking problem** and it does not belong here. See below.

## What this FEAT will NOT fix, and someone should own

**Temporal is 0.1318 across 321 questions (16% of the benchmark).**

It was 12.4 before. Text-surface date grounding (PR #189 + timezone fix #191)
shipped specifically to fix it — and it moved essentially **nothing**.

The standing diagnosis — *"temporal is an extraction gap, not a schema gap"* — is
now **in doubt**, because the fix derived from that diagnosis did not work. **Do
not ship another fix on the same theory.** Re-open the investigation first. This
deserves its own FEAT and probably its own diagnostic.

## Realistic ceiling, stated honestly

| category | n | now | if fixed | overall gain |
|---|---|---|---|---|
| single-hop | 841 | 0.4332 | 0.60 | **+7.2** |
| temporal | 321 | 0.1318 | 0.50 | **+6.0** (NOT this FEAT) |
| multi-hop | 282 | 0.3145 | 0.55 | **+3.4** |
| open-domain | 96 | 0.2318 | 0.45 | +1.1 |

**~+18 points is the ceiling, and it needs ALL of them.** This FEAT can credibly
reach for **+7 to +11** (single-hop + multi-hop) — and only if SLICE-0 says the
misses are rank-misses.

**Total ETA: 14-20h**, front-loaded by a 1-2h gate that can kill 12-18h of it.
That asymmetry is the whole design.

> **Closed 2026-07-17 — reconciled shipped-but-open.** declined via SLICE-0 diagnostic gate 552a3afa (ranking ~1pt)
