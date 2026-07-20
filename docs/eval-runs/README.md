# `docs/eval-runs/` — canonical LoCoMo / eval run tracker

**Single source of truth for every scored eval run.** One archived folder per run
(`<date>-<slug>/` with `metrics.json` + `run-manifest.json` + `run-params.json`),
one row per run in [`LEDGER.md`](LEDGER.md), and the current tuned baseline in
[`BASELINE-CONSTANTS.md`](BASELINE-CONSTANTS.md). If a number isn't backed by a
folder here, treat it as unverified.

## Current state (read the caveats — the headline number depends on the scale)

| Scale | Metric | Best | Stable / service-day | Source |
|---|---|---|---|---|
| **conv-1, n=199** (10% suite, one conversation) | overall F1 | **0.6002** (champion, 2026-07-18 — frozen high-water mark, run dir deleted, **not reproducible same-recipe**) | **0.5430** (2026-07-19 `chunkab-800tok` control) | LEDGER + BASELINE-CONSTANTS |
| **full suite, n=1986** | overall F1 | **0.4840** (2026-07-14 compaction-off) | 0.4610 baseline | `docs/research/20260714-locomo-nocompact-0484-result.md` |

**Do not compare across scales.** conv-1 (n=199) is a single-conversation 10% sample;
full-suite (n=1986) is the real number. The `0.60` figure is a *good-day conv-1*
result, not a full-suite result.

### Why 0.5430 (service-day) ≠ 0.6002 (champion): proven codex day-variance
The **exact** champion recipe replicated 2026-07-18 (`replicate-champion-untuned`)
scored **0.5346 — −6.6 vs champion.** Codex service quality moves **±6 pts between
days** (per-call atom yield drifts 13 → ~10). The champion gap is **variance, not a
missing lever** — every config A/B run since has been REJECTED (see below).

## Realistic path toward 0.60+ (corrected against run history)
- **0.60 has been touched** (champion) but is **not stable** — it's a good-codex-day
  ceiling, not a floor. Stabilising it means variance reduction (multi-day medians,
  more robust extraction), not a new knob.
- **Config levers are exhausted** — chunk-size (800 beats 1600/3200/12800), sweeper-v1
  revert, temperature, maxTokens, compaction: all A/B-REJECTED or dead-on-codex.
- **The one genuinely-open ceiling lever** is temporal/extraction-into-text scoring
  (the `#262` ISO-date-scores-0.0 class + `#277` date-grounding) — historically the
  biggest single prize (~+5), and whether the codex champion prompt captured it is
  still not cleanly measured. See `docs/research/20260714-locomo-hypothesis-ledger.md`.
- **The answerer is frozen/untuned** — the last-mile lever, but overfit-risky.
- **0.70 is not realistic near-term**: the rank-ok retrieval ceiling is only +7.86,
  and many facts are unfixable (stored+retrieved+still-scored-wrong). 0.70 needs a
  ceiling-raise (answerer overhaul + scorer-format co-design), not knob-tuning.

## How to add a run (do this for EVERY scored run — no orphan numbers)
```bash
bun scripts/eval/locomo/archive-run.mts --run-dir <dir> --name <slug>
```
This copies `metrics.json` + `run-manifest.json` + `run-params.json` into a new
`docs/eval-runs/<date>-<slug>/` and is the only sanctioned way to publish a score.
Then append one row to [`LEDGER.md`](LEDGER.md).

## Non-negotiable measurement rules (earned the hard way — 9 of 12 hypotheses died to these)
1. **Same-day controls mandatory** — codex moves ±6 pts/day; a cross-day comparison is noise.
2. **n=199 is a 10% single-conversation sample** — a full-sample (n=1986) rerun is required before any number is trusted or published (see memory: README benchmark claims must stay qualified).
3. **Atoms/session is a co-headline metric**, not F1 alone — high abstention masquerades as a retrieval problem.
4. **Never A/B `temperature`/`maxTokens` on codex** — dead knobs (provider drops them; endpoint 400s).
5. **Measure the instrument before trusting it** — the retrieval diagnostic had a 42% false-negative rate (#267).
6. **Prefer the experiment to the theory** — record config from the run artifact, never from a hand-written spec line (that error mis-stated a run as local when it was cloud-extracted).

## Historical / pre-2026-07-18 analysis (context, not run-tracked here)
Older LoCoMo investigation lives under `docs/research/` and `docs/eval/`:
- `docs/research/20260714-locomo-hypothesis-ledger.md` — **read the REJECTED table before proposing anything** (chunk-size, reranking, raw-transcript, SQLite-swap, etc. all dead).
- `docs/research/20260714-locomo-nocompact-0484-result.md` — the 0.484 full-suite (n=1986) best.
- `docs/research/20260713-locomo-full-suite-result.md` + `-metrics.json` — the 0.461 baseline + per-category breakdown.
- `docs/research/20260713-locomo-cohort-scoreboard.md` — cohort/provider comparison ("local is not worse", not "local beats cloud").
- `docs/research/20260713-locomo-retrieval-diagnosis.md` — retrieval-gap analysis (instrument had 42% FN — treat with the caveat above).
- `docs/eval/locomo-methodology.md` — how the harness scores.
