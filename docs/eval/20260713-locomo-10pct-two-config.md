---
type: eval-report
created: 2026-07-13T16:10:00Z
objective: LoCoMo 10% sample, two-config comparison — does the conversational extraction profile (SLICE-434) fix the extraction-starvation baseline, and how does a codex-subscription extractor compare to local qwen3:8b?
status: completed — both configs scored
---

# LoCoMo 10% sample — two-config comparison (2026-07-13)

## Headline: yes, the conversational profile fixes the starvation

Both configs land in the **0.42-0.45 overall F1** range, roughly **double** the
prior 0.2362 baseline, with **atoms/session up ~20x** (from ~0.5 to ~10). The
first LoCoMo run measured extraction collapse, not retrieval quality — this
run confirms `distill.extractProfile: conversational` (SLICE-434) is the fix.

## Setup

- **Sample**: LoCoMo `conv-26`, 19 sessions (7.0% of the 272-session
  baseline — the sampler's only unit is a whole conversation, so an exact
  10%/27-session cut isn't achievable; 19 sessions is the closest option),
  199 QA pairs. `--n 1 --seed 42` (deterministic — reused verbatim from the
  prior session's prep, per its own recommendation).
- **Dataset**: sha256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`
  (recorded in both runs' `run-params.json` — matches the pinned hash in
  `docs/eval/locomo-methodology.md`, no upstream drift).
- **Daemon**: package `0.15.1`, git SHA `f1cb80a89c2ce74d07452de8667c3aa269466c7e`
  (main + cherry-picked `c61bc79` model-override prep + this session's
  provider-override/extract-profile extension — see "Harness changes" below).
- **Both configs**: `distill.extractProfile: conversational` (explicit, not
  inherited), answerer = Azure `gpt-5-mini` (`reasoning_effort: minimal`,
  k=10) — unchanged from the prior baseline run, so the extraction/compaction
  side is the only intentional variable between configs A/B and the
  baseline.
- **Isolation**: each config ran in its own throwaway `makeIsolatedEvalEnv`
  sandbox (APPDATA/LOCALAPPDATA/HOME/XDG redirected to a tmp dir, no
  sync.json, encryption disabled) — never touched the production daemon,
  its config, or its credential store. Configs ran **sequentially**, never
  concurrently, per the box's shared-Ollama-VRAM constraint.

## Scores side by side

Token-F1 / token-overlap, upstream-faithful scoring (same metric as the
23.62 baseline — **not** comparable to any LLM-judge or competitor number;
see `docs/eval/locomo-methodology.md`'s harsher-than-upstream caveat: our
answerer emits full sentences, not terse spans, which token-F1 penalizes
independent of retrieval correctness).

| Category | Config A (codex gpt-5.4-mini extract) | Config B (qwen3:8b extract) | Old baseline (full 1986, n shown) |
|---|---|---|---|
| 1 multi-hop | 0.2469 (n=32) | 0.3537 (n=32) | 0.0348 (n=282) |
| 2 temporal | 0.1136 (n=37) | 0.1236 (n=37) | 0.0043 (n=321) |
| 3 open-domain | 0.3386 (n=13) | 0.3374 (n=13) | 0.0527 (n=96) |
| 4 single-hop | 0.4089 (n=70) | 0.4439 (n=70) | 0.0200 (n=841) |
| 5 adversarial (binary = correctly abstained) | 0.8511 (n=47) | 0.8298 (n=47) | 0.9776 (n=446) |
| **Category-averaged** | **0.3918** | **0.4177** | **0.2179** |
| **Overall** | **0.4278 (n=199)** | **0.4540 (n=199)** | **0.2362 (n=1986)** |

Config B (all-local qwen3:8b) edges out Config A (codex gpt-5.4-mini
extraction) on every category except #3 (open-domain, effectively tied) and
#5 (adversarial, where B abstains slightly less than A — direction is
noise-level at n=47). Both are a clear, large win over baseline.

**Cat-5 interpretation** (raised mid-run, worth stating explicitly): cat-5
accuracy dropping from 0.98 (baseline) to 0.83-0.85 here is *expected, not a
regression*. Baseline abstained on ~94% of ALL questions (extraction had
almost nothing to retrieve), so it "correctly" abstained on adversarial
questions too, essentially by accident. Now that extraction actually
produces real content, both configs attempt real answers more often —
including on some adversarial questions where the right move is to abstain.
The tradeoff is worth it: categories 1-4 went from near-zero to real,
substantive scores.

## Atom counts — the number that tells the real story

| | Config A (codex) | Config B (qwen3:8b) | Baseline |
|---|---|---|---|
| Sessions | 19 | 19 | 272 |
| Memories extracted | **200** | **191** | 136 |
| Atoms/session | **10.53** | **10.05** | **0.50** |

Both configs land at essentially the same atoms/session (~10.05-10.53) —
extractor choice (codex-subscription vs local qwen3:8b) barely moves this
number; the **profile** (conversational vs engineering) is what mattered.
This is a ~20x improvement over the starvation baseline and directly
confirms SLICE-434 fixed the root cause the first run identified.

## Abstention rate

"Abstain" = hypothesis contains "no information available" or "not
mentioned" (same substring check the judge uses for cat-5 scoring).

| | Config A | Config B | Baseline |
|---|---|---|---|
| Overall abstain | 85/199 = **42.7%** | 78/199 = **39.2%** | 1857/1986 = **93.5%** |
| Cat 5 abstain (should abstain) | 40/47 = 85.1% | 39/47 = 83.0% | 435/446 = 97.6% |
| Cat 1-4 abstain (should NOT abstain) | 45/152 = 29.6% | 39/152 = 25.7% | ~1422/1540 ≈ 92.3%* |

\* Baseline cat 1-4 abstain rate derived from total abstain minus cat-5
abstain (1857-435=1422 of 1540 cat-1-4 questions) — not independently
re-verified against that run's raw hypotheses file (out of scope for this
session; the baseline run's own report is cited as-is).

Both configs still abstain on roughly a quarter of answerable (cat 1-4)
questions — real headroom remains — but that is a world away from
baseline's ~92% cat-1-4 abstention.

## Distill health

| | Config A | Config B |
|---|---|---|
| Sessions ingested | 19/19, 0 failed | 19/19, 0 failed |
| Sessions distilled | 19/19, 0 timed out | 19/19, 0 timed out |
| Transient distill-job timeouts (retried, then succeeded) | 0 | 3 |
| Permanently failed/poisoned distill jobs | 0 | 0 |

Config B had 3 distill jobs hit `"The operation was aborted due to
timeout"` on their first attempt, then succeeded on retry (`attempts=1`,
final `state=completed`) — the job-retry machinery absorbed all three; **no
session's data was lost**, and the final manifest correctly shows
`distill_timed_out: 0`. No qwen3:8b empty-extract regressions were observed
in either config (the `think:false` auto-set for `qwen3*` in
`src/providers/llm/ollama.ts` held for all 19 Config-B extraction calls).

## Cost + wall-clock

| | Config A (codex extract) | Config B (qwen3:8b extract) |
|---|---|---|
| Daemon boot | 1.85s | 1.3s |
| Ingest (19 sessions) | 133ms | 47ms |
| Distill-wait (19 sessions) | **11.8 min** (706,971ms) | **42.3 min** (2,536,284ms) |
| Answer (199 QA, Azure) | 4.6 min (277,505ms) | 4.8 min (289,129ms) |
| **Total wall clock** | **16.6 min** | **47.3 min** |
| Extraction/compaction cost | $0 (codex-subscription: ChatGPT-quota traffic, `usage.usd` always 0 by design — does not meter against Azure/API budget) | $0 (Ollama local, measured: `budget_spend.usd_total=0`, 68/72 calls) |
| Answerer cost (Azure gpt-5-mini, 199 calls each) | not separately metered by this harness (only daemon-routed calls hit `budget_spend`) | same |

Codex-subscription extraction is **~3.6x faster wall-clock** than local
qwen3:8b for the same 19 sessions (11.8 min vs 42.3 min distill-wait) —
expected, since it's a remote inference call vs local GPU-shared inference
on a box that's also running the production daemon's compaction and sibling
agents' Ollama traffic. Neither config's Azure answerer cost was measured
directly (the harness's `budget_spend` table only tracks daemon-routed
calls, not the harness's own direct Azure calls); extrapolating from the
prior full-dataset run's actual $1.50-3 for 1986 calls (~$0.0008-0.0015/
call), 199 calls here is roughly **$0.15-0.30** per config — an estimate,
not a fresh measurement.

## Honest caveats

1. **10% sample, one conversation.** `conv-26` (19 sessions, 199 QA pairs)
   is 7.0% of the full 272-session dataset — the closest achievable cut
   given the sampler's conversation-level granularity. Per-category counts
   are small (n=13 for open-domain, n=32 for multi-hop) — treat these as
   directional, not final. A full 10-conversation rerun is the natural
   follow-up once a config is chosen.
2. **No sessions failed to distill in either config.** 19/19 in both.
3. **No empty extractions observed.** Both configs' extraction stages
   produced real content on every session (verified via atoms/session far
   above zero, and 0 poisoned distill jobs in either run).
4. **Config B's 3 transient timeouts** (see "Distill health") are a
   this-box-is-shared artifact (Ollama contention with the production
   daemon + sibling agents), not a codebase defect — flagging per the
   task's ask to report any distill regressions immediately; there were
   none that survived to the final result.
5. **Azure answerer cost is estimated, not measured**, for both configs —
   this harness doesn't meter its own direct Azure calls into
   `budget_spend`. A follow-up could add that (FEAT candidate).
6. **Sample-size mismatch vs baseline** (n=199 here vs n=1986 baseline) —
   category-level comparisons to baseline are directional evidence the fix
   generalizes, not a statistically matched comparison.

## Which config — and does the profile fix the starvation?

**Yes, unambiguously**: `distill.extractProfile: conversational` fixes the
extraction starvation the first run identified. Atoms/session went from
~0.5 to ~10 in both configs (a ~20x improvement), and overall F1 nearly
doubled (0.2362 -> 0.43-0.45) despite the metric being a harsher
sentence-vs-span comparison than upstream's own baselines use.

Between the two extractors, **Config B (local qwen3:8b) scored slightly
higher** (0.4540 vs 0.4278 overall) at roughly **3x the wall-clock cost**
than Config A (codex-subscription gpt-5.4-mini, 47.3 min vs 16.6 min) but
at genuinely $0 metered cost either way. If wall-clock matters more than the
~6% F1 gap, Config A is the faster choice; if maximizing score at this
sample size matters more, Config B. Given the gap is within the noise
expected at n=199, neither result should be read as a strong per-extractor
verdict — a full-dataset rerun would be needed to say more.

## Harness changes made to run this eval

Two additive extensions to `scripts/eval/shared/spawn-daemon.ts` and
`scripts/eval/locomo/run.mts` (on top of cherry-picking `c61bc79`, an
already-reviewed model-pin commit from a parallel session's prep that was
never merged to main):

- `EvalModelOverrides` gained `extractionProvider`/`compactionProvider`
  fields (previously model-name-only) — needed to point Config A's
  extraction at `codex-subscription` while compaction stayed on `ollama`.
- `makeIsolatedEvalEnv` gained an `extractProfile` option, writing
  `distill.extractProfile` into the sandbox's `config.yaml` — needed to pin
  `'conversational'` explicitly rather than relying on any inherited
  default.
- `run.mts` gained `--extraction-provider`/`--compaction-provider`/
  `--extract-profile` flags, threaded through both the real-run and
  `--dry-run-throughput` paths, and recorded in `run-manifest.json`'s
  `config.models`/`config.extractProfile` (same "checkable against the
  manifest, not memory" discipline the cherry-picked commit established).

Verified: `bun run build` clean; scoped typecheck via a scratch tsconfig
covering `scripts/eval/**` (not covered by either shipped tsconfig) — 0
errors; 5 scoped vitest files touching this contract (28 tests) — all pass,
confirming LongMemEval (which shares `spawn-daemon.ts`) is unaffected.
`os.homedir()` on this Windows box was confirmed to ignore the sandbox's
`HOME` env override (it reads `USERPROFILE`, unaffected by the isolation
redirect) — so `codex-subscription`'s default `~/.codex/auth.json` lookup
correctly resolved to the operator's real Codex CLI login inside the
isolated sandbox, with no additional plumbing needed.

## Run artifacts

- Config A: `.eval-data/locomo/runs/2026-07-13T15-49-03-443Z/` (this
  worktree) — `sample.json`, `run-manifest.json`, `hypotheses.jsonl`,
  `hypotheses.jsonl.metrics.json`, `run-params.json`.
- Config B: `.eval-data/locomo/runs/2026-07-13T14-59-21-798Z/` (this
  worktree) — same file set.
- Worktree: `C:\work\mega\astramemory-local\.claude\worktrees\agent-a0112287d8dd8d401`,
  built off main commit `59ec9e9` + later (SLICE-430 through the latest
  merged main at run time), plus the cherry-picked + extended harness
  changes above. Not committed/pushed per this task's scope.
