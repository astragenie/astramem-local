---
id: FEAT-479
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-13
updated: 2026-07-13
depends_on: [RECALL-S1]
slices: []
derived_from: operator request 2026-07-13 + recall-quality investigation
cross_product: [astramem-local, astramem]
autonomous_safe: null
triage_notes: "Operator wants richer, human-readable, self-contained memories instead of atomic trivia. BLOCKED ON RECALL-S1 (query-prefix fix) — because the 'keep memories short' rule may itself be an artifact of the retrieval bug S1 fixes, and that must be tested before designing around it."
---
## Description

**Memories should be self-contained explanations, not trivia.**

Today the extractor produces atomic fragments:

> `"Use SQLite instead of Postgres for the local daemon — simpler for a single-node deployment."`

The operator wants memories a human (or an agent) can actually act on:

> *"We use SQLite rather than Postgres because the daemon is single-user and
> local-first — Postgres would require a server process the user has to manage.
> Tradeoff accepted: no concurrent writers, which is fine for one user. Decided
> 2026-05, see ADR-002."*

Context, rationale, tradeoff, consequence. **A memory you could hand to a new
engineer.** The current output is trivia, and trivia is exactly what an agent
cannot act on — it recalls a conclusion with none of the reasoning that makes it
applicable to a new situation.

## Why it's currently terse — this is DESIGNED, not broken

`src/distill/prompts/extract.ts:127` — the prompt's own few-shot example is
literally the SQLite/Postgres case, and it teaches the model to emit exactly the
one-line shape above. The v2 prompt (`extract.ts:162`) lists **"explicit
atomicity"** as a design goal.

So the extractor is not failing. **It is doing what it was told.** The lever is
the prompt's few-shot examples and its atomicity instruction — not the model
(`qwen2.5:7b` is capable of richer output), and not a cascade.

## THE BLOCKING QUESTION — test before designing

`CLAUDE.md` currently mandates: *"Write memories SHORT — one fact per memory… a
single embedding over ~2,000 characters is diluted and the vector half of
retrieval cannot find it — verified 2026-07-12: a long lesson was retrievable
**only by literal-keyword FTS**, while the plain-English question it literally
answered returned nothing."*

**Read that symptom again: plain-English question fails, literal keywords work.**
That is precisely the asymmetric-retrieval failure diagnosed on 2026-07-13 — the
missing query-side embedding prefix (`src/search/search.ts:349`, fixed in
RECALL-S1, worth +17.5 MRR).

**Hypothesis: the "keep memories short" rule is a workaround for a two-line bug,
not a property of embeddings.** If true, the rule that forces trivia should be
DELETED, not designed around — and the operator can have the memories they
actually want at no retrieval cost.

**AC-0 (must run first):** after RECALL-S1 lands, take a long, rich memory in the
store, ask the plain-English question it answers, and measure whether it now
ranks. Report the number.
- **If it retrieves** → the short-memory rule is obsolete. Delete it from CLAUDE.md
  and proceed with a straightforwardly richer extraction prompt.
- **If it still doesn't** → embedding dilution is real and independent. Then the
  design is the standard one: **embed a distilled summary, store the full
  narrative** — retrieval matches on the gist, the agent reads the whole thing.
  Do NOT compromise back to trivia.

Everything below assumes AC-0 has been run. **Do not skip it.** Designing a
richer-memory pipeline on top of an untested assumption about embeddings is how
this codebase has already shipped five silent-data-loss bugs this week.

## Scope

- **Rewrite the extraction prompt's few-shot examples** to demonstrate the desired
  shape: claim + rationale + tradeoff + provenance, in prose a human would read.
  The examples ARE the spec — the model copies them.
- **Revisit the "atomicity" instruction.** It was a deliberate choice; understand
  why before overturning it. (Likely rationale: atomic facts are easier to
  supersede/invalidate individually, which the bitemporal model cares about. A
  richer memory is harder to partially invalidate — **this is a real tension and
  must be resolved, not ignored.**)
- **Embedding strategy**, per AC-0's outcome.
- **Length caps.** Check what limits exist end-to-end (schema, gate, embed input)
  and raise them deliberately.

## COLLISIONS — read before touching anything

1. **The durability gate (RECALL-S2)** rejects `bare_todo` at **≤8 words**. Richer
   memories are longer, so they sail past it — good. But if the gate is later tuned
   on length, it will fight this FEAT. Coordinate.
2. **The conversational-extraction-profile plan**
   (`.claude/artifacts/loop/plans/20260713-conversational-extraction-profile-plan.md`,
   another session) is ALSO rewriting `extract.ts`, to make extraction more liberal
   for conversational content. **Same file, related goal.** These two should almost
   certainly be one piece of work, not two builders racing on one prompt file.
   **Sequence or merge them — do not land independently.**
3. **`/remember` (MCP) bypasses distillation entirely** — a long blob goes in
   undistilled as one lump. If AC-0 shows dilution is real, that path needs the
   summary-embedding treatment too, or hand-written long memories stay unfindable.

## Acceptance criteria

- **AC-0** — (above) The long-memory retrieval question is answered with a measured
  number before any prompt work begins.
- **AC-1** — Extraction produces memories carrying **rationale and consequence**, not
  just a conclusion. Judged against a held-out set of real sessions, by a human or a
  judge — not by length alone (a long trivia fragment is still trivia).
- **AC-2** — Recall quality does **not regress**: plain-English MRR on
  `scripts/eval/recall-quality/run.mjs` stays at or above the post-S1 baseline.
  **This is the guard that stops richer memories from becoming unfindable ones.**
- **AC-3** — The supersession/invalidation story for richer memories is explicit: if a
  memory carries three claims and one becomes false, what happens? (Answer it; do not
  discover it in production.)
- **AC-4** — If the short-memory rule is obsolete, `CLAUDE.md` is updated to say so.
  If it is not, the summary-embedding design is implemented rather than reverting to
  trivia.

## Why this matters commercially

astramem's pitch is memory that makes agents better. A store of disconnected facts
("Use SQLite") gives an agent a conclusion with no way to judge whether it applies to
the situation in front of it. A store of *reasoned* memories ("SQLite because
single-user and local-first; tradeoff is no concurrent writers") lets an agent
generalize.

That difference is the product.
