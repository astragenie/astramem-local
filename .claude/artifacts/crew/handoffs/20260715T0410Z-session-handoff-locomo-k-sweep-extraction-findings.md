# Session Handoff — LoCoMo score work: k-sweep win + extraction dead-end + measurement lesson

- **Date:** 2026-07-14 → 15 (overnight)
- **Objective:** "what else left to improve LoCoMo score" → measure levers, ship what's real.
- **One-line outcome:** Shipped a real +1.4 (recall depth k=15, **PR #340**). Proved extraction is NOT the lever (near-saturated; the "gap" was the diagnostic mislabeling inference/ranking). Answerer tuning backfired.

---

## SHIPPED / IN FLIGHT

### PR #340 — `feat(mcp): raise default recall depth to k=15` — THE WIN
- Branch `feat/mcp-default-recall-k15`, commit `556a256`. Reviewer PASS, 56 MCP tests green, build clean.
- `search_memory` limit 10→15, `recall_memory` k 5→15 (Zod default + `??` fallback + docs).
- **Next session: check PR #340 CI green → merge.** (If "no checks reported" → branch conflicts with main, `mergeable` first — see [[conflicting-branch-blocks-ci]].)
- Evidence: full-suite LoCoMo k-sweep, n=1986, dual-pass, codex extraction, **run validated** (k=10 reproduced the 0.5549 baseline at 0.5537):
  ```
  k=10  0.5537 (old default)
  k=15  0.5673  (+1.36)  <- shipped: value/cost sweet spot
  k=20  0.5713  (+1.76)
  k=25  0.5738  (+2.01, diminishing + adversarial/open-domain erosion)
  ```
  Gain is front-loaded (k=10→15 is +1.36 of +2.01). Past 15 = more client-LLM tokens for <+0.4 + category erosion.

## BRANCHES NOT MERGED (kept for the code, not shipping)

### `feat/extraction-conversational-specifics-sweeper` (`f032656`) — SHELVED
- H2 conversational specifics sweeper + H3a both-directions reaction check. Reviewer PASS, guardrails held (invalid_at preserved, engineering path byte-identical). Also fixed 2 latent bugs (profile never threaded to `extractSpecifics`; checkpoint cache-collision).
- **Shelved after validation: no target.** AC-1 on conv-26 moved cat-3 not-in-db 70%→70% (nothing). Atom inspection showed WHY (see lesson below). Kept on-branch for the code + bug fixes pending a multi-conversation signal that a real extraction gap exists somewhere.

### `feat/locomo-answerer-ab-flags` (`95efaf9`, `e659416`) — no PR, measurement tooling only
- Opt-in env flags on the LoCoMo answerer (ANSWERER_EFFORT/MAX_TOKENS/LIST_ALL/LESS_ABSTAIN), default byte-identical. Reviewer APPROVED.
- The answerer is benchmark-only (in prod the answerer = the client's LLM). Tuning it **backfired**: LESS_ABSTAIN cratered adversarial cat-5 (0.90→0.50). Do not ship answerer tuning.

---

## THE BIG LESSON (highest-value takeaway)

**The `diagnose-retrieval.mts` not-in-db bucket LIES — it mislabels inference and ranking as extraction misses.** Confirmed by inspecting actual atoms on conv-26:

- **Open-domain (cat-3) is INFERENCE, not fact-lookup.** Atoms are rich and already carry the facts; gold answers ("Liberal", "Likely no", "Psychology") are DERIVED, never stated — no memory can store them. The diagnostic counts them "not-in-db" but they're an answerer/reasoning task = the client LLM in prod.
- **Single-hop (cat-4) extraction gap is already ~closed** by dual-pass (10% not-in-db). Its real loss is **rank-miss** (fact extracted, ranked below k = RANKING), which more extraction *worsens* (junk atoms; `fuse.ts` re-ranks over the whole pool).
- Corrected split (llm-judge, dual-pass): not-in-db **40%** / rank-miss **15%** / rank-ok (answerer) **45%**. The part OUR system controls (extraction+ranking) is ~55%; ~45% is the answerer/client LLM.

**Rule for next time: before building any extraction slice, INSPECT THE ATOMS for the target category** (spawn a daemon on the datadir, recall each question, eyeball gold-vs-atoms). Don't trust the not-in-db number — it conflates inference/ranking with extraction. This is now in memory: `locomo-recall-vs-extraction-measured.md`.

Other corrections banked:
- **Baseline is 0.5549, not 0.4610** (W1+W2 dual-pass, commit 07b558b/#309 shipped 2026-07-14). Older docs/memory citing 0.4610 are stale.
- **"0.59" was never real** — conv-26 single-conversation luck (temporal 0.917 on that conv vs ~0.23 real). Never compare tiny-run numbers to full-suite.
- Rerank flip (mock Jaccard) HURT (−0.07); real rank-miss ceiling is only ~10-15%. Rerank is not the lever.

---

## REUSABLE ASSETS
- **Full distilled store** at `.eval-data/locomo/runs/fullsuite-ksweep/datadir` (101M, all 10 conversations, dual-pass, codex) — re-answerable at any k with NO re-distill (attach a daemon + `answerConversations`). Also `ab-smoke/datadir` (single-pass conv-26).
- Harness tools used: `diagnose-retrieval.mts --llm-judge` (paraphrase-aware buckets), `answerConversations` standalone (cheap re-answer at any k against a saved store). See memory `locomo-experiment-tooling.md`.

## NEXT-SESSION CANDIDATES (ranked)
1. **Merge PR #340** once CI green (the shipped win).
2. If chasing more score: the remaining OWN-able lever is **rank-miss** (fact extracted but ranked below k) — but it's small (~10-15%) and naive rerank hurt. Would need a real semantic cross-encoder (`crossEncoder.provider: http`), not the mock.
3. Extraction is NOT worth more investment on current evidence (near-saturated, atoms rich). Only revisit if a multi-conversation diagnosis (llm-judge) shows a real not-in-db gap on FACT-based categories somewhere.
4. Answerer improvements are benchmark-only (client LLM owns it in prod) — do not invest.

## Memory written this session
`locomo-recall-vs-extraction-measured.md`, `locomo-experiment-tooling.md` (both in the auto-memory index).
