# Handoff — LoCoMo performance: incremental tuning is exhausted, the score problem is structural

**Date:** 2026-07-20
**Owner (next):** whoever picks up the LoCoMo score goal
**Objective of this handoff:** record everything the 2026-07-20 session tried to lift the LoCoMo
score, why almost all of it failed or was noise, and make the case that the remaining gap is
**structural, not tuning** — the next real move is a redesign of the retrieval/evidence/measurement
layer, not another config lever.

> Scope note: "redesign" here means the **retrieval + evidence-assembly + measurement** approach —
> NOT the daemon/storage/MCP infrastructure. The 2026-07-13 teardown
> (`docs/research/20260713-teardown-and-reinvent.md`) already concluded "salvage the core, don't
> rewrite the daemon." Nothing here contradicts that. The thing that may need redesigning is *how
> memories become answer evidence*, which that teardown did not settle.

---

## TL;DR verdict

- **Retrieval tuning is exhausted.** Fusion (RRF, FTS-OR) is refuted; the cross-encoder reranker is
  the only confirmed win and it's small (+0.03–0.06 llm-judge). Evidence-excerpt adds +0.02. That's
  the whole harvest.
- **The "ingest side is a bigger lever" idea was a mirage** — it dissolved into extraction noise.
- **A hard ceiling makes 0.80 unreachable by retrieval alone:** the oracle factorial measured that
  *perfect* evidence (the exact gold turns) scores **0.75** with the current cheap answerer. 0.80 is
  above that. You cannot rank your way past a ceiling.
- **Measurement itself is broken at sample scale:** a single codex extraction of one conversation
  swings the score **±4.3 llm-judge points**. Most single-run conv-26 A/Bs this session were inside
  that noise band.
- **Therefore:** the credible paths to a real jump are (a) surface evidence *beyond the single cited
  turn* (multi-scope/graph — a real build), (b) a stronger answerer (operator has locked cheap), or
  (c) accept ~0.75 as the realistic ceiling on the current ruler. All three are redesign-scale
  decisions, not tuning.

---

## What we tried (full ledger, all cheap-recipe conv-26 unless noted)

| lever | result | verdict |
|---|---|---|
| **P0.1 config no-op bug** (fusion weights silently ignored) | real bug, fixed | ✅ correctness |
| **P0.2 FTS OR-join** (crippled lexical leg) | noise-level, within variance | ⚠️ correctness, not a win |
| **P1 RRF fusion** | regresses every config; multi-hop 0.28→0.15 | ❌ REFUTED (min-max→RRF thesis wrong on this corpus) |
| **P3 multi-query** | structurally inert (`expand` request-body-only, harness never sets it) | ⏸️ unmeasured |
| **P2 cross-encoder reranker (real ONNX)** | +0.06 (v2), +0.03 (v3) llm-judge, robust across 2 stores | ✅ confirmed, small |
| **reranker topK tuning** | topK=40 best; topK=100 regresses; bigger model (bge) worse + blows 30s route deadline | ✅ minor |
| **evidence-excerpt reranking** (query+atom+evidence) | +0.02 llm-judge, consistent | ✅ tiny |
| **WT-C relations/links/provenance** (migrations 056/057) | pipeline VALIDATED (94 spans/22 relations/1027 links on fresh ingest) but scores flat — retrieval doesn't consume it yet | 🟡 infra, unrealized |
| **extraction-prompt change** (`relations[]` request) | +0.007 vs ±0.043 extraction noise | ❌ REFUTED (noise) |
| **"ingest-side lever"** (v3 store scored +0.048 over v2) | dissolved into ±4.3 extraction noise (v2 low draw, v3 high draw) | ❌ MIRAGE |

Full evidence: `docs/research/20260720-boot-crashloop-and-wave1-retrieval-findings.md`,
`docs/eval-runs/LEDGER.md`, `docs/specs/20260720-retrieval-overhaul-plan.md`.

---

## The three structural findings that point to redesign

1. **The 0.75 evidence ceiling (oracle factorial).** With the current answerer + judge, even feeding
   the *exact gold source turns* caps at 0.75 overall (0.843 single-hop). Retrieval improvements can
   only close the gap *toward* 0.75, never beyond. Beating 0.75 requires surfacing evidence the
   single cited turn doesn't contain — i.e. **multi-scope / chained / provenance-bundled evidence**.
   This is the one lever with headroom, and it's a build, not a tune. WT-C already laid the storage
   (relations/links/provenance); nothing consumes it at retrieval time yet (that was Wave-2 P4/P5,
   never built).

2. **±4.3-pt extraction noise per conv-26.** A single codex extraction of the same 19-session
   conversation swings llm-judge by ±4.3 points. This means: single-conversation A/Bs across
   re-ingested stores are near-worthless; only *same-store* deltas are trustworthy; and reliable
   ingest-side measurement **requires the full suite** (10 conversations averages the noise) or 3+
   extractions per variant. Any future ingest work that skips this will chase ghosts (we did, for
   ~2 hours). See memory `extraction-noise-conv26`.

3. **The Zep 0.947 gap decomposes as ~⅓ measurement + ~0.18 retrieval + ~0.20 evidence-sufficiency.**
   (From the judge-swap diagnostic — LEDGER `oracle judge-swap gpt-5.4-CoT`.) The measurement third
   is the cheap-vs-CoT judge harshness (operator has locked cheap judge, so we eat it). The retrieval
   third is mostly harvested now (reranker). The evidence-sufficiency third is the multi-scope build
   in finding #1. There is no config that closes any of these.

---

## What a redesign would actually target (the real "shenanigans → rethink")

Ordered by leverage:

1. **Multi-scope evidence assembly (highest leverage, only path past 0.75).** Stop returning an
   unordered list of single-fact atoms. Build an *evidence bundle* per question: the atom + its exact
   source turn + adjacent turns + entity-graph-linked turns + temporally-adjacent events, locally
   re-ranked under one token budget, and teach the answerer to consume grouped chains. This is
   Codex's P4 (chained 2-hop) + P5 (provenance bundling); WT-C's storage feeds it. Expected +0.05–0.12
   *beyond* the atom-only ceiling — the first thing that can cross 0.75. Real, multi-week build.

2. **Re-examine the atom granularity itself.** Single-fact atoms may be the wrong unit for multi-hop
   (the bridge fact and the answer fact live in different atoms, and dense retrieval rarely pulls both).
   Worth asking whether episodic/turn-span representations (which migration 001 already stores but
   retrieval never uses) should be a first-class retrieval scope alongside atoms.

3. **Measurement overhaul (prerequisite for ALL of the above).** Move the dev loop to full-suite
   (n=1986) or ≥3-extraction sampling so a real +0.01–0.02 is visible above the ±4.3 noise. Without
   this, no ingest-side change can be honestly evaluated. Cheap; do it first.

4. **(Blocked) stronger local answerer.** The 0.75 ceiling is answerer-bound; a stronger answerer
   would raise it. Operator has locked the cheap gpt-5-mini answerer (and cheap judge) for all runs —
   revisit only with explicit operator approval. Note: a *local* answerer (product constraint) makes
   0.90 harder, not easier (per both Codex reviews).

---

## What is shippable NOW (not redesign — bank these)

- **Reranker + evidence-excerpt** (merged, `enabled:false`). Evidence-backed small win. Before flipping
  the default, run a **full-suite rerank-off vs rerank-onnx A/B** to get a number that survives the
  ±4.3 noise. Then flip `crossEncoder.enabled`.
- **Watchdog boot-grace fix** (merged `35e8f149`). Fixes the prod crash-loop on large encrypted DBs.
  NOT deployed — needs (a) the `reinstall` verify-health companion fix (same 90s slow-boot blind
  spot) and (b) operator approval. Prod currently runs with the watchdog **disabled** as mitigation.
  See memory `daemon-boot-crashloop`.
- **FEAT-439 hook gate** — the post-merge auto-reinstall hook turned a local feature merge into a prod
  outage today. Gate it to release branches or make it opt-in.

---

## Open decisions (operator)

1. Enable reranker + evidence-excerpt by default? (needs full-suite confirm first)
2. Commit to the multi-scope evidence build (Wave-2 P4/P5) as the real path, or accept ~0.75?
3. Deploy the watchdog fix (needs reinstall companion fix + approval)?
4. Re-enable a stronger answerer/judge for milestone reads, or stay cheap-only?

## Risks / traps recorded (so the next agent doesn't repeat them)

- **Mock-vs-ONNX reranker trap:** `run.mts` has no `--rerank` flag and silently uses the `mock`
  Jaccard reranker; only `oracle-factorial`/`ab-baseline` use real ONNX. A mock run produced a false
  "reranker regresses" alarm this session. Always confirm `provider:'onnx'` in the run-manifest.
- **Extraction noise:** never trust a single-extraction cross-store conv-26 number (finding #2).
- **Prod incident class:** merging anything touching `migrations/` or `src/storage/` fires the
  FEAT-439 reinstall hook against the live daemon.

## State of the tree

- Branch `feat/retrieval-overhaul` @ `ffd02ab3` — all Wave-1 wins + watchdog fix merged, tsc clean.
  NOT pushed, NOT on main. Nothing enabled by default (reranker/evidence off).
- Reusable provenance eval store: `docs/eval-runs/20260720-baseline-v3-provenance/`.
- Memories: `retrieval-fusion-refuted`, `extraction-noise-conv26`, `daemon-boot-crashloop`,
  `eval-cheap-stack-only`.

## Suggested next handoff

**"Multi-scope evidence bundling — spike P4/P5 against the v3 provenance store, full-suite measured."**
That is the one path with headroom past 0.75. Everything else is either shipped-and-small or refuted.
