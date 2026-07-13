---
type: validation
created: 2026-07-13T14:50:00Z
slice: SLICE-436
feature: FEAT-479
result: PASS
validator: lead (evidence from live 4-config run + reviewer independent verification)
---

# Validation — SLICE-436: hardened proof phase

## Behavior evidence

- **Live 4-config run completed** (40 fixture-runs, sequential, zero VRAM-eviction
  retries). Blinding verified STRUCTURAL, not cosmetic: the judge sees only
  {type,text}; config labels are scrambled in console output and raw results,
  revealed only in the report (reviewer read run.log to confirm).
- Ranges (≥2 runs/config), cost and latency reported per config — AC-12/AC-13 met.
- **AC-15**: checkBudgetCapCodexBlind ships + wired; reviewer independently confirmed
  it also fixes a pre-existing bug (doctorCommand never passed a real dailyBudgetUsd —
  checks.ts defaulted to 10 silently). 4 tests pass.
- **AC-14 MRR guard: FAIL as computed** (0.483 vs 0.637 baseline) — reported honestly,
  not laundered. Confounds documented and reviewer-verified (pipeline round-trip vs the
  baseline's hand-authored memories; substring-marker misses on paraphrase; 2/10 sessions
  not ready in window). Follow-up: rerun via the baseline's direct-remember methodology.
- **AC-16**: proposed CLAUDE.md wording lives in the report only; CLAUDE.md untouched
  (operator sign-off pending; builder could not locate the live file carrying the
  "write memories SHORT" rule — flagged).
- Suites: tsc clean; 248 files / 3007 pass / 6 skipped (reviewer reproduced exactly).

## The headline result (surfaced after review)

On **fx43** — the flagship rich-lesson fixture this FEAT exists to serve — **no config
captured the `lesson` gold atom**. Every config that extracted anything matched only the
shallow `decision` atom, and did so with the WRONG TYPE (codex-mini emitted a `todo`,
qwen+v3 a `command`); gpt-5.5 extracted 0/2 gold atoms in both runs. Two hypotheses are
stated without preference in the report: (1) the v3 prompt still does not reliably elicit
the rich lesson shape, or (2) the judge/matcher cannot recognize one when produced. This
run cannot distinguish them.

This contradicts the assumption FEAT-479 was built on (that the prompt rewrite would
deliver rich lessons) and is the most valuable output of the slice: it stops a
declare-victory-on-assumption close.

## Known limitation (added on review)

The harness persists NO raw pre-parse LLM text, so **silent schema-rejection cannot be
ruled out** — gpt-5.5 returned status:'ready' with 0 atoms on fx43 in both runs while
spending MORE output tokens (163, 150) than gpt-5.4-mini's SUCCESSFUL extraction on the
identical fixture (80, 81). The "gpt-5.5 is worse" conclusion is therefore UNPROVEN; it
may be a parse failure wearing a model-quality costume. Follow-up: dump raw LLM text.

Relation counts are frequency/well-formedness counts, NOT correctness — no fixture
carries relation ground truth. A model fabricating relations would score identically.

## Reviews

- review-436: NEEDS_FIX (doc-only) → all three edits applied and re-verified against raw
  data by the builder. Code, blinding, AC-15, MRR honesty all PASS.
  Artifact: .claude/artifacts/crew/reviews/20260713T144500Z-review-slice436-proof.md
