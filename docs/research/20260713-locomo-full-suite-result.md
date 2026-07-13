# LoCoMo — first full-suite result (2026-07-13)

**Overall F1: 0.4610 (n=1986).** Every prior number came from a single
conversation (n=199). This one is the complete benchmark.

## Result

```
1 (multi-hop)   : 0.3145   (282)
2 (temporal)    : 0.1318   (321)
3 (open-domain) : 0.2318   (96)
4 (single-hop)  : 0.4332   (841)
5 (adversarial) : 0.8924   (446)

Category-averaged : 0.4007
Overall (F1)      : 0.4610   n=1986
```

## Run provenance

| | |
|---|---|
| commit | `429e99c` (pinned worktree, isolated) |
| dataset | `locomo10.json` — 10 conversations, 272 sessions, 1986 QA |
| sampling | **none** (`n: null, qaPerSample: null`) |
| extraction | `codex-subscription` / `gpt-5.4-mini` |
| compaction | `ollama` / `qwen3:8b` |
| extract profile | conversational |
| answerer | Azure `gpt-5-mini`, `reasoning_effort: minimal`, 150 tok, k=10 (**unmodified**) |
| distill | 274/274 jobs, **0 poison**, 0 timeouts |
| atoms stored | **2488** (9.1/session) |
| entity linkage | **99.6%** (2477/2488) |
| abstain rate | 855/1986 (43.1%) |

## What is now safe to claim, and what is not

**Safe:** 0.4610 on the full 1986-question set, against the LoCoMo paper's 41.4
(also full-set). This is the first time the comparison is apples-to-apples. The
earlier 0.4540 was **n=199, one conversation**, and claiming it beat 41.4 was
explicitly flagged unsafe for that reason.

**Not safe:** reading the headline without the categories. **The overall is
flattered by adversarial** — 446 questions (22.5%) where the correct answer is
"no information available", scored binary, at 0.8924. A system with **no memory
at all** scores ~22 overall by abstaining on everything. Category-averaged
(0.4007) is the harsher and more honest figure.

## Trajectory, and what actually moved it

```
0.2362  ->  0.4610      (same benchmark, same answerer, same retrieval code)
  136  ->  2488 atoms   (18x)
```

The first run did not score 0.2362 because retrieval failed. It scored 0.2362
because distill stored **136 atoms from 272 sessions** and the system abstained
on **93.5%** of questions — barely above the ~22.5 abstain floor. **LoCoMo is an
extraction benchmark for us.** Nearly all of the gain came from what we store,
not from how we rank.

## The finding that matters most

**Temporal is 0.1318 across 321 questions — and the fix aimed at it did nothing.**

It was 12.4 before. Text-surface date grounding (PR #189 + timezone fix #191)
shipped *specifically* to fix temporal by resolving relative expressions
("yesterday", "last year") into absolute dates inside the atom's own text — the
part the answerer actually reads.

It moved **essentially nothing** (12.4 -> 13.18).

The standing diagnosis — *"the temporal score is an extraction gap, not a
schema gap"* (concluded by a full architecture investigation) — is therefore **in
doubt**. The fix derived from that theory did not work.

**Do not ship another temporal fix on the same theory.** Re-open the
investigation. Candidate explanations, none yet tested:

- The dates ARE grounded but token-F1 penalises the phrasing (~1/3 of "when"
  gold answers are stated relative to another date — a correct fact worded
  differently still scores near zero).
- The grounding fires on ingest but LoCoMo's `captured_at` anchor is not what we
  think it is for this corpus.
- Temporal questions need `as_of`-style reasoning the answerer never performs
  (the harness deliberately sets no `as_of` — see `answer.mts`'s header).

Distinguishing these is a measurement problem, not a coding problem.

## Where the remaining points are

| category | n | share | now | plausible | overall gain |
|---|---|---|---|---|---|
| single-hop | 841 | 42% | 0.4332 | 0.60 | **+7.2** |
| temporal | 321 | 16% | 0.1318 | 0.50 | **+6.0** |
| multi-hop | 282 | 14% | 0.3145 | 0.55 | **+3.4** |
| open-domain | 96 | 5% | 0.2318 | 0.45 | +1.1 |

**~+18 is the realistic ceiling and it requires all four.** There is no single
lever worth 20 points; anyone claiming otherwise is guessing.

Next steps: FEAT-487 (ranking signals that ship at zero — gated on the retrieval
diagnostic, which can kill it) and a re-opened temporal investigation.

## Reproduce

```bash
bun scripts/eval/locomo/run.mts \
  --dataset .eval-data/locomo/locomo10.json \
  --extract-profile conversational \
  --extraction-provider codex-subscription --extraction-model gpt-5.4-mini \
  --compaction-provider ollama --compaction-model qwen3:8b \
  --distill-timeout-ms 5400000 --k 10 --seed 42

bun scripts/eval/locomo/judge.mts --hyp <run>/hypotheses.jsonl --ref <run>/sample.json
```

Wall clock: **2h 2m** (distill 80m, answering 42m serial). PR #253 makes the
answering phase concurrent — same score, minutes instead of 42.

**Do not run extraction on `qwen3:8b`** (the shipped default): it produced 4 jobs
in 20 minutes, poisoned 3, and the in-repo extraction bench already records it at
**20 failed fixtures, 154.5s/session, no F1 at all**. It does not fit the 8 GB GPU
alongside the embedder and thrashes. See the VRAM note in CLAUDE.md.
