# LoCoMo full-suite result — compaction OFF → 0.4840 (2026-07-14)

**Status:** measured, single run, uncommitted eval dir salvaged into this doc.
**Supersedes as the current best number:** the 0.4610 baseline
(`docs/research/20260713-locomo-full-suite-result.md`).
**Does NOT supersede** that doc's methodology or its category analysis — read it first.

---

## Headline

Turning stage-4 compaction OFF (plus the fixes bundled on the same branch) moved the
full-suite LoCoMo F1 from **0.4610 → 0.4840** (n=1986, +2.3 points). The honest
category-averaged number moved **0.4007 → 0.4137** (+1.3).

**This is not a clean win.** Two categories regressed. See §3.

---

## The run

| field | value |
|---|---|
| run dir | `full-codex-nocompact` (compact-profile worktree, `.eval-data/locomo/runs/`) |
| branch | `fix/compaction-was-shredding-conversations` @ `08994b5` |
| extraction | codex-subscription `gpt-5.4-mini` |
| compaction | **DISABLED** (stage 4 off) |
| embedder | `mxbai-embed-large` (1024-dim) |
| answerer | Azure `gpt-5-mini`, k=10 — **frozen, unmodified** |
| dataset | `locomo10.json`, hash `79fa87e9…`, n=1986, seed 42, 1 shard |
| hypotheses | 1986 written, **0 skipped** (no distill timeout), avg hit_count 10.0 |
| completed | 2026-07-13 23:09 local |

**Provenance caveat:** `run-status.json` in the dir shows a *later* run
(started 02:49, "ingesting") that overwrote the status file. The 0.4840
`metrics.json` + `answer.log` + `hypotheses.jsonl` (23:09, 1986 rows, 0 skipped)
are the completed prior run — that is the number reported here.

---

## Scores

```
                 baseline 0.4610   →   nocompact 0.4840     Δ
overall F1        0.4610              0.4840              +2.3
category-avg      0.4007              0.4137              +1.3
1 multi-hop       0.3145 (282)        0.2809 (282)        −3.4   ← regressed
2 temporal        0.1318 (321)        0.2300 (321)        +9.8   ← big win
3 open-domain     0.2318 (96)         0.1991 (96)         −3.3   ← regressed
4 single-hop      0.4332 (841)        0.4640 (841)        +3.1
5 adversarial     0.8924 (446)        0.8946 (446)        +0.2
```

---

## What the branch bundles — NOT a single variable

The +2.3 cannot be attributed to any one change. The branch carries at least three
score-relevant commits on top of `main`:

| commit | change |
|---|---|
| `6249c1c` | stage-4 compaction was shredding conversations with a coding-agent compressor → this run disables compaction entirely |
| `68b4711` (#277) | date-grounding **retry** — a second, narrow LLM call (NOT #257's regex) |
| `502e16e` | a 60s cloud timeout on local inference was silently producing ZERO atoms |

## Reading the categories

- **Temporal +9.8 is the story.** It was the worst category (0.13). The #277
  date-grounding retry is the most likely cause — it targets exactly the
  relative-date-into-text problem temporal questions are answered from. This is
  the first lever that has ever moved temporal (PR #189 text-surface grounding
  moved it ~0).
- **Multi-hop −3.4 and open-domain −3.3 are the cost.** These categories need
  synthesis across turns; disabling compaction plausibly removed the connective
  atoms they relied on. This points the finger at **nocompact**, not #277.
- **Net:** the two changes likely pull in opposite directions per category, which
  is why category-averaged only moved +1.3 while overall moved +2.3.

**Do not ship "compaction OFF" as a conclusion on this run.** It is confounded.

---

## Required follow-up — single-variable split

Run these as isolated A/Bs against the 0.4610 baseline, `--runs ≥1` full suite,
frozen answerer, serial (one GPU slot):

1. **#277 date-retry ONLY** (compaction stays ON). Hypothesis: recovers most of the
   temporal +9.8 without the multi-hop / open-domain regression.
2. **nocompact ONLY** (no #277). Hypothesis: reproduces the multi-hop / open-domain
   regression and little else.
3. If (1) confirms, the ship decision is: **take #277, keep compaction, fix the
   stage-4 compressor** (`wt-fix-284`, `fix/conversational-compaction`) rather than
   disabling it wholesale.

---

## Not a lever here — bitemporal `valid_to` / `as_of`

Recorded so no one re-derives it while chasing temporal:

- The LoCoMo harness **never sets `as_of`**, so `validityFilterClause()` /
  bitemporal filtering is never exercised. Temporal is answered from atom **TEXT**,
  which is exactly why #277 (text-surface grounding) moved it and a schema/validity
  change would not. Bitemporal earns **zero LoCoMo points**.
- Separately, atom-level `valid_to` extraction (#216) had a live product bug: the
  default recall filter `valid_to IS NULL` means *unbounded*, not *currently valid*,
  so a correctly-extracted future end date made the fact **invisible to every normal
  search immediately** (#228, fixed to `valid_to IS NULL OR valid_to > now`). Real
  product gap, still zero LoCoMo impact.

See `CLAUDE.md` → "Temporal reasoning — the schema is NOT at fault" and CHANGELOG #228.

---

## Publish stance

- **0.4610 remains the safe published number** — it is the clean, single-config,
  infrastructurally-verified full-suite run.
- **0.4840 is a promising but confounded result.** Do not publish it until the
  single-variable split isolates what earned the points and confirms the category
  regressions are acceptable or eliminated.
