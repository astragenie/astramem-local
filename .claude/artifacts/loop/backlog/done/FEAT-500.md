---
id: FEAT-500
status: triaged
priority: P2
category: retrieval
target_release: v0.19.0-beta
created: 2026-07-14
updated: 2026-07-14
depends_on: []
slices: []
derived_from: docs/research/20260714-competitive-teardown.md (steal #3, Mnemon recall.go signals)
pm_customer_impact: 0.45
pm_effort_estimate: 0.15
pm_strategic_alignment: 0.50
pm_technical_risk: 0.15
pm_dependency_depth: 0.10
composite_score: 0.6075
pm_composite_priority: P2
pm_autonomous_safe: true
pm_reviewed: 2026-07-14
autonomous_safe: true
triage_notes: "P2 via formula (impact 0.45, alignment 0.50 both fail P1/P0 bars). composite = 0.45*0.35 + 0.50*0.30 + 0.85*0.20 + 0.85*0.10 + 0.90*0.05 = 0.6075. Scored against the CORRECTED remaining scope: architect review found per-signal scores already SHIPPED 2026-07-13 (buildExplanation() already attaches ScoreExplanation to every SearchHit on the MCP wire) — pending file body already carries a 'RESCOPED 2026-07-14' note; remaining scope is just a top_signal argmax field + answerer-prompt A/B (~20 LOC), smallest FEAT in this batch. technical_risk 0.15 (single-file additive field, no schema/contract change). autonomous_safe=true. DISAGREES WITH RELEASE PLAN (plan labels P1): even on the corrected small scope, customer_impact is capped because the FEAT is a measurement whose own success criterion allows 'no delta ⇒ drop the answerer-prompt change' — real but unproven value against the 46%-answerer-loss bucket."
---
# FEAT-500: top_signal field + answerer-prompt A/B over existing per-signal scores

## Description

**RESCOPED 2026-07-14 after architect review** (artifact
`20260714T164500Z-architect-review-feat-498-502-competitive-teardown.md`): the original scope
("expose fuse.ts component scores — computed but not exposed") was **already shipped 2026-07-13**,
one day before this FEAT was filed. `buildExplanation()` (`src/search/search.ts`) attaches a full
`ScoreExplanation { final, signals: Record<string, {raw, weight, final}> }` to every `SearchHit`
(bm25, cosine, importance, freshness, usefulness, entity_bonus, agent_bonus, multi_hop), reaches
the MCP wire via the `clampScores` passthrough, and the fusion identity (`final === score`) is
already contractually asserted. Do NOT rebuild any of that.

Remaining real scope (small):

1. **`top_signal` derived field** — argmax of `signals` by `.final`, added to `ScoreExplanation`
   (or `SearchHit`). ~1 file, ~20 LOC. Mnemon's `via` equivalent. No manifest churn (additive
   field on an existing tool; parity test is name+owner scope only).
2. **Answerer-prompt A/B (the actual value):** wire `signals`/`top_signal` into the answerer
   prompt, re-run a LoCoMo subset vs fused-score-only baseline, record the F1 delta. 46% of
   measured LoCoMo losses are answerer-side — this measures whether signal transparency moves
   that bucket.

## Acceptance hints

- `top_signal` unit test (argmax ties resolved deterministically).
- A/B numbers recorded in this FEAT + eval artifact before any answerer-prompt rollout.
- No delta ⇒ keep `top_signal` (harmless, debugging value), drop the answerer-prompt change.

## Notes

~0.5-1 engineer-day + the A/B run. Was 1-2d before rescope. Original steal evidence: Mnemon
`internal/search/recall.go` `signals` + `via` (Apache-2.0).

## Implementation status (2026-07-14, builder pass)

**Part 1 — `top_signal` field: DONE.**

- `ScoreExplanation.top_signal?: string` added next to `final`
  (`src/search/search.ts`), computed by a new exported pure function
  `computeTopSignal(signals)` — argmax by `.final`, alphabetical-by-name
  tie-break (`Object.keys(signals).sort()` then first strict `>` win).
- Set in two places, both of which finalize `signals`: the base
  `buildExplanation()` return, and the post-rerank merge site (recomputed
  there too, not carried over — the `cross_encoder` signal added by rerank
  can itself become the argmax).
- **Wire contract updated** (this WAS a schema touch, contrary to the
  `pm_technical_risk` note above — see "Correction" below):
  `contracts/schemas/retrieval-result.v1.schema.json`'s `explanation` object
  is `additionalProperties: false` / ajv-strict, and
  `tests/contracts/conformance.test.ts` validates a REAL `search()` response
  against it. Added `top_signal` as an OPTIONAL string property, same
  posture as the existing `reason` field (added 2026-07-13). Regenerated
  `contracts/types/retrieval-result.v1.d.ts` and
  `contracts/zod/retrieval-result.v1.ts` via
  `node contracts/generate-types.mjs && node contracts/generate-zod.mjs`;
  `node contracts/validate.mjs` — 55/55 fixture checks still pass (additive
  optional field, no existing fixture affected).
- Tests: `tests/search/top-signal.test.ts` (new — pure-function argmax/tie
  cases + two real `search()` integration checks, one with rerank), plus one
  new MCP wire-shape test in `tests/mcp/server.test.ts` asserting
  `search_memory`'s JSON-RPC response carries `explanation.top_signal` as a
  real key of `explanation.signals`.

**Correction to the FEAT's own scope note:** "No manifest churn... no
schema/contract change" was true of `contracts/manifests/mcp-tools.v1.json`
(the MCP tool-name manifest — genuinely untouched, additive field on an
existing tool) but NOT true of `contracts/schemas/retrieval-result.v1.schema.json`
(the separate ScoreExplanation wire schema, which IS `additionalProperties: false`
and IS exercised by a live conformance test). Both are "contracts/", easy to
conflate. The fix was a 3-line additive schema change + codegen regen, well
within the ~20 LOC estimate, but worth flagging so the next FEAT that touches
`ScoreExplanation` knows to check `retrieval-result.v1.schema.json` too.

**Part 2 — answerer-prompt A/B: PREP done, A/B run NOT executed (per dispatch scope).**

- `scripts/eval/locomo/answer.mts`: `buildAnswerPrompt`/`formatSignalBreakdown`
  now exported; opt-in `includeSignals` option threads through
  `answerConversations`'s `opts`, defaulting to `false` (zero prompt effect
  when unset — pinned by `scripts/eval/locomo/answer.signals.test.ts`'s
  byte-identical-prompt test). CLI entry reads env `ANSWERER_SIGNALS=1` (env,
  not a flag, so it composes with every existing `run.mts`/`answer.mts` flag
  combination without a new CLI surface).
- `scripts/eval/locomo/run.mts` (the normal orchestrator entry point — see
  its own header doc) reads the same `ANSWERER_SIGNALS` env var and threads
  `includeSignals` into its `answerConversations()` call, so the flag works
  whether a run is driven directly via `answer.mts` or via the standard
  `run.mts` orchestrator.
- `scripts/eval/shared/daemon-client.ts`'s eval-only `SearchHit` type widened
  with an optional `explanation` field (the daemon's `/recall` route already
  returns it on the wire since the 2026-07-13 CONTRACT-FREEZE adoption; this
  eval client just wasn't typed for it yet).
- When `ANSWERER_SIGNALS=1`, each retrieved hit's prompt line gains a
  compact suffix: `<text> [top signal: <name> | <name>=<final>, ...]`
  (signals sorted highest-`.final`-first) via `formatSignalBreakdown()`.

### Exact A/B subset command (NOT run in this pass — do not launch a
multi-hour eval; this is the recipe for whoever runs it)

Use a modest `--n` subset (not the full 10-conversation / ~1986-question
LoCoMo suite) so the comparison finishes in minutes, not hours — mirrors the
existing WS2 cross-encoder-flip A/B pattern in
`scripts/eval/locomo/README.md` ("Cross-encoder rerank flip experiment").
Requires an Azure answerer deployment configured per
`scripts/eval/shared/config.ts` (`resolveAzureConfig()`).

```bash
# 1. Baseline — signals OFF (default; byte-identical to every prior recorded score)
bun scripts/eval/locomo/run.mts \
  --n 30 --seed 42 --extract-profile conversational \
  --run-dir .eval-data/locomo/runs/feat500-baseline

# 2. Treatment — signals ON, same sample/seed/extract-profile for comparability
ANSWERER_SIGNALS=1 bun scripts/eval/locomo/run.mts \
  --n 30 --seed 42 --extract-profile conversational \
  --run-dir .eval-data/locomo/runs/feat500-signals

# 3. Score both and diff (judge.mts's multi-run path hard-requires matching
#    run-params.json across --run-dir args, so an accidental scope mismatch
#    between the two runs above fails loudly instead of printing a bogus
#    delta)
bun run eval:locomo:judge -- \
  --run-dir .eval-data/locomo/runs/feat500-baseline \
  --run-dir .eval-data/locomo/runs/feat500-signals
```

Read the two `metrics.json` outputs' per-category and overall F1 — per the
FEAT's own acceptance hint, no delta ⇒ keep `top_signal` (it is harmless,
debugging-only) and drop the `ANSWERER_SIGNALS` prompt change (or leave it
opt-in and unused); a real delta ⇒ record the number here and decide on a
default-on rollout as a follow-up FEAT, not inside this one.

### Why the A/B itself was not run here

Dispatch scope for this pass was explicitly PREP-only ("do not run the full
LoCoMo suite... do NOT launch a multi-hour eval run"). Even the `--n 30`
subset above needs a live Ollama/Azure-backed daemon spin-up, ingest, and
distill-wait cycle that does not fit a bounded implementation dispatch.
Whoever runs the A/B should record the resulting F1 deltas in this file
under a new "A/B results" section before deciding on rollout, per the
acceptance hint.

> **Closed 2026-07-17 — reconciled shipped-but-open.** shipped d9781deb (#319)
