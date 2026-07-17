---
id: FEAT-533
status: done
priority: null
category: quality
target_release: null
created: 2026-07-16
updated: 2026-07-16 (architect-amended: batch granularity)
depends_on: []
slices: []
derived_from: null
github_issue: null
github_milestone: null
github_url: null
---
# FEAT-533: LLM atom-triage mode for the durability gate (local-model junk judge, dry-run first)

## Description

Add an LLM-assisted triage mode to the existing durability gate
(`src/distill/durability-gate.ts`, FEAT-441) — a post-extraction,
pre-persist classification call that batches a chunk's atoms into ONE
local-model request and labels each: `keep | junk | meta-echo |
capability-disclaimer | ephemeral | rephrase-of-existing`.

## Why now (evidence, 2026-07-16)

- Extraction-bench (43 fixtures, judged): qwen3:8b wins F1 76% vs prod
  codex's 64%, but at 28% junk rate and 6.5 atoms/fixture vs codex's
  surgical 2.5. High-recall local extraction is the right trade ONLY if
  junk is filtered before it pollutes fusion ranking.
- Issue #371 documents live junk classes the regex taxonomy cannot catch:
  recall-query echo atoms, first-person capability disclaimers stored as
  `lesson` (importance 0.8), trivial shell-command supersession chains,
  near-identical rephrase supersessions inflating the corrections count
  (1176) that #352's contradiction analysis then mis-reads.
- Fusion ranking is BM25+cosine dominated (0.364+0.364) with usefulness
  mostly at the 0.5 default — text-similar junk competes head-on with
  real lessons at recall time.

## Requested capability

1. `distill.durabilityGate` gains an LLM triage tier ON TOP of the
   existing regex taxonomy (regex runs first, free; LLM sees survivors).
   Config: `distill.atomTriage: { mode: 'off' | 'dry-run' | 'enabled',
   provider?, model? }` following the contradictionDetection shape (#373)
   — provider/model default to llm.extraction, overridable to a local
   model so triage is free on metered installs.
2. Batched calls over the flat post-reduce atom stream — a fixed
   atom-count batch per LLM call across the whole JOB (architect
   correction 2026-07-16: "per chunk" is unimplementable at the insertion
   point — stage-6 reduce() merges/dedupes atoms across chunks before
   embedAndIndex runs, and NormalizedMemory carries no chunkIndex; batching
   the deduped stream is also strictly cheaper). JSON-schema structured
   output per #369; never a call per atom; never re-plumb chunk identity
   through 06-reduce/07-normalize.
3. **`dry-run` ships first and is the default-on ramp**: verdicts are
   logged to a `triage_guard_drops`-style table (mirror
   `evidence_guard_drops`, migration 030 conventions) WITHOUT dropping
   anything. `enabled` (actually dropping) requires a manually reviewed
   dry-run sample — dropping real atoms silently is the worst failure
   class in a memory system (see valid_to incident, 2026-07-13).
4. Doctor rate-canary: triage drop-rate over a rolling window, alarm on
   BOTH extremes — ~0% forever in enabled mode (built-wired-never-invoked
   class) and >50% (judge gone rogue / model swap regression).
5. Caps mirroring the FEAT-482 lessons: maxPerRun call count +
   wall-clock cap; cap-reached falls through to persist-unfiltered (never
   drop-by-timeout).

## Acceptance criteria (Given-When-Then sketch)

- Given mode=dry-run and a chunk containing a #371-class query-echo atom,
  when distill persists the chunk, then the atom IS persisted and a
  triage verdict row (`junk`, atom id, model, confidence) is recorded.
- Given mode=enabled and the same input, when distill persists, then the
  atom is NOT persisted, the drop is counted by reason, and the sibling
  keep-verdict atoms persist unchanged.
- Given the triage provider is unreachable, when a chunk distills, then
  all atoms persist (fail-open) and a WARN with the provider error is
  logged (ADR-015 — loud, never silent-drop).
- Given 43-fixture extraction-bench with qwen3:8b + triage dry-run, when
  verdicts are compared against the Azure judge's junk labels, then
  agreement is reported in the FEAT's validation artifact (quality gate
  for ever flipping to enabled).

## Out of scope

- Rephrase-supersession correction-count fix (#371 ask 4) — separate
  concern at the supersession site, not the persist gate.
- Any change to `/remember` (bypasses the gate by construction).

> **Closed 2026-07-17 — reconciled shipped-but-open.** shipped 8bcd1fc4 (#391)
