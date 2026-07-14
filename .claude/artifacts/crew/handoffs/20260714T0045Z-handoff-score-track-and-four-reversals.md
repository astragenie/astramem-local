# Handoff — the score track, and five confident numbers that were wrong

**Supersedes** `20260714T0130Z-handoff-EXTRACTION-is-the-lever.md`. That doc's headline
(*"344 facts never reached the store, +17.3 points"*) is **contaminated — the diagnostic
has a 42% false-negative rate**. See §3.

---

## 1. Merged tonight (7, all reviewed, guards proven to fire)

| PR | What it fixed |
|---|---|
| **#262** | The extraction prompt **told the model to write ISO-8601 dates into atom `text`** — which score **exactly 0.0** under the scorer's punctuation-stripping normalizer. **115/321 temporal answers were bare ISO; 93% scored zero — including dates that were exactly right.** `2023-05-07` → the single token `20230507`. |
| **#269** | The conversational extraction prompt **told the model to discard interpersonal reactions** ("sentiment padding") — and LoCoMo scores exactly those as gold facts. **We instructed the model to throw the data away, then measured it for missing it.** |
| **#266** | `withTimeout` **abandoned but never cancelled** LLM calls. A caller giving up at 300–800ms left the real Ollama generation running **9–30s more**, holding the GPU's **single execution slot**, invisibly. Plus: `format: json` guarantees valid JSON, **not a JSON array** — the decomposer got an object, `Array.isArray` rejected it, and it returned `[]` on **48 of 48** real queries. |
| **#254** | A memory that exists and **can never be recalled** (row in `memories`, none in `memories_vec`) had no canary. 13 live in production. |
| **#255** | The auto-capture canary counted **all time** — green forever once history accrues, so it can never detect that capture *stopped*. |
| **#256** | The no-`ok:true`-in-`catch` build guard **was scanning a file that had become a shim.** Rewritten as a TS-AST walk; **proven to fire** against pre-fix `main`. |
| **#270** | Postmortem + a CLAUDE.md `setUTCMonth` warning — **whose own example had to be corrected, because it didn't actually overflow.** |

**Note the shape of #262 and #269.** Both are cases where **we instructed the model to do the
wrong thing and then blamed the model.** That is the theme of the night, not a coincidence.

**Closed on principle: #257.** See §5.
**Filed:** #261, #263, #264, #267.

---

## 2. FEAT-487 (ranking) is DEAD — and the decision is SAFE

```
rank-ok    386  (46%)   retrieved in top-10, STILL answered wrong
not-in-db  344  (41%)   "never extracted"  -> 42% of these are FALSE NEGATIVES (§3)
rank-miss  111  (13%)   only 19 VERIFIED   -> ranking is worth ~+1
```

**Perfect reranking buys ~1 point.** FEAT-487 budgeted 12–18h at an estimated +7 to +11.
**A one-hour gate killed it.** This survives §3's recalibration — false negatives don't move
questions into `rank-miss`.

**Independently, the decomposer never worked at all** (0/48 usable, #266). Had we flipped the
flag and re-run, we'd have measured "decomposition doesn't help" and been **wrong about why.**

---

## 3. THE RECALIBRATION — the instrument shares the bias of what it measures

**`diagnose-retrieval.mts` has a 42% false-negative rate** (n=50, stratified across all 10
conversations). It uses **token containment** — the same brittleness that causes the score
problem it was built to diagnose.

```
gold  : "because of their inclusivity and support for LGBTQ+ individuals"
stored: "...because it helps LGBTQ+ folks with adoption and its inclusivity
         and support appealed to her."       <- CAPTURED. Bucketed "never extracted."
```
`"folks"` doesn't stem-match `"individuals"`. **Tracked in #267.**

**The error points the wrong way.** A false negative is a fact we **stored, retrieved, and
scored wrong on anyway** — it belongs in `rank-ok`, the *unreachable* bucket. **Every false
negative shrinks the fixable prize and grows the unfixable one.**

### The honest split of the "extraction gap"
```
42%  false negatives   -> not ours
58%  genuinely absent
      22%  known mechanism (reactions #269, granular specifics)
      36%  NO MECHANISM  <- largest genuine gap; see §4
```

---

## 4. Real mechanisms found (all zero-GPU, from reading the store)

1. **MISATTRIBUTION — the most important finding of the night, and it is not a score issue.**
   conv-48: the transcript has **Jolene** saying *"we visited a lot of delicious cafes."*
   The store files the cafés under **Deborah**. Both have separate Rio trips; they were
   **cross-attributed**. Another atom hedges to *"Jolene and another person"* rather than
   naming the partner.
   **Every other gap is a MISSING fact — the user asks, gets nothing, notices nothing.
   This one is a CONFIDENTLY WRONG fact.** Same class as the #257 fabrication we killed —
   committed by the model instead of a regex.
   **OPEN QUESTION: does `EXTRACTION_SYSTEM_PROMPT_V3` — the profile PRODUCTION runs
   (`config.ts:651`, `extractProfile: 'engineering'`) — share it? If so, that is live data
   corruption in real users' memories.** Being checked.
2. **Advice/counsel dropped** — 3/3 clean. The model captures the *receiving* person's
   activity and drops the *giving* person's prescriptive content. Same shape as #269's
   reaction bug. Natural follow-up carve-out.
3. **Recency fixation on long chunks** — conv-44 session_18: a 3111-char chunk produced 3
   atoms, **all restating only its LAST topic**; everything earlier, gone. **Unverified
   whether systematic — correlate chunk length vs. atom position before concluding.**
4. **Structural ceiling** — some gold answers derive from **image pixels** (lighting colour),
   present in neither the dialogue nor the `blip_caption`. **No prompt reaches this.**

**Poisoned distill jobs were REFUTED as a mechanism** — the jobs table is clean (272/272
`completed`), and the missing facts scatter across normal atom-yield percentiles. **The
benchmark run was infrastructurally clean, so 0.4610 is NOT an understatement.**

---

## 5. Why #257 was closed unmerged

Regex date-grounding. **Three validation rounds, three distinct fabrication classes:**
`of` → possessives + `before`/`for` → **pronoun possessives** (`"Her last week was
overwhelming."` → `"Her the week before 15 July 2023 was overwhelming."`).

**The task is not regex-shaped.** Deciding whether "last week" is a session-relative adverbial
or a modifier bound inside another noun phrase is **syntactic** — it needs a parser. Each guard
round closed exactly the demonstrated attack. **There is no round where we get to be confident.**

**Three code reviews passed it. Three behavior validations broke it.** Full write-up: #270.

---

## 6. Is 0.60 reachable? Honestly: probably not.

```
current            0.4610   (n=1986, full suite)
category-averaged  0.4007   <- the honest number
projected w/ merges ~0.47-0.49 (UNMEASURED — no eval rerun yet)
honest ceiling     ~0.55
```
The headline is flattered by **adversarial** (446 questions where abstaining is correct).
**A system with no memory at all scores ~22 by abstaining on everything.**

**`rank-ok`'s 386 questions (+19.4) were written off as unreachable — but that was ASSERTED,
never measured.** WS6 is now checking whether **atom verbosity** is a real lever: we cannot
change the frozen answerer, **but we control every word of the atom it reads.** If our text is
verbose or hedged, the answer inherits the dilution. **That would be the same class as #262 —
a defect in what we STORE, exposed by the scorer. Not scorer-fitting.**

**0.60 otherwise requires touching the answerer, which inflates the score and measures nothing.**

**Safe to publish today: 0.4610 full-sample**, beating the LoCoMo paper's best RAG baseline
(41.4) and GPT-3.5-16K full-context (37.8), same metric, no judge. **That claim is real.**

---

## 7. HARD RULES (all were violated tonight; all caught; none fatal)

- **The GPU has ONE execution slot.** I starved my own diagnostic to **30s/recall** by running
  it alongside the bench. **Serial. Always.** (`codex-subscription` is **cloud** — it does not
  contend.)
- **Do NOT `git stash`** — repo-global across worktrees; four sibling stashes are on it,
  including another session's unpushed work. Use `git diff > x.patch` + `checkout` + `apply`.
- **Do NOT run `bun run test`** — the full suite fires live Ollama calls **regardless of
  `ASTRA_MEMORY_MOCK_PROVIDERS`** (#251).
- **Do NOT touch `answer.mts`'s prompt/model/k.** Frozen answerer.
- **`tsc --noEmit` covers `src/` ONLY.** `typecheck:tests` is a separate gate — it caught a
  real error in #266 that a clean `tsc` structurally could not see.
- **Never kill by image name. Never touch the default datadir — it IS production.**

---

## 8. The lesson

**Four features were built, shipped, and never worked — every one reporting success:**
decomposition returning `[]` on 48/48 queries; a build-fail lint scanning a shim; a temporal
fix writing correct dates in a zero-scoring format; an extraction prompt **instructing the
model to discard the facts we then measured it for missing.**

**Five confident numbers were wrong. Four were mine:**
1. *"qwen3:8b is broken"* — measured with it as **both** extractor and compactor. Never isolated.
2. *"Ranking is worth +7 to +11"* — actually **+1**.
3. *"Extraction is +17.3"* — **42% false negatives.**
4. *"A batch-truncation bug is eating the atoms"* — **mine.** Refuted by a contiguity check.
5. *"Poisoned distill jobs explain the missing facts"* — **mine.** Refuted by a clean jobs table.

**Every correction came from an agent re-deriving the claim instead of inheriting it.**

**Measure before you build. Then check that your instrument isn't measuring itself.**
