# Handoff — the score track, and four confident numbers that were wrong

**Supersedes** `20260714T0130Z-handoff-EXTRACTION-is-the-lever.md` in one specific way:
that doc's headline — *"344 facts never reached the store, +17.3 points"* — is
**contaminated**. See §3. Everything else in it stands.

---

## 1. Merged tonight (5, all reviewed, all with the guard proven to fire)

| PR | What it fixed |
|---|---|
| **#262** | The extraction prompt **told the model to write ISO-8601 dates into atom `text`** — which score **exactly 0.0** under the scorer's punctuation-stripping normalizer. **115/321 temporal answers were bare ISO dates; 93% scored zero — including dates that were exactly right.** `2023-05-07` collapses to the single token `20230507`. |
| **#254** | A memory that exists and **can never be recalled** (row in `memories`, none in `memories_vec`) had no canary. Now reports a rate with a stated denominator. 13 such memories are live in production. |
| **#255** | Auto-capture canary counted **all time** — goes green forever once history accumulates, so it can never detect that capture *stopped*. Now a 7-day window; below-floor returns `inconclusive`, not a fabricated `ok: true`. |
| **#256** | The no-`ok:true`-in-`catch` build guard **was scanning a file that had become a shim.** Rewritten as a TS-AST walk; **proven to fire** against pre-fix `main` (flags 2 live violations the old regex scanner found zero of). |

**Open, gated:** #257 (temporal grounding — failed validation once, fixed, re-validating),
#266 (abort/JSON-array — in review).

**Filed:** #261, #263, #264, #267.

---

## 2. FEAT-487 (ranking) is DEAD — and that decision is safe

The retrieval diagnostic bucketed all 841 single-hop questions:

```
rank-ok    386  (46%)   retrieved in top-10, STILL answered wrong  -> UNREACHABLE
not-in-db  344  (41%)   "never extracted"                          -> see §3
rank-miss  111  (13%)   ...only 19 VERIFIED                        -> +0.96
```

**Perfect reranking buys ~1 point.** FEAT-487 budgeted 12–18h and estimated +7 to +11.
**A one-hour gate killed it.** `declined`.

**This conclusion survives §3's contamination** — false negatives don't move questions
into `rank-miss`. The ranking kill stands.

**Independently: the decomposer never worked at all.** `format: json` guarantees valid
JSON, **not a JSON array**. Models return an object, `Array.isArray` rejects it,
`getSubQueries` returns `[]` — **0 usable decompositions out of 48 real questions.**
Had we flipped the flag and re-run the eval, we would have measured "decomposition
doesn't help" and been wrong about why. (#261 → #266.)

**`rank-ok` (386) is the largest bucket and it is not ours to fix.** The correct memory
*was* retrieved, into the top-10 the answerer actually sees, and the answer still scored
wrong — token-F1 penalising a correct fact worded differently. **~46% of the single-hop
gap is unreachable by anything we build.** The only way to "fix" it is to strengthen the
frozen answerer, which inflates the score and measures nothing.

---

## 3. THE REVERSAL — `not-in-db` is contaminated. Read this before quoting +17.3.

**`diagnose-retrieval.mts` has false negatives, and it fails the SAME WAY the scorer does.**

Confirmed on the **first spot-check** (qa#87, conv-26 session_2):

```
gold answer : "because of their inclusivity and support for LGBTQ+ individuals"
stored atom : "Caroline chose an adoption agency because it helps LGBTQ+ folks
               with adoption and its inclusivity and support appealed to her."
```

**The fact is captured perfectly.** But the diagnostic uses **token containment** —
`"folks"` doesn't stem-match `"individuals"` — so containment falls under threshold and
the question is bucketed **`not-in-db`: "never extracted."**

**The instrument shares the bias of the thing it measures.** We used a token-containment
heuristic to diagnose a system whose headline problem *is* token-containment brittleness.

**And the error points the wrong way.** A false negative is a fact we **stored, retrieved,
and got scored wrong on anyway** — so it belongs in **`rank-ok`**, the *unreachable*
bucket. **Every false negative shrinks the fixable prize and grows the unfixable one.**

**The false-negative rate is being measured now** (30–50 questions, multiple conversations,
read-only against the run's plaintext `memory.sqlite.pre-encryption.bak`, zero GPU, zero
quota). **Do not quote an extraction ceiling until it lands.** Tracked in **#267**.

### What DID survive verification — the real extraction gaps

Two content classes are **genuinely absent** from the store, confirmed by reading it:

1. **Interpersonal reactions / opinions.** *"Melanie thinks Caroline is doing something
   amazing and will be an awesome mom."* Never became an atom.
   **And our own prompt is why:** the conversational profile's *"banned abstractions →
   sentiment padding"* rule explicitly tells the model to skip "a one-off reaction."
   **We instruct the model to discard the facts we then score it for missing.**
2. **Granular one-off specifics.** Headline topic captured ("Caroline has been trying
   abstract art"), the detail is not ("blue streaks on a wall", "pink sky").

**Neither fix is scorer-fitting.** *Why* someone chose an adoption agency is often the
most durable part of the decision — the decision is recoverable from context, the
motivation never is. A memory that drops it is worse for **any** user.

### The fix sequence — do NOT invert it
1. **Fix the prompt.** Stop instructing the model to discard reasons and reactions.
   **One call, zero added cost.**
2. **Measure.** How many of the (recalibrated) misses come back? State the denominator.
3. **ONLY THEN**, if density compression still binds (model emits ~5 atoms where a careful
   reader finds ~12), escalate to **multi-pass extraction**: different prompts per pass
   (headline facts / reason clauses / reactions), cheap passes on local `qwen3.5:4b`,
   one precision pass on codex.

**Building multi-pass first would work — and would permanently hide a one-line prompt bug
behind a 3× extraction cost we would never remove.**

---

## 4. `qwen3:8b is broken` — the evidence is CONFOUNDED

The universally-cited result (`qwen3-live-2026-07-13`: 20 failed fixtures, 154.5s/session,
no F1) ran with `qwen3:8b` as **both extractor AND compactor** — because
`daemon-runner.ts:46` **hardcodes the default compaction model to `qwen3:8b`** (#264).

**Nobody has ever measured `qwen3:8b` as an extractor with a healthy compactor.**

Also: **`qwen3:8b` IS already Q4_K_M.** Ollama has no smaller quant (only `q8_0`/`fp16`,
both larger). "Try a q4 build" is not available — 5896 MB resident *is* the q4.

**Do NOT tune `num_ctx` down to make it fit.** The v3 extraction prompt alone is ~3.8k
tokens and **Ollama silently truncates on overflow rather than erroring** — that is the
bug that kept entity extraction ~87% broken for weeks behind a green canary. Shrinking
the context trades a loud VRAM spill for a silent quality collapse.

**A clean 3-arm bench is running** (codex / qwen3.5:4b / qwen3:8b, `--compaction-model
qwen3.5:4b` held constant, `--runs 3`, serial). `--runs 3` is mandatory: **±14 F1 swing on
a single run** (FEAT-450).

**Early signal worth chasing: compaction dominates cost in BOTH arms** (4b 80s/session,
codex 39s/session, same compactor). **If that holds, the extraction-model debate is
largely a latency red herring and the compactor is the real lever.**

---

## 5. Is 0.60 reachable? Probably not honestly.

```
current              0.4610   (n=1986, full suite)
category-averaged    0.4007   <- the honest number
```
The headline is flattered by **adversarial (446 questions where abstaining is correct)**.
**A system with no memory at all scores ~22 by abstaining on everything.**

Realistic levers: extraction (**recalibrating — see §3**), temporal (#262, +1 to +3.5,
unmeasured), ranking (+1, dead). **`rank-ok`'s 386 questions (+19.4) are unreachable.**

**Best honest estimate: ~0.55 ceiling, and §3 may lower it.** **0.60 likely requires
touching the answerer — which inflates the score and measures nothing.** That line should
not be crossed without an explicit, informed decision by the operator.

**What is safe to publish today: 0.4610 full-sample**, beating the LoCoMo paper's best RAG
baseline (41.4) and GPT-3.5-16K full-context (37.8) on the same metric, no judge. **That
claim is real. 0.60 is not, yet.**

---

## 6. HARD RULES (violations happened tonight — all caught, none fatal)

- **The GPU has ONE execution slot.** I starved my own retrieval diagnostic to **30s/recall**
  by running it alongside the bench. **Serial. Always.** `curl -s localhost:11434/api/ps`
  before loading anything. (Note: **codex-subscription is CLOUD** — it does not contend.)
- **Do NOT `git stash`** — the stack is **repo-global across worktrees**. Four sibling
  stashes are on it right now, including another session's unpushed work. One agent
  stashed tonight and got lucky. Use `git diff > x.patch` + `git checkout` + `git apply`.
- **Do NOT run `bun run test`** — the full suite **fires live Ollama calls regardless of
  `ASTRA_MEMORY_MOCK_PROVIDERS`** (#251). Targeted vitest only.
- **Do NOT touch `answer.mts`'s prompt/model/k.** Frozen answerer. Concurrency was fine
  (#253, merged, score-neutral, pinned by test).
- **Do NOT kill by image name.** **Do NOT touch the default datadir — it IS production.**
- **Prod daemon is deliberately STOPPED** by another session (tasks `AstraMemoryD` +
  `AstraMemoryDWatchdog` disabled) to keep the GPU quiet. **Their call — left alone.**
  Captures spool to disk; no data loss.

---

## 7. The lesson, stated plainly

**Four features were built, shipped, and never worked** — and every one reported success:

- multi-hop decomposition returned `[]` on **48 of 48** real queries;
- a build-fail lint was **scanning a file that had become a shim**;
- a temporal fix wrote **correct dates in a format that scores zero**;
- the extraction prompt **instructed the model to discard** the facts we then measured it
  for missing.

**In every case the code was fine and the signal was a lie.**

**Four confident numbers were wrong, and each was caught by re-deriving it from the source
rather than inheriting it:**

1. *"qwen3:8b is broken"* — measured with it as **both** extractor and compactor. Never isolated.
2. *"Ranking is worth +7 to +11"* — actually **+1**. Killed by a 1-hour gate.
3. *"Extraction is +17.3"* — **contaminated by diagnostic false negatives.** Unknown true value.
4. *"A batch-truncation bug is eating the atoms"* — **mine**, and refuted in minutes by a
   contiguity check that showed the atoms span the session head-to-tail.

**Three of those four were mine.** Every correction came from an agent that checked instead
of complying.

**Measure before you build. Then check that your instrument isn't measuring itself.**
