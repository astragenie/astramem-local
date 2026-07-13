---
type: plan
created: 2026-07-13T02:00:00Z
revised: 2026-07-13T08:30:00Z
author: lead (session 05e92741)
objective: Fix astramem-local recall quality
status: REVISED after architecture review + two falsification experiments. The original plan's root cause and sequencing were BOTH WRONG.
measured_by: scripts/eval/recall-quality/{run.mjs, simulate-gate.mjs}
---

# Recall quality — revised plan

> **This plan was rewritten after review.** The original diagnosed junk atoms as the
> root cause and sequenced all retrieval work behind extraction work. **Both were
> wrong**, and I proved it with the reviewer's suggested experiment rather than
> defending the hypothesis. The original is preserved in git history (commit before
> this one) as a record of what a plausible-but-wrong plan looks like.

## What is actually broken

astramem's usefulness metric reads `served: 353, used: 0`. Two problems, both real,
**and they are independent** — not nested, as originally assumed.

### ROOT CAUSE — the embedder is being called wrong (2-line fix)

`src/search/search.ts:349` embeds the query with a bare `embed.embed([query])`.
**No instruction prefix.** Documents are embedded the same way in
`08-embed-index.ts`.

`mxbai-embed-large` (the configured embedder, `config.ts:379`) is an
**instruction-sensitive, asymmetric** retrieval model. It documents a required
query-side prefix (`"Represent this sentence for searching relevant passages: "`).
Without it, a *question* and the *statement that answers it* are not neighbours in
the vector space — which is exactly the observed failure.

**Measured.** Injecting the prefix into the query string (crudely — this also
pollutes BM25, so it is *handicapped against* the hypothesis):

```
bare query      MRR 0.467
prefixed query  MRR 0.642      +17.5 points
```

Two of three total misses became hits (`test-runner` MISS→#3, `prod-deploy` MISS→#4).
**Semantic search has been running at roughly half strength since it shipped.**

### SECONDARY — junk atoms (real, but NOT the cause of the above)

38% of returned hits carry no reusable knowledge — shell fragments (`"$ bun run test"`)
and **task echoes** (`"deploy the changes to production"`, `"Run full repo test suite"`)
— imperative restatements of instructions given to agents, stored as memories.

**Falsified as the root cause.** Re-scoring the harness with junk removed (using the
*shipped* classifier, not a reimplementation):

```
today          : MRR 0.487
junk removed   : MRR 0.492      +0.5 points   <- nothing
```

Junk wastes retrieval slots and pollutes results. It is **not** why recall fails.

### The junk fix ALREADY EXISTS and is switched off

`src/distill/durability-gate.ts` (FEAT-441, shipped 2026-07-09) implements a 5-reason
taxonomy — `bare_todo`, `ephemeral_state`, `git_derivable`, `vacuous_negative`,
`path_fragment` — with a rationale-marker exemption, wired into the write path at
`08-embed-index.ts:144`, behind `distill.durabilityGate`, defaulting to **`'off'`**
(`config.ts:411`).

The original plan proposed spending 1–2 days building this. It exists. There is also a
**v2 extraction prompt** (`ASTRA_EXTRACT_PROMPT=v2`, `05-extract.ts:165-276`) with
durability reasoning already baked into it, shipped and untested in production.

---

## Revised plan

### S1 — Query-side embedding prefix (ROOT CAUSE. Do this first. ~half day)

Add the instruction prefix to the **query** embedding path only. Documents stay
unprefixed — that asymmetry *is* the fix.

- The prefix is **model-specific**. `mxbai-embed-large` wants
  `"Represent this sentence for searching relevant passages: "`; other embedders want
  different prefixes or none at all (a wrong prefix is worse than none). So it must be
  **config-driven, keyed to the embedding model**, not hardcoded.
- Applies at `src/search/search.ts:349` (query side) and **must not** touch
  `08-embed-index.ts` (document side).
- **Do NOT put the prefix in the BM25 query text.** My experiment did, as a shortcut,
  and it polluted keyword matching — the +17.5pt result was achieved *despite* that
  handicap. A correct implementation prefixes only the bytes sent to the embedder.
- Existing embeddings do **not** need regenerating — only the query side changes.
- Verify with the harness. Expect ≥ +17.5pts; less means the implementation is wrong.

**Open question for the builder:** does `mxbai-embed-large` also want a *document*-side
prefix (`"Represent this document..."`)? Check the model card. If yes, that is a
re-embed of 13,282 atoms — a much bigger job, and a separate slice. **Do not assume.**

### S2 — Turn on the durability gate (~half day)

- Extend `IMPERATIVE_VERB_RE` (`durability-gate.ts:99`) with the verbs it misses:
  `configure`, `orchestrate`, `ensure`, `address`, `raise`, `set up`. (Verified gap:
  `"Configure 'capture_source' to 'proxy'."` is currently **not** gated.)
- **Type-aware carve-out (BLOCKER — must be resolved first).** `gateDurability` is
  called with `mem.text` only; `mem.type` is never consulted (`08-embed-index.ts:144`).
  So a legitimate auto-distilled `type: 'command'` atom is gated identically to a junk
  todo. `command` and `todo` are **first-class types in the schema.** Either exempt them
  from `bare_todo`/`ephemeral_state`, or make a deliberate, recorded decision that
  auto-distilled commands are not worth storing. **Do not let this be decided by a
  regex as a side effect.**
- Flip `distill.durabilityGate: 'off'` → `'strict'`.
- Re-run the harness. Expect the junk rate to fall sharply and MRR to move only
  slightly (~+0.5pt, per the falsification above). **That is the expected result, not a
  failure** — this slice is about store hygiene, not recall.

### S3 — Existing 13,282 memories: ARCHIVE, do not demote, do not purge (~1 day)

- **"Demote via importance" is quantitatively dead.** `fuseScores` (`fuse.ts:107-125`)
  divides by the active weight sum (1.1). `gamma`'s maximum possible swing on the final
  score is `0.1/1.1 ≈ 9%`; demoting importance from ~0.4 to 0 moves the fused score by
  **≈0.036**. It cannot sink junk. Reject this option.
- Use the **existing** `archive()` / `restore()` pair (`memory-events.ts:338,367`) —
  non-destructive, hides from default queries, reversible. `archival.ts` already uses
  exactly this pattern for TTL policy.
- Backfill: classify the existing rows with `classifyDurability` (pure, no DB writes),
  archive the failures, leave a restore window, hard-`erase()` later if desired.
- This satisfies AC-5 for free. "No customers, data is disposable" makes a hard purge
  *defensible* — but archive costs the same and de-risks a wrong gate taxonomy. **Save
  the disposability allowance for something that actually needs it.**

### S4 — Strengthen the instrument (parallel, ~half day)

- Expand ground truth from 10 → 40–60 cases, across domains (not just tonight's proxy
  work — that biases toward recent memories).
- **Report a range, not a 3-decimal point estimate.** FEAT-450 documents that a sibling
  eval in this repo was noise-dominated (±14 F1 on identical configs) precisely because
  it trusted single-run point estimates on too few fixtures. Do not repeat it.
- Have `run.mjs` **import `classifyDurability`** instead of reimplementing junk
  detection — one taxonomy, one measurement. (Right now `isJunk()` is a second, weaker,
  unsynced copy, and it will drift the moment S2 extends the regex.)

### EXPLICITLY NOT DOING

- **Swapping the extraction model (Codex / a larger model).** The operator's instinct.
  It would have cost a week and fixed almost nothing — the extraction model was never
  the bottleneck. **The embedder was being called wrong.**
- **Cascade / multi-prompt extraction.** Same reasoning. Premature.
- **Retrieval fusion-weight sweep.** Do it *after* S1, if at all. Sweeping weights on
  top of a mis-called embedder is polishing the wrong layer.

---

## Coordination hazard

`.claude/artifacts/loop/plans/20260713-conversational-extraction-profile-plan.md`
(created the same day, by a different session) targets **the same files** —
`src/distill/prompts/extract.ts` and `05-extract.ts` — from the *opposite* direction:
it wants extraction to be **more liberal** (LoCoMo conversational content extracts at
0.5 atoms/session because the prompt is too strict). S2 here wants it *stricter*.

These are not actually in conflict — that plan proposes a `distill.extractProfile`
axis (`engineering` | `conversational`) that composes cleanly with a per-profile
durability-gate default. **But two builders must not land edits to `extract.ts`
independently.** Sequence them: S2 (a config flip + regex edit) first, then the
profile axis on top.

## Acceptance criteria

- **AC-1** — S1: query-side prefix is config-driven and keyed to the embedding model; a
  wrong/absent model key must not silently apply a wrong prefix.
- **AC-2** — S1: the prefix reaches the embedder ONLY. BM25 query text is unchanged.
  (Regression test: keyword-only search results must be byte-identical before/after.)
- **AC-3** — S1: plain-English MRR improves by **≥ +15pts** against the committed
  baseline. Below that, the implementation is wrong, not the theory.
- **AC-4** — S2: `type: 'command'` / `'todo'` handling is a **deliberate, recorded
  decision**, not an emergent property of a regex.
- **AC-5** — S3: every action on existing memories is reversible (archive/restore), or
  is an explicitly-approved irreversible act.
- **AC-6** — S4: the harness imports `classifyDurability` rather than reimplementing it.
- **AC-7** — Every improvement claim is backed by a harness run, with a range, not by
  inspection.

## What this episode is really about

The original plan was confident, detailed, well-structured, and **wrong in its central
claim**. It would have shipped a filter that already existed, in service of a hypothesis
that a ten-minute experiment refutes.

Two things caught it: a reviewer who checked the codebase instead of the plan, and a
falsification test that I ran *because it might prove me wrong*, not despite it.

The measured findings — `+17.5` from a two-line change, `+0.5` from the thing I was
sure about — are the whole lesson.
