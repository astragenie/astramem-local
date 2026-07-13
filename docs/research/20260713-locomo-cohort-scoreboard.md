# LoCoMo Cohort Scoreboard

*2026-07-13 · Sources: `docs/specs/20260713-locomo-score-plan.md`, `docs/research/20260713-teardown-and-reinvent.md` §3, public vendor materials cited inline.*

## The thesis

**Most published LoCoMo numbers in this cohort are not comparable to each other, several are not reproducible, and one of them is ours.**

This document exists to say that plainly, before it says anything flattering. A scoreboard that audits every competitor and waves its own number through is not a scoreboard — it's marketing with a table in it. The standard applied to Mem0, Zep, Letta, Cognee, and Supermemory below is applied to astramem-local first, and hardest.

---

## 1. Which config produced this number — labeled, and the direction surprised us

astramem supports more than one extraction configuration for LoCoMo, and they don't score identically. This section was wrong three times before landing on what the run artifacts actually say; that history stays visible below because it is the point of the section, not an embarrassment to edit away.

**Verified independently, by directly opening the primary run artifacts** — not a hand-maintained spec line, and not taken on a second party's word either:

- `.claude/worktrees/agent-a0112287d8dd8d401/.eval-data/locomo/runs/2026-07-13T14-59-21-798Z/run-manifest.json` — `config.models: {extraction: "qwen3:8b", extractionProvider: "ollama"}`, `sampled_qa: 199`
- its sibling `hypotheses.jsonl.metrics.json` — `overall_accuracy: 0.45401051750038257`, per-category `{multi-hop: 0.3537, temporal: 0.1236, open-domain: 0.3374, single-hop: 0.4439, adversarial: 0.8298}`
- `.claude/worktrees/agent-a0112287d8dd8d401/.eval-data/locomo/runs/2026-07-13T15-49-03-443Z/run-manifest.json` — `config.models: {extraction: "gpt-5.4-mini", extractionProvider: "codex-subscription"}`, `sampled_qa: 199`
- its sibling `hypotheses.jsonl.metrics.json` — `overall_accuracy: 0.42777774404596336`

The first run's per-category figures round to exactly the scoreboard's published 12.4 / 44.4 / 35.4 / 33.7 / 83.0 and its overall rounds to exactly 45.4 — this is not a plausible match, it is the source run.

| Config | Run manifest field | LoCoMo F1 |
|---|---|---|
| **Ollama, local, zero-account** (`qwen3:8b` extract + compact) | `extractionProvider: "ollama"` | **0.4540 — this is the published 45.4, confirmed** |
| **codex-BYO, cloud** (`gpt-5.4-mini`) | `extractionProvider: "codex-subscription"` | 0.4278, confirmed |

**The published 45.4 is the local, zero-account number.** Earlier passes over this same question got it wrong three different ways — first treating cloud-vs-local as undisclosed entirely, then asserting 45.4 was the cloud number and the zero-account figure was unmeasured, then (closer, but not there yet) asserting the manifests behind that correction didn't exist. That last miss had a specific, mundane cause: the manifests live two directories below a dot-directory (`.claude/worktrees/...`), and a naive `find`/glob invocation skips hidden directories by default — the files were never missing, the search that reported them missing was wrong. Reading the artifacts directly, at the full path, settles it: local-zero-account scored fractionally *higher* than cloud, not lower.

**Do not over-read this as "local beats cloud."** At n=199, one conversation, the gap between 0.4540 and 0.4278 is within noise — this sample size cannot support a directional claim that small (see §2 for the sample-size caveat in full). The honest, supportable claim is narrower and still genuinely good news for a local-first product: **local zero-account extraction is not worse than cloud extraction on this run.** Overclaiming it as a win would repeat the same mistake this section has already made, just in the opposite direction.

**A genuine open tension, left unresolved rather than papered over:** this repo's separate extraction-quality benchmark (`scripts/eval/extraction-bench`, ab-run 2026-07-08, judged by Azure gpt-5-mini) measures roughly a **14-point cloud-over-local gap** on synthetic engineering-transcript fixtures — azure gpt-5-mini 81% F1 vs. the best local model measured, `qwen2.5:7b`, at 67% F1. The LoCoMo run above shows no such gap, and if anything the reverse, within noise. These are two different benchmarks on two different domains (synthetic engineering sessions vs. LoCoMo's long-form conversational dialogues), so they aren't obligated to agree — but the discrepancy is worth naming rather than quietly dropping. Possible explanations, none confirmed: extraction-bench's cloud advantage may not transfer to LoCoMo's conversational domain, or n=199 is too small to see a real gap either way. Not resolved here.

**One more open variable, on a different axis than the correction above:** the LoCoMo run used `qwen3:8b` as the local extractor. This repo's own extraction-bench does not rank `qwen3:8b` as its best *local* model — `qwen2.5:7b` scores higher on that harness (67% vs. 65% F1) with better type accuracy and roughly a quarter of the latency. Whether swapping the local extractor from `qwen3:8b` to `qwen2.5:7b` would move the LoCoMo number, and in which direction, is untested. Flagged, not claimed.

**State plainly:**
- The published 45.4 is the **local, zero-account** number, confirmed against the run manifest that produced it — not a cloud number.
- The cloud (codex-BYO) run scored 0.4278 on the same sample: lower, but not distinguishably so at n=199.
- Both configs are supported, marketed paths. Labeling which one produced a given number is the requirement — neither config is illegitimate to publish.
- The full-sample rerun (§2) should **report both configs explicitly**, since this small-sample result is not strong enough to retire the comparison either way.

**The durable lesson, and the sharpest version of it:** this single configuration was asserted four different ways over the course of one session — `qwen3:8b`, then "a bad extractor," then codex-BYO, then "ollama beats codex, citing manifests that don't exist." Three of the four were wrong, and every one was stated with full confidence, including the corrections. The costliest error in the chain was not the original mistake — it was **confidently correcting an error with an equally unverified claim.** That is precisely the failure mode a document built on "cite the artifact, not the memory of it" exists to prevent, and it happened inside this document while it was being written. **A hand-maintained config line in a spec, and an assertion in a chat message, are both claims about a run — neither is the run.** Every future published number must be labeled by opening the run manifest that produced it and reading the field, not by trusting a prior description of what that manifest says — including this one; it is offered with exact byte-level values and full paths specifically so it can be re-checked rather than re-trusted.

---

## 2. Sample size — the second, independent caveat

Even setting §1 aside, the 45.4 has a second problem of its own:

| Category | F1 |
|---|---|
| temporal | 12.4 |
| single-hop | 44.4 |
| multi-hop | 35.4 |
| open-domain | 33.7 |
| adversarial | 83.0 |

This number is **frozen pending a full-sample rerun**, for one specific, checkable reason:

> It was measured on a **10% sample — one conversation, n=199** (`docs/specs/20260713-locomo-score-plan.md:8-9`). That same spec's own "Global caveats" section states, in its own words: **"Full-sample rerun required"** before trusting several of the downstream conclusions (`:136`).

The LoCoMo paper's baselines — human ceiling 87.9, best RAG 41.4, GPT-3.5-16K full-context 37.8 — all run the **full ~1986-question set**.

So: **"45.4 beats the paper's 41.4"** is, precisely, a one-conversation subsample being set against a full-dataset baseline. The metric is the same (token-F1, no LLM judge) — that part of the comparison is genuinely clean. The **sample** is not the same, and sample size is not a cosmetic detail here: per-category n ranges from 13 (open-domain) to 70 (single-hop), and the open-domain headline of 0.73 answered-F1 rests on **six answered questions**.

**§1 turned out to be good news on configuration (45.4 is already the local, zero-account number) — but §2's sample-size problem stands on its own and is unaffected by that correction.** Do not cite "45.4 beats 41.4" externally, in a README, in a pitch, or in a blog post, until a full-sample rerun exists — reporting both the local and codex-BYO configs per §1 — and can be cited alongside it. A scoreboard document that leads by exempting itself from its own rule would be worthless; this one doesn't.

---

## 3. The scoreboard

| System | Score | Metric | Judge | Sample | Comparable to our F1? |
|---|---|---|---|---|---|
| LoCoMo paper — human ceiling | 87.9 | token-F1 | none | full (~1986 Qs) | ✅ reference ceiling |
| LoCoMo paper — best RAG | **41.4** | token-F1 | none | full | ✅ the number we currently claim to beat |
| LoCoMo paper — GPT-3.5-16K full-context | 37.8 | token-F1 | none | full | ✅ |
| **astramem-local** | **45.4** (temporal 12.4 · adversarial 83.0 · single-hop 44.4 · multi-hop 35.4 · open-domain 33.7) | token-F1 | none | **n=199, 1 conversation, 10%** | ⚠️ same instrument, config confirmed **local, zero-account** (§1) — but **sample too small** (§2), frozen on that basis |
| **Mem0** (paper) | F1: single-hop 38.72 · multi-hop 28.64 · open-domain 47.65 · temporal 48.93. Also reports LLM-judge "J" ≈ 66.88. Adversarial **excluded** ("ground truth unavailable") | token-F1 (+ separate judge score) | none for F1 / LLM for J | unstated in what's public | ✅ **the only genuinely comparable head-to-head** — with one flag, see §4 |
| Zep / Graphiti | 84% → mem0 recalculates 58.44% → Zep counter-claims 75.14% | LLM-judge "accuracy" | LLM | unstated | ❌ not comparable, and contested — see §4 |
| Letta / MemGPT | 74.0% | undisclosed metric + judge | undisclosed | unstated | ❌ unverified |
| Cognee | unlabeled bar chart, no axis | unknown | unknown | unknown | ❌ **refuse to cite a number** — there isn't one to cite |
| Supermemory | no published score | — | — | — | ❌ no data |

---

## 4. The comparability verdict, per system

**LoCoMo paper baselines — CLEAN.** Same token-F1 metric, no LLM judge, full dataset. This is the only comparison in the entire cohort that is clean on all five axes (see §7). Our own number now clears the config-labeling axis (§1) but still fails the sample-size axis (§2).

**Mem0's F1 numbers — comparable metric, with one number that must be flagged, not headlined.** Mem0 publishes token-F1 per category, the same instrument we use, which makes it the only real head-to-head available. But their **temporal 48.93** cannot be assumed to represent anything an OSS user can actually run: the open-source `mem0.add(timestamp=…)` call **raises `ValueError`** — timestamped input is paywalled out of the OSS package entirely. That number was therefore measured against either a pre-paywall build or the managed platform, not against the code anyone can `pip install` today. Their newer, higher-profile **92.5** claim is worse: it has **no metric or judge defined anywhere in the repo**, and Mem0's own README states it reflects the **managed platform**, not the OSS SDK. Both numbers are flagged; neither is headlined.

**Zep / Graphiti — NOT comparable, and the numbers are internally contested.** LoCoMo does not appear anywhere in Zep's own arXiv paper (2501.13956). Every public Zep LoCoMo claim traces back to a blog post that was later edited, amid an active public dispute with Mem0 over the recalculated figures (github.com/getzep/zep-papers issue #5). Three different numbers (84% → 58.44% → 75.14%) exist for the same claimed result, none of them token-F1, all of them LLM-judge "accuracy." There is no honest way to rank against this.

**Letta / Cognee / Supermemory — UNVERIFIED.** Letta publishes a bare 74.0% with no disclosed metric or judge. Cognee publishes an unlabeled bar chart with no axis — this document treats that as **no number**, not a low-confidence number, and declines to cite one. Supermemory publishes nothing. No honest ranking is possible against any of the three.

---

## 5. The benchmark itself is partly broken — and this is the most important section

An independent audit (Penfield Labs) found LoCoMo's ground truth has **99 corrupted labels out of 1,540 questions — a 6.4% error rate** — putting the theoretical accuracy ceiling near **93.6%**. Any vendor number reported above that ceiling is describing something other than correctness against the stated ground truth.

Worse, in stress testing, the standard LLM judge used for "accuracy"-style scoring **accepted 62.81% of intentionally wrong-but-topical answers.**

**The consequence, stated explicitly:** this discredits every judge-scored number in this cohort — Mem0's "J" ≈ 66.88, Zep's contested "accuracy" figures — and is a direct, structural point in favor of deterministic token-F1, which cannot be gamed by a lenient judge the same way. Combined with astramem's CI-gated eval floors (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7, enforced on every push):

- Graphiti's own retrieval harness is explicitly **excluded from CI**.
- Cognee publishes an eval JSON but does not wire it into CI.
- Mem0, Letta, and Supermemory have **no retrieval benchmark gate at all** in their public repos.

**astramem-local is plausibly the only system in this cohort whose reported number is backed by a benchmark that would fail loudly if it regressed.** That holds true regardless of whether astramem wins or loses any individual category above — which is exactly why it is the fact to lead with in any external material, not the 45.4.

---

## 6. Where we actually stand, without flinching

Against the only honest head-to-head — Mem0's published F1 — restricted to categories both sides measured the same way:

- **We win single-hop**: 44.4 vs. 38.72.
- **We win multi-hop**: 35.4 vs. 28.64.
- **We lose open-domain**: 33.7 vs. 47.65.
- **Temporal is bad in absolute terms** — 12.4 — independent of whether Mem0's 48.93 counterpart is trustworthy. It is not: see §4. So the honest framing is not "we lose temporal 4x to Mem0"; it's "our temporal score is weak on its own merits, and we do not currently have a single trustworthy competitor number to benchmark that weakness against."

**Every number in this section is now confirmed to be astramem's local, zero-account config (§1)** — the more relevant comparison to make against a competitor cohort where local-vs-cloud is frequently undisclosed on the other side too (Mem0's own configuration for its published F1 numbers is unstated). That does not make the wins above proof of superiority — Mem0's config is still unknown — but it does mean astramem's side of the comparison is the harder, zero-key config, not a cloud-boosted one.

The temporal gap is real regardless of extraction configuration. The diagnosed root cause (`docs/specs/20260713-locomo-score-plan.md` §1, cross-checked by the teardown investigation) is an **extraction-schema** gap, not a storage or retrieval failure: `AtomSchema` carries no atom-level validity fields, so relative time expressions like "yesterday" are never anchored to an absolute date before being written to the atom text the answerer reads. Both the bitemporal schema (`migrations/006-atom-v3.sql`) and the `as_of` retrieval filter (`search.ts:264-278`) were independently verified correct. Nothing about this gap implicates the storage model. **One confound is still open, on a narrower axis than the cloud-vs-local question §1 settled:** the run used `qwen3:8b` as its local extractor, and this repo's own extraction-bench ranks a different local model, `qwen2.5:7b`, higher on quality and type accuracy (§1). Whether a stronger local extractor would move the 12.4 temporal figure specifically is untested — the schema-gap diagnosis is real and independently verified, but its exact magnitude on a best-local-extractor run has not been isolated.

---

## 7. Rules for citing a benchmark number

This is the durable output of this document — apply it to every future number, ours or a competitor's, before it goes in a README, a deck, or a blog post.

Any LoCoMo (or similar) number cited externally must state all five of:

1. **Metric** — token-F1, LLM-judge accuracy, or something else. These are not interchangeable and must never share a table column without a footnote.
2. **Judge model, or none** — if a judge scored it, name the judge. "No judge" is itself a fact worth stating, given §5.
3. **Subset / sample size** — full dataset, or a named subsample with its n. "n=199, one conversation, 10%" is a fact, not an asterisk to omit.
4. **Whether the code that produced it is the code a user can run** — the OSS package, a paywalled build, or a managed platform only. Mem0's temporal 48.93 is the cautionary example: same metric, different code path from what ships.
5. **For astramem specifically: which extraction config, named explicitly, and confirmed against the run manifest — not a spec's prose description of the run.** §1 is the reason this rule exists: the same number was mislabeled as cloud-extracted, then relabeled as codex-BYO, before the run manifest itself settled that it is local-zero-account. Any future astramem number must state the extraction configuration next to the F1, sourced from the artifact the run actually wrote.

**If any of the five is unknown, the number is marked `unverified` and is not tabulated beside a number that has all five answered.** This is the rule Cognee's bar chart and Letta's 74.0% fail. The 45.4 baseline now clears axis 5 — the config is confirmed local-zero-account against the run manifest — but still fails axis 3: the sample is n=199, one conversation, not the full set. **The full-sample rerun, reporting both configs per §1, is the actual next deliverable.**
