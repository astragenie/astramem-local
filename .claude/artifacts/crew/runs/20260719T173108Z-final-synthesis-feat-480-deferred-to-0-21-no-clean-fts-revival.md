---
status: completed
---
# Final Synthesis: FEAT-480 deferred to 0.21 — no clean FTS revival

- Created: 2026-07-19T17:31:08.815Z
- Owner: dispatcher-session
- Outcome: completed
- Summary: FEAT-480 (revive dead FTS/BM25 leg) — DEFERRED to 0.21 after adversarial measurement proved naive revival has no clean fix.

MECHANISM (confirmed, search.ts escapeFtsQuery): tokens were quoted-phrase implicit-ANDed -> multi-word NL queries required all tokens present -> FTS leg returned 0 candidates (alpha=0.4 fusion weight dead). Real; longstanding since ship; NOT a regression.

THREE BUILDS on branch feat/480-fts-or-join (PR #441, unmerged):
- v1 pure-OR (8364ff2): OR-join stopword-stripped, cap 12, AND fallback for all-stopword.
- v2 AND-first/OR-fallback (58c0dc9): two-pass gatherCandidates, OR only when AND=0 rows.
- v3 instrumentation only (b4f0d01): FtsGatherProbe (andRows/orFired/orRows) + signal-token coverage histogram, env-gated ASTRA_FTS_INSTRUMENT=1, off by default, 910 tests green.

REAL-STORE A/B (54k-memory copy, workers off, zero codex calls; scripts/eval/recall-quality/run.mjs):
- Baseline main: plain-MRR 0.548, literal-MRR 0.950, junk 10%.
- v1 AND v2 both: plain-MRR 0.650 (+18.6%), literal-MRR 0.800 (-15.8%), junk 16% (+6pp). v2 byte-identical to v1.

ROOT CAUSE (branch+coverage probe, scripts/eval/recall-quality/fts-branch-probe.mjs): AND fired only 3/20 queries; OR fired 17/20 (all 10 plain + 7/10 literal). Baseline literal 0.950 comes from the VECTOR leg, not FTS. Reviving FTS via OR injects weak keyword candidates that dilute the vector leg's good literal rankings and add junk. Coverage histogram: coverage>=2 gate prunes only 2/79 hits (3%) = no-op; junk lives in the cov 2-3 band (57%); pruning needs cov>=3/>=4 which also cuts legitimate 2-token matches -> real recall/junk tradeoff, not a clean win.

CONCLUSION: inherent plain(+0.10)/literal(-0.15)/junk(+6pp) tradeoff. No clean lever. This is a retrieval-research problem, not a slice. Deferred to 0.21 with all evidence preserved (branch, PR #441, 2 A/B tables, probe, instrumentation). Not release-blocking for 0.20 (FTS-dead is longstanding). Fusion-weight retune stays off-limits per FEAT. Junk-filtering in ranking is a separate FEAT.

NEXT for 0.21: model coverage>=3/>=4 threshold tradeoff with the probe+run.mjs pairing; needs better ground truth than the 10-case paraphrase-literal harness (too weak to distinguish AND-works from AND-never-engages).
- Changed Files / Evidence: -
- Run / Test Steps: -
- External Deltas: none
- Risks: -
- Next Step: -

