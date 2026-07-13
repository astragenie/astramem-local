---
id: SLICE-431
title: "codex-subscription empty-SSE-text hardening (pre-req, independent)"
status: completed
feature: FEAT-479
phase: null
priority: P1
target_release: null
requires_validation: true
risk: medium
created: 2026-07-13
updated: 2026-07-13
effort_points: 1
estimated_tokens: 60000
completed_at: 2026-07-13
---
# SLICE-431: codex-subscription empty-SSE-text hardening (pre-req, independent)

Implements FEAT-479. See [feature file](../../../backlog/in-progress/FEAT-479.md) for product context.

## Objective

**Memories should be self-contained explanations, not trivia.**

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

> WARNING: ACs copied from FEAT-479 and shared across 6 sibling slices — scope per-slice before close

- [ ] AC-0: Given RECALL-S1 (query-side embedding prefix) is merged, When a 700-character rich memory is queried with the plain-English question it answers, Then it retrieves at rank #1 — this is RESOLVED BY EVIDENCE (master-plan handoff §2, measured 2026-07-13), not an open gate; the summary-embedding fallback branch is not needed and is not part of this FEAT's scope.
- [ ] AC-1: Given codex-subscription's `parseSseResponse` cannot recognize the SSE event shape, When `chat()` is called with `opts.json === true`, Then it throws `TransientError` instead of returning a successful `ChatResult` with empty text — closing the same failure class as the recorded qwen3:8b empty-extract poisoning bug, before codex-subscription becomes the operator's default extraction provider.
- [ ] AC-2: Given `config.yaml` sets `distill.extractProfile` to `engineering` or `conversational` (default `engineering`), When a distill run resolves its prompt, Then resolution happens per-run (not at module load), and output is byte-identical to today's behavior when `extractProfile` is `engineering` with no override set.
- [ ] AC-3: Given the canonical ingest envelope carries an optional `extract_profile` field, When a per-ingest request supplies it, Then it overrides the config-level default for that request only, added as an additive zod field with no wire-schema break.
- [ ] AC-4: Given `ASTRA_EXTRACT_PROMPT` is set, When a distill run resolves its prompt, Then the env var still wins as an override over both the config default and any per-ingest `extract_profile` field, preserving today's override behavior.
- [ ] AC-5: Given the rewritten engineering-profile prompt, When a `lesson` or `decision` atom is extracted, Then its text carries claim + rationale + tradeoff/consequence + provenance in the 300-800 character range, judged against a held-out set of real sessions by a human or judge — not by length alone, since a long trivia fragment is still trivia.
- [ ] AC-6: Given the same rewritten prompt, When a `fact` or `command` atom is extracted, Then it stays atomic and single-valued, because the prompt states the type-conditioned richness rule as an explicit instruction line (not only implied via few-shot example shape).
- [ ] AC-7: Given `AtomSchema.text` currently caps at `max(500)` (`src/distill/prompts/extract.ts:39`), When this slice lands, Then the cap is bumped to `max(1000)` (TEXT column, no migration) so the 300-800-char target is never silently truncated or schema-rejected.
- [ ] AC-8: Given a memory carries multiple claims and one becomes false, When the supersession question is resolved (design D4, option (a)), Then rich multi-claim shape is permitted only for `lesson`/`decision` types (rarely superseded) while `fact`/`command` stay atomic (frequently superseded), stated explicitly in the prompt and docs, not left implicit.
- [ ] AC-9: Given `distill.extractProfile` is `conversational`, When extraction runs on conversational content, Then output follows mem0-pattern liberal extraction (15-80 word self-contained sentences, pronouns resolved, proper nouns preserved, relative dates grounded to an explicit observation date) plus Graphiti-pattern possessor qualification and a banned-abstractions negative list.
- [ ] AC-10: Given the conversational profile's premise is extracting personal-but-not-secret content, When this slice ships, Then the operator-confirmed posture ships as secret-only redaction (`src/redact/index.ts`, unchanged) with an explicit wizard/docs disclosure line stating non-secret personal content is not redacted — not a silent inheritance of the engineering profile's narrower threat model.
- [ ] AC-11: Given FEAT-481's entity-relations design, When the shared `AtomSchema` is extended, Then an optional `relations[]` field is added nested inside each atom, each entry validated against a closed lowercase snake_case predicate enum (10 values + `other`) with a same-atom no-hallucination guard (subject/object must appear in that atom's own `entities[]` list) — matching FEAT-481 SLICE-428's AC-6/AC-7 exactly, since this is the shared-schema half of that dependent slice.
- [ ] AC-12: Given the proof phase runs, When it executes, Then it covers >=2 runs per config across 4 configs (qwen/old-prompt baseline, qwen/new-prompt, codex-mini/new-prompt, codex-5.5/new-prompt), reports a range per config (not a single point estimate), and the eyeball judging pass is blinded (config labels hidden until after judging).
- [ ] AC-13: Given the proof-phase report, When it is published, Then it includes a cost and latency column per config alongside the quality/MRR numbers.
- [ ] AC-14: Given the new engineering-rich prompt lands, When `scripts/eval/recall-quality/run.mjs` runs, Then plain-English MRR stays at or above the post-RECALL-S1 baseline — the guard that stops richer memories from becoming unfindable ones.
- [ ] AC-15: Given codex-subscription always reports `usage.usd: 0` (subscription quota has no per-token price), When a daily LLM budget cap is configured, Then doctor emits a WARN row stating the budget cap does not apply under this provider.
- [ ] AC-16: Given AC-0's measured resolution, When this FEAT lands, Then `CLAUDE.md`'s "write memories SHORT" rule is corrected to reflect it (long memories retrieve fine up to ~700 chars tested; the ~1,500-2,000-char caution is labeled untested, not asserted as fact) — proposed as wording for operator sign-off, not silently rewritten.

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-479 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
