# Handoff — LoCoMo 0.4840 (compaction OFF, confounded) + the split-test that must run next

**Created:** 2026-07-14
**From:** lead (this session)
**To:** next eval session
**Objective:** salvage the measured 0.4840 nocompact run into the repo before its
eval dir evaporates, and hand off the single-variable split that decides what ships.

---

## Objective

The 0045Z handoff (`20260714T0045Z-handoff-score-track-and-four-reversals.md`)
*projected* ~0.47–0.49 from the night's merges but marked it **UNMEASURED**. It has
since been measured: **0.4840 overall F1 (n=1986)**, up +2.3 from the 0.4610 baseline.
Full write-up: `docs/research/20260714-locomo-nocompact-0484-result.md` (this PR).

## Owner

Next eval session. Read the research doc first, then the 0045Z handoff, then
`docs/research/20260713-locomo-full-suite-result.md` for methodology.

## Allowed scope

- Run the three single-variable A/B evals in §"Required follow-up" of the research doc.
- Commit any completed eval metrics.json into `docs/research/` before `git checkout`
  can lose them.

## Forbidden scope

- **Do NOT touch `scripts/eval/locomo/answer.mts`** prompt/model/k — frozen answerer.
- **Do NOT ship "compaction OFF" as a conclusion** — the 0.4840 run is confounded
  (nocompact + #277 date-retry + zero-atom-timeout fix, all on one branch).
- **Do NOT run two model-loading evals in parallel** — one 8GB GPU slot, serial always.

## Deliverable

The measured result is preserved (research doc + this handoff, this PR). Next
deliverable: the split-test verdict — which of {#277 date-retry, nocompact} earned
the points, and whether the multi-hop/open-domain regressions survive isolation.

## Key numbers

```
                 baseline 0.4610   →   nocompact 0.4840     Δ
overall F1        0.4610              0.4840              +2.3
category-avg      0.4007              0.4137              +1.3
2 temporal        0.1318              0.2300              +9.8   ← the story (likely #277)
1 multi-hop       0.3145              0.2809              −3.4   ← cost (likely nocompact)
3 open-domain     0.2318              0.1991              −3.3   ← cost (likely nocompact)
4 single-hop      0.4332              0.4640              +3.1
5 adversarial     0.8924              0.8946              +0.2
```

## Changed files / evidence

- `docs/research/20260714-locomo-nocompact-0484-result.md` (new — this PR)
- Source metrics (uncommitted, sibling worktree, **fragile**):
  `../astramemory-local-worktrees/compact-profile/.eval-data/locomo/runs/full-codex-nocompact/metrics.json`
- Run branch: `fix/compaction-was-shredding-conversations` @ `08994b5`

## Confidence

- **High** that 0.4840 is real and infrastructurally clean (1986 hypotheses, 0 skipped).
- **Low** on attribution — the run bundles ≥3 changes. The category signs are a
  hypothesis, not a measurement.

## Risks / open questions

1. **The eval dir is uncommitted in a sibling worktree.** One `git checkout` on that
   branch and the 0.4840 evidence is gone. This PR captures the numbers; the raw dir
   is not preserved.
2. **A later run (started 02:49) overwrote `run-status.json`** in the same dir — do
   not mistake its "ingesting" status for the completed 0.4840 run.
3. **Bitemporal `valid_to`/`as_of` is NOT a LoCoMo lever** (harness never sets
   `as_of`; temporal answered from text). Confirmed against the issue-#205 handoff and
   CHANGELOG #228. Do not chase temporal through the schema — chase it through
   extraction-into-text (#277 is the proof).

## Suggested next handoff

Split-test result: #277-only vs nocompact-only vs baseline. If #277-only recovers
temporal without the regressions, ship #277 + keep compaction + pivot to fixing the
stage-4 compressor (`wt-fix-284`).
