# Handoff — LoCoMo scoring: CoT-judge run, retrieval-lever A/B sweep, prompt review

- **Date:** 2026-07-23 01:20 UTC (session date 2026-07-22)
- **Branch:** `feat/retrieval-overhaul`  ·  **HEAD:** `34930755`
- **Owner (this session):** lead (single-session, operator-directed)
- **Prior context:** champion 0.6002 / service-day 0.5430 (conv-1 n=199); full-suite best 0.4840 (n=1986). Champion gap = proven codex ±6pt day-variance. See `docs/eval-runs/README.md` + `LEDGER.md`.

## Objective
Operator asked for a 10% (conv-1) LoCoMo run with **CoT judge + champion (conv-liberal) prompt** to probe "0.70 territory," then a data-driven hunt for any remaining lever (rerank, multi-scope/decompose, prompt) and a review of a ChatGPT critique of the extraction prompt.

## What was done (all evidence-backed, recorded in `docs/eval-runs/LEDGER.md`)

### 1. CoT-judge champion-prompt run (the headline)
- Recipe: conv-1 n=199, `ASTRA_EXTRACT_PROMPT=conv-liberal` (2026-07-18 champion 0.60-era prompt), passes=2, sweep=tuned-default(v2), k=15, extract=codex-subscription/gpt-5.4-mini, compaction=never, answerer=azure/gpt-5-mini. git=a37e85ea. 329 atoms / 19 sess.
- **token-F1 (all cats): 0.5883** (good codex day — within variance of 0.6002 champion). cat: mh 0.298 tmp 0.695 od 0.375 sh 0.513 adv 0.872.
- **gpt-5.4 CoT rejudge (cat1-4, n=152): overall 0.6579 / cat-avg 0.5936.** CoT vs token-F1 cat1-4-avg = **+0.123 = measurement lenience** (confirms oracle judge-swap +0.08–0.13).
- **0.70 NOT reached and not reachable this way.** CoT is a *scorer* lever, not a *pipeline* lever; 0.70 only ever appeared with PERFECT gold evidence (oracle gold-turns = 0.750). Archived: `docs/eval-runs/cot-judge-conv-liberal/` (+ `cot-rejudge-metrics.json`).

### 2. Same-store retrieval-lever A/B (isolates lever from day/extraction variance — same 329 atoms, re-answer only)
| arm | overall | multi-hop | note |
|---|---|---|---|
| **rerank OFF (baseline)** | **0.5883** | 0.298 | practical best — nothing beat it on overall |
| rerank mock (Jaccard) | 0.5370 | 0.226 | pure loss, reject |
| rerank onnx | 0.5716 | **0.399** | ranks great, breaks abstention (adv 0.872→0.723) |
| onnx + score-floor (best 0.4) | 0.5819 | 0.377 | over-abstains content (open-dom collapses); reject |
| llm-rerank phi4-mini | 0.5626 | 0.279 | phi weak; over-abstains |
| **onnx+abstain CEILING (sim)** | **0.6068** | 0.399 | perfect-routing ceiling, +0.019, no cheap realizer |
| multihop mock (run2 repl) | 0.5886 | 0.320 | wash (run1 0.5969 was answerer noise) |
| multihop LLM qwen2.5:7b | 0.5852 | **0.353** | best cheap multi-hop, overall wash |
| multihop LLM phi4-mini | 0.5799 | 0.307 | worst; phi weak aux model |

**Verdict: multi-scope investigation CLOSED.** Every retrieval-side lever (rerank, decompose) helps its target category but taxes the rest → net ~0 on overall (`fuse.ts` normalizes over the pool; LoCoMo's 24%-adversarial mix punishes recall-broadening). **rerank-OFF 0.5883 stands as practical best.** The reranker's real value is *production* (non-adversarial) traffic — consistent with the v3 llm-judge enable-default gate decision.

### 3. Under-extraction bug hunt (free, on the 329-atom store)
- ALL guard-drop tables = **0** (relation/entity/evidence/validity/link/gate). No starved sessions (0/19 < 8 atoms). → under-extraction here is **"model never emits the specific fact,"** NOT a code/guard bug. So the extraction lever is **prompt-side, not code-side.**

### 4. Prompt review (ChatGPT critique of conv-liberal, reviewed twice)
- ChatGPT's first review scored conv-liberal 4/10 "for engineering" — **invalid premise**: conv-liberal is the *personal/LoCoMo* profile; engineering uses `EXTRACTION_SYSTEM_PROMPT_V3` ("You extract durable knowledge from AI coding agent transcripts") — the shipped default. Its "build separate profiles" recommendation = FEAT-479, already shipped.
- Revised review (~8/10): valid residual points target V3, NOT LoCoMo — coarse 7 atom types (no atom subtype), hypothesis-lifecycle/status gap, structured evidence provenance, code entities. **BUT:** `supersedes`/`replaces` already exist as relation predicates; `invalid_at` already exists but has **fired 0/2499** (built-never-invoked class). Key caveat: all suggestions are metadata-layer → dead weight unless the *emitter* (prompt) AND *consumer* (retriever/reader) both ship. **None move the LoCoMo number** (personal domain, token-F1 over atom TEXT; type/status not scored, not retrieval keys).
- Prompt dumps for review: `<scratchpad>/PROMPT-A_pass-a_conv-liberal.txt` (25.5k), `PROMPT-B_pass-b_specifics-sweeper-v2.txt` (9.1k), `..._v1_CHAMPION-ERA.txt`.

## Changed files / evidence
- **Commit `41dee73e`** — `answer.mts` (`ASTRA_LOCOMO_RERANK_LLM` gate, `ASTRA_LOCOMO_RERANK_SCORE_FLOOR` gate), `run.mts` (`--cross-encoder-provider`), LEDGER rerank rows, archived cot-judge run.
- **Commit `34930755`** — `run.mts` (`--multihop-provider`, `--multihop-timeout-ms`), `spawn-daemon.ts` (writes multiHop.provider/timeoutMs), LEDGER decompose rows.
- All harness changes **additive, non-breaking** (default paths byte-identical). Working tree clean.
- Run dir `.eval-data/locomo/runs/20260722-cot-conv-liberal/` — all arms preserved as `hypotheses.{rerank-off,rerank-mock,rerank-onnx,onnx-abstain-sim,llm-rerank-phi,floor-0.2/0.4/0.6,multihop-mock,multihop-mock-rep2,multihop-llm,multihop-llm-phi}.jsonl`; default files restored to rerank-off headline.

## Confidence
- **High** — retrieval levers are wash (tested to death, same-store, replicated where noise was suspected).
- **High** — 0.70 unreachable via judge/prompt swap (only gold-evidence reaches it).
- **Medium** — 0.5883 is one good codex day (single conv-1). Needs full-suite + ≥3-run median before publishing ANY number here.

## Risks / open questions
- **Answerer noise floor ≈ ±0.008 overall** (gpt-5-mini nondeterminism) — single same-store runs can't resolve deltas smaller than that. Multi-hop signal on n=32 is ±0.02. Replicate or accept the noise band.
- **Prompt path is the LAST live in-pipeline lever, but UNMEASURED.** Oracle extraction headroom = −0.058 (llm-judge/conv-26); 36% of the gap is "no mechanism" (unfixable). Honest EV of prompt tuning = **+0.01–0.03**, +0.05 only on the good tail. Blind volume tuning BACKFIRES (proven: 448-atom store < 329-atom store; `fuse.ts` junk re-ranks good atoms).
- All numbers single conv-1 / one codex day / **diagnostic** — not publishable.
- Built-never-invoked risk if pursuing ChatGPT's status/subtype/provenance ideas (see `invalid_at` 0/2499).

## Gold-fact bucketing — MEASURED (2026-07-23), on the 329-atom store
For each wrong content question (cat1-4, token-F1 < 0.3 on rerank-off hypotheses = 59/152), an LLM checked (SEMANTIC) whether the gold fact is present in ANY of the 329 stored atoms. **ABSENT = extraction gap (prompt-reachable); PRESENT = fact stored, lost downstream (retrieval/answerer/token-scorer).**

**Detector matters (hypothesis-ledger rule, live again):** qwen2.5:7b judged 11/59 ABSENT (19%) — but it was **false-PRESENT** over the ~7k-token context (lazy pattern-match). Codex gpt-5.4-mini re-judge: **29/59 ABSENT (49%)** — 2.5× more, and the trustworthy number.

| cat | wrong | ABSENT (codex) |
|---|---|---|
| multi-hop | 19 | 6 (32%) |
| temporal | 7 | 3 (43%) |
| open-domain | 9 | **8 (89%)** |
| single-hop | 24 | 12 (50%) |
| **TOTAL** | 59 | **29 (49%)** |

**Transcript-presence split (codex, tightens the ceiling — the 3-way split of the 59 wrong content Qs):**
| bucket | count | meaning |
|---|---|---|
| PRESENT (downstream) | 37 (63%) | fact stored, lost in retrieval/answerer/token-scorer — NOT prompt-fixable |
| ABSENT→**fixable** | **15 (25%)** | fact in transcript, extraction missed it — the real prompt lever |
| ABSENT→unanswerable | 7 (12%) | not in source — unfixable by anything |

Per-cat fixable: single-hop **8**, multi-hop 4, temporal 2, open-domain **1**. Per-question detail: `.eval-data/locomo/runs/20260722-cot-conv-liberal/gold-bucketing-results.json`.

**FINAL verdict: prompt path is LIVE but MODEST.** Prompt-fixable = 15/199 → **+0.053 absolute ceiling, +0.02–0.04 realistic** (after the extract→retrieve→answer haircut). **63% of content losses are downstream (not prompt); 12% dataset-unanswerable.** **Single-hop extraction is the fattest prompt target (8), NOT open-domain** (mostly unanswerable — the earlier single-run "89% ABSENT" was noisier). Instrument caveat: codex store-check has run-to-run noise (this run 22 store-ABSENT vs prior 29, ±7 at temp 0) — "15 fixable" is ±a few; ceiling robust to ~+0.03–0.05, not precise per-question.

## Suggested next handoff — gold-fact-present bucketing (GATE before any prompt tuning)
**Do NOT tune the prompt blind.** Run the bucketing first (~1 hr): for every wrong-answer question, LLM-check (SEMANTIC, not token — the old detector had 42% FN) "is the gold fact in ANY stored atom?" → bucket into never-extracted / extracted-not-retrieved / retrieved-but-wrong.
- If misses are **durations / quiet-speaker / temporal-into-text** → prompt-targetable → tune Pass A exhaustiveness (#275, HELD, untested on codex), single-variable, `--runs 3`, measure junk too.
- If misses are **"not in transcript / no mechanism"** → prompt path is dead → stop.

Also standing: the "real number" is unknown until a **full-suite (n=1986) + ≥3-run median** run — every conv-1 number here is a good-day point, not a floor.
