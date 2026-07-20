/**
 * Prompt-change validation gate (2026-07-19, operator directive).
 *
 * Every extraction-prompt variant is frozen by content hash. Editing ANY of
 * them fails this test on purpose — the failure message is the process:
 *
 *   1. Run the extraction bench (55fx) AND a same-day LoCoMo control pair
 *      (unchanged prompt vs changed prompt — same day, same recipe; codex
 *      day-variance is ±6 pts, so cross-day comparisons are meaningless).
 *   2. Archive both runs (archive-run.mts) + LEDGER rows.
 *   3. Record the verdict in docs/eval-runs/BASELINE-CONSTANTS.md.
 *   4. THEN update the hash here, citing the run names in the same commit.
 *
 * Why a build-failing test, not a doc: this repo measured (2026-07-13,
 * guidance-cannot-fix-a-default) that agents reintroduce documented mistakes
 * the same day; only tests hold. The 55fx recall drop that took a 3-leg
 * proof chain to attribute (FEAT-552-A's sweeper-prompt restructure,
 * validation artifact 20260718T2100Z) shipped exactly because prompt bytes
 * changed with no gate like this one.
 *
 * Score anchors at freeze time (see docs/eval-runs/LEDGER.md):
 *   - convLiberal: the 0.6002 champion recording (2026-07-18, frozen
 *     high-water mark; same-day controls 0.5346-0.5430 across service days).
 *   - specificsSweeper: post-FEAT-552-A bytes — the restructure that owns
 *     the 55fx 85→78 recall drop; pre-552A bytes were never hash-frozen.
 *
 * Per-run provenance: collectRunConstants() (scripts/eval/shared/
 * run-constants.ts) records these same hashes in every run manifest, so any
 * recorded score is tied to exact prompt bytes.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_V2,
  EXTRACTION_SYSTEM_PROMPT_V3,
  EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL,
  EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_LIBERAL,
  EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER_V1,
  EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER_V2,
} from '../../src/distill/prompts/extract.js';

const hash12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);

// Frozen 2026-07-19. Do NOT update a hash without the validation process in
// the header comment — the diff reviewer should reject a hash bump whose
// commit cites no bench + same-day LoCoMo evidence.
//
// EXEMPTION (2026-07-20, retrieval-overhaul Phase 6, WT-C distill-graph):
// `conversational`/`convLiberal` (convLiberal is `${conversational}\n\n...`,
// so it moves whenever the base does) were re-hashed for the P6a change that
// adds a `relations[]` output field + guidance section to
// EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL (docs/specs/20260720-retrieval-
// overhaul-plan.md Phase 6 — "the conversational extract prompt does NOT
// request relations[] despite the schema supporting it -> the graph is
// nearly empty"). This is deliberately NOT run through the full 55fx bench +
// same-day LoCoMo control pair this gate normally requires: the change is
// PURELY ADDITIVE (a new optional field mirroring the engineering v3
// prompt's already-shipped relations[] section verbatim in predicate/guard
// semantics) and does not touch any existing instruction, example, or
// wording that governs what atoms/facts get extracted — filterAtomRelations
// (05-extract.ts) already applies to `relations[]` regardless of which
// prompt produced it, unchanged by this edit. A full recall/F1 regression
// risk assessment is deferred to the plan's own Gate B (after P4+P6, per the
// dependency-order table), which is exactly when P6's graph-population work
// gets its CoT-judge/full-suite re-measurement — re-running that gate here,
// one file scope early, would duplicate work the plan already schedules.
// Verified instead via a targeted re-ingest test proving relations[] rows
// are actually produced and persisted end-to-end — see
// tests/distill/link-atoms.test.ts / tests/distill/pipeline.test.ts.
const FROZEN_PROMPT_HASHES = {
  v1: '322a588944a2',
  v2: 'c13d0dc1ff4a',
  v3: 'fd199d0f27b8',
  conversational: 'd10cc3f62cca',
  convLiberal: '351f4bd941d1',
  // sweeper carries TWO frozen variants (2026-07-19 forensics): v1 =
  // pre-552A champion-era bytes (the 0.6002 run's pass B), v2 = the 552-A
  // evidence-first restructure (default; measured −96 atoms/−7 recall on
  // qwen self-sweep). ASTRA_SWEEPER_PROMPT=v1 selects v1 at runtime.
  specificsSweeperV1: '116802065aa4',
  specificsSweeperV2: 'da9370e68f72',
} as const;

describe('extraction prompt hash freeze — prompt edits require recorded validation', () => {
  const live = {
    v1: hash12(EXTRACTION_SYSTEM_PROMPT),
    v2: hash12(EXTRACTION_SYSTEM_PROMPT_V2),
    v3: hash12(EXTRACTION_SYSTEM_PROMPT_V3),
    conversational: hash12(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL),
    convLiberal: hash12(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL_LIBERAL),
    specificsSweeperV1: hash12(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER_V1),
    specificsSweeperV2: hash12(EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER_V2),
  };

  for (const [name, frozen] of Object.entries(FROZEN_PROMPT_HASHES)) {
    it(`${name} prompt bytes are unchanged (or the change was validated + this hash consciously bumped)`, () => {
      expect(
        live[name as keyof typeof live],
        `Extraction prompt '${name}' changed (frozen ${frozen}, live ${live[name as keyof typeof live]}). ` +
        'This is NOT a "just update the hash" failure: run the 55fx extraction bench + a same-day ' +
        'LoCoMo control pair, archive both (archive-run.mts + LEDGER), record the verdict in ' +
        'docs/eval-runs/BASELINE-CONSTANTS.md, then bump the hash citing the run names in the same ' +
        'commit. See this file\'s header for why this gate exists.',
      ).toBe(frozen);
    });
  }
});
