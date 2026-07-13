---
type: plan
created: 2026-07-13T09:00:00Z
author: lead (session 05e92741)
objective: Consolidated plan for every fix needed to make astramem's memory actually useful — retrieval, extraction quality, memory shape, and the existing 13,350-atom store
status: DRAFT — for architect-reviewer before implementation of the unbuilt parts
supersedes: 20260713T020000Z-recall-quality-remediation-plan.md (whose root-cause diagnosis was WRONG; see §0)
---

# Memory quality — master plan

## §0 — How we got here, including what I got wrong

astramem reports `served: 353, used: 0`. Memories are retrieved and never used. The
question was whether that is a broken counter or a broken product.

It is a broken product, and there were **four independent causes**. I got the first
diagnosis wrong twice, and both errors are recorded here because they shape the plan:

1. **First plan blamed junk atoms as the root cause** and sequenced all retrieval work
   behind extraction work. **Wrong.** The root cause is a missing query-side embedding
   prefix.
2. **Then I over-corrected**: I tested junk removal using the *shipped* classifier,
   measured +0.5 MRR, and declared "junk is harmless." **Also wrong.** I had measured a
   *broken filter*, not the absence of a problem. Junk removal with a *working* filter
   is worth **+13.0**.

Every number below is measured against the live store (13,350 memories) using
`scripts/eval/recall-quality/run.mjs`.

## §1 — The four causes, measured

| # | Cause | Evidence | Gain |
|---|---|---|---|
| **C1** | **Query embedded with no instruction prefix.** `src/search/search.ts:349` calls `embed.embed([query])` bare. `mxbai-embed-large` is an **asymmetric** model requiring a query-side prefix; documents must NOT get one. A question and the statement answering it are not neighbours without it. | plain MRR 0.467 → 0.642 with prefix injected | **+17.5** |
| **C2** | **Junk gate too narrow.** `durability-gate.ts` (FEAT-441) shipped 4 days ago, default `'off'`, and its taxonomy missed `configure`/`approve`/`search`/`rebuild`, capped `bare_todo` at 8 words, had no shell-prompt pattern. | old gate caught 6% of top-5 (+0.5); widened gate catches 24% (**+13.0**) | **+13.0** |
| **C3** | **Live config uses the WORSE extraction model.** `%APPDATA%\Astramem\config.yaml` overrides `llm.extraction.model` to `qwen2.5-coder:7b`. The repo's own A/B (`src/cli/init.ts:68-94`): coder = **F1 59%**, `qwen2.5:7b` = **F1 67%, precision 99%**. Code default is already correct — only the live config is wrong. | benchmark in-repo | unmeasured, free |
| **C4** | **Memories are trivia by design.** `extract.ts:127`'s few-shot example teaches the one-line shape (`"Use SQLite instead of Postgres — simpler for a single-node deployment."`); v2 lists "explicit atomicity" as a goal. An agent recalling a *conclusion* with no *rationale* cannot judge whether it applies. | prompt read | product-level |

### CORRECTION (2026-07-13T09:15Z) — C1 and C2 are NOT additive. They OVERLAP.

An earlier version of this section claimed C1 + C2 sum to `0.733`. **That was my third
wrong measurement of this investigation.** Measured properly against the live store:

```
today (neither fix)                 MRR 0.487    8/10
S1 only (prefix, merged)            MRR 0.637    9/10     <- +15.0
S1 + junk archived (W6)             MRR 0.658    9/10     <- +2.1 more
literal-keyword ceiling             MRR 0.750
```

**The prefix does nearly all the work. The junk gate adds only +2 on top of it.**

Why, in hindsight: junk was devastating *because* semantic ranking was broken. Once the
embedder ranks the right answer properly, the real memory outranks junk on its own. Fix
the ranking and the junk mostly sinks by itself.

The earlier `0.733` figure came from **type-exclusion** (dropping `command` + `todo`
wholesale — 17% of the store by category), which is blunter than the content gate. It
got a bigger number by being cruder, and I presented it as if it were the gate's value.

**Consequences for this plan:**
- **W6 (archive existing junk) drops sharply in priority.** It buys +2, not +13. Do not
  clear 24% of the store for that.
- **W2's value is HYGIENE, not recall** — it stops *future* accumulation. Still worth
  enabling; not worth rushing.
- **A residual gap remains: 0.658 vs a 0.750 ceiling.** Plain-English still trails
  hand-crafted keywords by ~9pts and **I do not know why.** The untuned fusion weights
  (`alpha 0.4 / beta 0.4`, a guess) are the obvious next suspect. **This is now the most
  interesting open question in the plan.**

### The pattern in my own errors (three, all the same shape)

1. *"Junk is the root cause"* — it wasn't; the prefix was.
2. *"Junk is harmless (+0.5)"* — it wasn't; I had measured a **broken filter**.
3. *"The fixes are additive to 0.733"* — they aren't; they **overlap** at 0.658.

Every error was in **what I measured**, never in the reasoning built on top of it. The
reasoning was consistently sound and consistently applied to a bad number. **Reviewers:
assume a fourth exists.**

## §2 — The CLAUDE.md rule is wrong, and it is causing C4

`CLAUDE.md` mandates: *"Write memories SHORT — one fact per memory… a single embedding
over ~2,000 characters is diluted and the vector half of retrieval cannot find it —
verified 2026-07-12: a long lesson was retrievable **only by literal-keyword FTS**,
while the plain-English question it literally answered returned nothing."*

**That symptom is C1, not dilution.** Plain question fails, keywords work — the exact
signature of the missing query prefix.

**Tested it.** Long, prose memories written via MCP `remember`, queried in plain English:

```
zod strip-mode lesson  (684 chars):  bare #2  ->  prefixed #1
cherry-pick lesson     (536 chars):  bare #2  ->  prefixed #1
```

**Long memories retrieve at #1.** They are not diluted. The rule that forces trivia is a
workaround for a two-line bug.

**Precision about what is proven:** memories to **~700 chars** retrieve at #1. The
**2,000-char** claim is **untested**, not disproven — I have no 2,000-char memory in the
store. But 700 chars is already ~10× richer than the current 68-char trivia, and is the
shape the operator asked for. **No need to go near 2,000.**

## §3 — Work items

### W1 — Query-side embedding prefix (C1) — IN FLIGHT
Config-driven, keyed to the embedding model (a *wrong* prefix is worse than none; unknown
model ⇒ no prefix). Query side only — **must not** touch `08-embed-index.ts`. **Must not
reach BM25** (my experiment polluted it and still won; a correct impl must not).
Regression test: keyword-only results byte-identical before/after.
**Open:** does mxbai want a *document*-side prefix too? If yes ⇒ re-embed 13,350 atoms ⇒
separate slice. **Do not assume.**

### W2 — Junk gate (C2) — DONE, MERGED, NOT ENABLED
Taxonomy widened, 56/56 tests. **Ship on `lenient`, not `strict`** — lenient gates 4 of 5
reasons and holds back only `git_derivable`, the highest false-positive risk.
**Remaining:** flip `distill.durabilityGate` default. That is a deliberate act, not a
side effect.

### W3 — Extraction model (C3) — OPERATOR ACTION
One-line edit to the operator's `config.yaml`. **I will not touch their live config.**
Affects future extractions only.

### W4 — Rewrite the memory-shape rules (C4, part 1)
- **CLAUDE.md**: replace "write memories SHORT / one fact per memory" with a target of
  **300–800 chars** carrying claim + rationale + tradeoff + provenance. Note the
  ~1,500-char caution as *untested*, not as fact.
- Same correction to the harness's own memory-writing guidance if present.
- **This is the operator's standing-orders file — propose wording, do not silently
  rewrite.**

### W5 — Richer extraction prompt (C4, part 2) — FEAT-479
Rewrite the few-shot examples: **the examples ARE the spec** — the model copies them.
Target the 300–800 char shape.

**THE UNRESOLVED TENSION (this is the real design question):** atomic memories are
individually **supersedable** — the bitemporal model (`valid_to`, `invalidated_by`)
depends on invalidating one claim and replacing it. **A memory carrying three claims,
one of which goes stale, cannot be cleanly superseded.** Richer memories and clean
supersession are in genuine conflict. **This must be resolved by design, not discovered
in production.**

Candidate resolutions (for review to pick or reject):
- (a) Rich memories are `lesson`/`decision` (rarely superseded); atomic ones stay for
  `fact`/`command` (frequently superseded). Type-dependent shape.
- (b) Supersede-whole-memory only; accept that one stale claim invalidates the whole
  atom and a new one is written. Simple, lossy.
- (c) Structured memories (claim + rationale fields), superseding the claim independently.
  Most correct, most work, biggest schema change.

### W6 — The existing 13,350 memories
~24% junk by the widened gate. Extracted with the *worse* model AND the *terse* prompt.
So they are junky, thin, AND lower quality than a re-run would produce.

Options (**review should choose**):
- **Archive** the gate-failing ones via the existing `archive()`/`restore()` pair
  (`memory-events.ts:338,367`) — reversible, non-destructive. **Reject "demote via
  importance"**: `gamma`'s max swing on the fused score is `0.1/1.1 ≈ 9%`; realistically
  ~3 points. It cannot sink a keyword-relevant junk atom. Quantified, not guessed.
- **Re-distill** from source transcripts with the fixed model + prompt. Highest quality,
  highest cost, **depends on transcripts still existing** — verify before choosing.
- Operator has stated "no customers, prod data is disposable," which makes a hard purge
  defensible — but archive costs the same and de-risks a wrong taxonomy. **Save the
  disposability allowance for something that needs it.**

### W7 — Harden the instrument
- Harness must **import `classifyDurability`** rather than reimplementing junk detection
  (`run.mjs`'s `isJunk()` is a second, weaker, unsynced copy that will drift now that W2
  widened the real one).
- Expand ground truth 10 → 40–60 cases, across domains (current set is biased toward
  tonight's proxy work).
- **Report a range, not a 3-decimal point estimate.** FEAT-450 documents a sibling eval
  in this repo that was noise-dominated (±14 F1 on identical configs) for exactly this
  reason. Do not repeat it.
- The harness has **already lied once** — its first draft used generic markers
  (`deploy`, `schema`, `latency`) and scored junk to-dos as correct answers, reporting a
  flattering 8/10. An instrument that cannot return bad news is not an instrument.

## §4 — COORDINATION HAZARD (must resolve before W5)

`.claude/artifacts/loop/plans/20260713-conversational-extraction-profile-plan.md`
(another session, same day) is **also rewriting `extract.ts`**, from the opposite
direction: it wants extraction *more liberal* for conversational content (LoCoMo extracts
at 0.5 atoms/session because the prompt is too strict), via a `distill.extractProfile:
'engineering' | 'conversational'` axis.

W5 wants *richer* memories. That plan wants *more* memories. **Same file, adjacent goals,
two builders.** They should almost certainly be **one piece of work**. Sequence or merge —
do not land independently.

## §5 — Acceptance criteria

- **AC-1** — W1: prefix reaches the embedder only; BM25 query text byte-identical
  (regression test proves it). Plain MRR improves ≥ **+15pts**.
- **AC-2** — W1+W2 together: plain-English MRR ≥ **0.70** on the expanded ground truth,
  measured against a daemon built from real main — **not a read-time simulation.** Every
  number in this plan is currently a simulation; the final one must not be.
- **AC-3** — W2 enabled at `lenient`; the mode choice is recorded with reasoning.
- **AC-4** — W5: extraction produces memories carrying **rationale and consequence**,
  judged on content, not length (a long trivia fragment is still trivia).
- **AC-5** — W5: recall does **not regress** — richer memories must not become
  unfindable ones. This is the guard on the whole C4 fix.
- **AC-6** — W5: the supersession story for multi-claim memories is **explicitly decided**
  and documented.
- **AC-7** — W6: whatever is done to the 13,350 existing memories is **reversible**, or is
  an explicitly-approved irreversible act.
- **AC-8** — W4: CLAUDE.md's memory rules are corrected, and the ~1,500-char caution is
  labelled **untested**, not asserted as fact.

## §6 — Questions for review

1. **W6 — archive, re-distill, purge, or leave?** Re-distill is tempting (the store was
   built with the worse model AND the terse prompt) but depends on transcripts surviving.
   **Check whether they do.**
2. **W5's supersession tension** — (a), (b), (c), or something better? This is the
   deepest question in the plan and the one I am least confident about.
3. **Is 300–800 chars the right target?** It is proven-retrievable and ~10× richer than
   today. But it is an operator preference dressed as a spec — is there a principled basis?
4. **Should W5 and the conversational-extraction plan be merged into one FEAT?** I think
   yes. Confirm or refute.
5. **Is the ~1,500-char caution worth keeping at all**, given it is untested? Or should we
   just test it and delete the hedge?
6. **What am I still wrong about?** I have been wrong twice in this investigation, both
   times confidently, and both times the error was in *what I measured*, not in the
   reasoning on top of it. Assume a third error exists and go looking for it.
