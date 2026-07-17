---
id: FEAT-479
status: done
priority: P1
category: feature
target_release: null
created: 2026-07-13
updated: 2026-07-13
depends_on: [RECALL-S1]
slices: [SLICE-431, SLICE-432, SLICE-433, SLICE-434, SLICE-435, SLICE-436]
derived_from: operator request 2026-07-13 + recall-quality investigation
cross_product: [astramem-local, astramem]
autonomous_safe: false
triage_notes: "compositePriority derivation via the exact formula in pm-scorer.mts (read this session): P0 requires impact>=0.8 -- fails (0.70). P1 requires (impact>=0.7 AND alignment>=0.6) -- MATCHES (0.70>=0.7, 0.82>=0.6) -- P1. (The alternate P1 branch, alignment>=0.8 AND effort<=0.4, would also fail on effort alone, but the first branch already fires.) autonomousSafe computed via computeAutonomousSafe: technical_risk 0.65 IS > 0.6 -> forces false; effort_estimate 0.72 IS ALSO > 0.6 -> independently forces false; dependency_depth 0.20 is not > 0.6 (passes on its own); hasAcceptanceCriteria is now true (ACs drafted this pass) but is irrelevant once either of the first two thresholds trips. technical_risk banded at 0.65 (low-mid in the 0.6-0.8 band: cross-module reach across distill/prompt/schema/provider/proof-harness/docs, AND a config/schema surface change (AtomSchema cap, new config key), but no destructive migration, no public wire-contract break, and every sub-piece is independently git-revertible) -- does not reach 0.8+ since nothing here is a cross-plugin or cross-repo wire break (the relations[] field is additive zod, matching FEAT-481's own additive-schema convention). dependency_depth banded low (0.20) because the two things that would have driven it high -- ownership ambiguity and an unresolved AC-0 gate -- are BOTH now resolved: DEC-015 names FEAT-479 as sole owner (no more three-going-on-four concurrent claims), and AC-0 is answered favorably by measured evidence (master-plan §2, RECALL-S1 merged) rather than still gating design. Residual 0.20 (not 0.0) reflects the parallel adversarial review still nominally in flight and the operator-confirmation-pending item on conversational redaction posture (architect-review Q4) -- both named as risks, neither a hard blocker per the operator's own order to start now. Weighted composite score: 0.70*0.35 + 0.82*0.30 + (1-0.72)*0.20 + (1-0.65)*0.10 + (1-0.20)*0.05 = 0.245 + 0.246 + 0.056 + 0.035 + 0.040 = 0.622. FEAT-168 decomposition gate: effort_estimate 0.72 maps via pm-effort-mapper.mts's BANDS table (0.6 <= x < 0.85 -> 8 points) to effort_points=8, which is >=8 and mandatorily requires proposed_slices. Satisfied via 6 slices (10 points total, >=8) derived from the architect's own design-doc structure (§3.2-§3.4) plus the architect-reviewer's two HIGH/MEDIUM hardening findings promoted to their own slice: SLICE-1 codex-subscription empty-SSE-text hardening (pre-req, independent, 1pt); SLICE-2 prompt architecture + config/profile surface (2pt); SLICE-3 engineering-rich prompt + type-conditioning + AtomSchema cap bump (2pt); SLICE-4 conversational profile + few-shots + redaction-posture disclosure (2pt); SLICE-5 relations[] additive output field for FEAT-481 (1pt, FEAT-481's SLICE-428 rides this); SLICE-6 hardened proof phase + budget-cap doctor WARN (2pt). P1 priority with ACs drafted this pass per FEAT-277 (--deep semantics) as instructed."
pm_customer_impact: 0.7
pm_effort_estimate: 0.72
pm_strategic_alignment: 0.82
pm_technical_risk: 0.65
pm_dependency_depth: 0.2
pm_composite_priority: P1
pm_autonomous_safe: false
pm_reviewed: 2026-07-13
proposed_slices:
  - id_suffix: -SLICE-1
    title: "codex-subscription empty-SSE-text hardening (pre-req, independent)"
    points: 1
    estimated_tokens: 60000
  - id_suffix: -SLICE-2
    title: Prompt architecture + extractProfile config/envelope surface
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-3
    title: Engineering-rich prompt + type-conditioned richness + AtomSchema cap bump
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-4
    title: Conversational profile + few-shots + redaction-posture disclosure
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-5
    title: "Relations[] additive output field (FEAT-481 SLICE-428 rides this)"
    points: 1
    estimated_tokens: 60000
  - id_suffix: -SLICE-6
    title: "Hardened proof phase (blinded, ranges, cost/latency) + budget-cap doctor WARN"
    points: 2
    estimated_tokens: 100000
started_at: 2026-07-13
slices_complete: [SLICE-431, SLICE-432, SLICE-433, SLICE-434, SLICE-435]
force_closed: true
slices_remaining_at_close: [SLICE-432, SLICE-433, SLICE-434, SLICE-435, SLICE-436]
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

## Acceptance criteria (Given / When / Then)

Scope expanded per DEC-015 (`.claude/artifacts/loop/decisions/DEC-015.md`,
active): FEAT-479 is the sole canonical owner of `src/distill/prompts/extract.ts`
and folds in master-plan W5, the conversational-profile plan's S2, the
type-conditioned richness rule, and FEAT-481's relation-triples output field.
Derived from `docs/superpowers/specs/2026-07-13-memory-quality-design.md` and
its architect-review (`.claude/artifacts/crew/reviews/20260713T100000Z-architect-review-memory-quality-design.md`).

- AC-0: Given RECALL-S1 (query-side embedding prefix) is merged, When a 700-character rich memory is queried with the plain-English question it answers, Then it retrieves at rank #1 — this is RESOLVED BY EVIDENCE (master-plan handoff §2, measured 2026-07-13), not an open gate; the summary-embedding fallback branch is not needed and is not part of this FEAT's scope.
- AC-1: Given codex-subscription's `parseSseResponse` cannot recognize the SSE event shape, When `chat()` is called with `opts.json === true`, Then it throws `TransientError` instead of returning a successful `ChatResult` with empty text — closing the same failure class as the recorded qwen3:8b empty-extract poisoning bug, before codex-subscription becomes the operator's default extraction provider.
- AC-2: Given `config.yaml` sets `distill.extractProfile` to `engineering` or `conversational` (default `engineering`), When a distill run resolves its prompt, Then resolution happens per-run (not at module load), and output is byte-identical to today's behavior when `extractProfile` is `engineering` with no override set.
- AC-3: Given the canonical ingest envelope carries an optional `extract_profile` field, When a per-ingest request supplies it, Then it overrides the config-level default for that request only, added as an additive zod field with no wire-schema break.
- AC-4: Given `ASTRA_EXTRACT_PROMPT` is set, When a distill run resolves its prompt, Then the env var still wins as an override over both the config default and any per-ingest `extract_profile` field, preserving today's override behavior.
- AC-5: Given the rewritten engineering-profile prompt, When a `lesson` or `decision` atom is extracted, Then its text carries claim + rationale + tradeoff/consequence + provenance in the 300-800 character range, judged against a held-out set of real sessions by a human or judge — not by length alone, since a long trivia fragment is still trivia.
- AC-6: Given the same rewritten prompt, When a `fact` or `command` atom is extracted, Then it stays atomic and single-valued, because the prompt states the type-conditioned richness rule as an explicit instruction line (not only implied via few-shot example shape).
- AC-7: Given `AtomSchema.text` currently caps at `max(500)` (`src/distill/prompts/extract.ts:39`), When this slice lands, Then the cap is bumped to `max(1000)` (TEXT column, no migration) so the 300-800-char target is never silently truncated or schema-rejected.
- AC-8: Given a memory carries multiple claims and one becomes false, When the supersession question is resolved (design D4, option (a)), Then rich multi-claim shape is permitted only for `lesson`/`decision` types (rarely superseded) while `fact`/`command` stay atomic (frequently superseded), stated explicitly in the prompt and docs, not left implicit.
- AC-9: Given `distill.extractProfile` is `conversational`, When extraction runs on conversational content, Then output follows mem0-pattern liberal extraction (15-80 word self-contained sentences, pronouns resolved, proper nouns preserved, relative dates grounded to an explicit observation date) plus Graphiti-pattern possessor qualification and a banned-abstractions negative list.
- AC-10: Given the conversational profile's premise is extracting personal-but-not-secret content, When this slice ships, Then the operator-confirmed posture ships as secret-only redaction (`src/redact/index.ts`, unchanged) with an explicit wizard/docs disclosure line stating non-secret personal content is not redacted — not a silent inheritance of the engineering profile's narrower threat model.
- AC-11: Given FEAT-481's entity-relations design, When the shared `AtomSchema` is extended, Then an optional `relations[]` field is added nested inside each atom, each entry validated against a closed lowercase snake_case predicate enum (10 values + `other`) with a same-atom no-hallucination guard (subject/object must appear in that atom's own `entities[]` list) — matching FEAT-481 SLICE-428's AC-6/AC-7 exactly, since this is the shared-schema half of that dependent slice.
- AC-12: Given the proof phase runs, When it executes, Then it covers >=2 runs per config across 4 configs (qwen/old-prompt baseline, qwen/new-prompt, codex-mini/new-prompt, codex-5.5/new-prompt), reports a range per config (not a single point estimate), and the eyeball judging pass is blinded (config labels hidden until after judging).
- AC-13: Given the proof-phase report, When it is published, Then it includes a cost and latency column per config alongside the quality/MRR numbers.
- AC-14: Given the new engineering-rich prompt lands, When `scripts/eval/recall-quality/run.mjs` runs, Then plain-English MRR stays at or above the post-RECALL-S1 baseline — the guard that stops richer memories from becoming unfindable ones.
- AC-15: Given codex-subscription always reports `usage.usd: 0` (subscription quota has no per-token price), When a daily LLM budget cap is configured, Then doctor emits a WARN row stating the budget cap does not apply under this provider.
- AC-16: Given AC-0's measured resolution, When this FEAT lands, Then `CLAUDE.md`'s "write memories SHORT" rule is corrected to reflect it (long memories retrieve fine up to ~700 chars tested; the ~1,500-2,000-char caution is labeled untested, not asserted as fact) — proposed as wording for operator sign-off, not silently rewritten.

## Why this matters commercially

astramem's pitch is memory that makes agents better. A store of disconnected facts
("Use SQLite") gives an agent a conclusion with no way to judge whether it applies to
the situation in front of it. A store of *reasoned* memories ("SQLite because
single-user and local-first; tradeoff is no concurrent writers") lets an agent
generalize.

That difference is the product.

## Proposed slices (PM decomposition)

- SLICE-1: codex-subscription empty-SSE-text hardening (pre-req, independent) (1 pts)
- SLICE-2: Prompt architecture + extractProfile config/envelope surface (2 pts)
- SLICE-3: Engineering-rich prompt + type-conditioned richness + AtomSchema cap bump (2 pts)
- SLICE-4: Conversational profile + few-shots + redaction-posture disclosure (2 pts)
- SLICE-5: Relations[] additive output field (FEAT-481 SLICE-428 rides this) (1 pts)
- SLICE-6: Hardened proof phase (blinded, ranges, cost/latency) + budget-cap doctor WARN (2 pts)

> **Closed 2026-07-17 — reconciled shipped-but-open.** all slices merged incl ede1a21a (#175); force_closed stale
