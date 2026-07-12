# LoCoMo evaluation methodology for astramemory-local

**Status (2026-07-12): adapter code complete and reviewed PASS
(`scripts/eval/locomo/`), dataset downloaded and structurally verified, no
scored run has been completed yet. Do not cite a LoCoMo accuracy number for
astramemory-local until a run command below has actually been executed and
its `run-manifest.json` / metrics file are in hand — none exists today.**

This doc is written to be executed by a human operator directly, not a
coding agent. See "Why this must run from a plain terminal" below.

## The one command to run

```powershell
cd C:\work\mega\astramemory-local
bun install
bun run build

# Full LoCoMo run: 10 conversations, 272 sessions, 1986 QA pairs.
# --detach survives closing this terminal; the run continues in the background.
bun scripts/eval/locomo/run.mts --distill-timeout-ms 28800000 --detach
```

This prints a run directory (`.eval-data/locomo/runs/<ISO-timestamp>/`) and
an orchestrator PID, then returns immediately. Real work continues in a
detached child process.

**Expected wall clock: roughly 3.5-5 hours**, dominated by local
`qwen2.5-coder:7b` distill extraction (see "Throughput estimate" below — this
is an extrapolation from a different benchmark's measured rate, not a
LoCoMo-measured number; see that section for how to get a real one first if
you have a spare 20-30 minutes).

Check on it any time, from any terminal, on this same machine:

```powershell
bun scripts/eval/locomo/run.mts --status .eval-data/locomo/runs/<timestamp>
```

Look at `phase` and `updated_at` in the printed status. If `phase` reaches
`completed` with `exit_code: 0`, the run succeeded — 0 ingest failures, 0
distill timeouts is "good." Then score it:

```powershell
bun scripts/eval/locomo/judge.mts `
  --hyp .eval-data/locomo/runs/<timestamp>/hypotheses.jsonl `
  --ref .eval-data/locomo/runs/<timestamp>/sample.json
```

This prints per-category F1/accuracy, a category-averaged accuracy, and an
overall accuracy, and writes the same numbers to
`.eval-data/locomo/runs/<timestamp>/hypotheses.jsonl.metrics.json`. Add
`--llm-judge` for an additional (Azure `gpt-5-mini`) semantic-correctness
pass on categories 1-4 — see "The harsher-than-upstream caveat" for why you
probably want this second signal alongside the raw F1 number.

If the run dies partway (stuck, terminal closed without `--detach`,
whatever) — see "Resuming a killed run" below before starting over.

## What we measure

For each of LoCoMo's 10 real multi-session conversations, every session is
ingested into an isolated per-conversation project via
`POST /ingest/transcript`, then — once the daemon's async distill pipeline
has processed every session — every one of that conversation's QA pairs is
answered by calling `POST /recall` (scoped to that conversation's project)
and handing the retrieved memory notes plus the question to a fixed cheap
answering model (Azure `gpt-5-mini`, `reasoning_effort: minimal`). This
measures the **memory system** (ingest -> distill -> retrieval), not the
answering LLM's own world knowledge — a stronger model would mask retrieval
gaps by inferring answers it was never actually given.

LoCoMo's 5 QA categories and how each is scored (verified against the actual
upstream `task_eval/evaluation.py` source, not just the paper's prose —
category numbering is not self-describing in the raw data; see
`scripts/eval/locomo/lib/types.ts`'s header for the full derivation trail):

| category | name | scoring |
|---|---|---|
| 1 | multi-hop | comma-split multi-answer F1 (best-match per gold sub-answer) |
| 2 | temporal | plain token-overlap F1 |
| 3 | open-domain | plain token-overlap F1, gold answer truncated to before its first `;` |
| 4 | single-hop | plain token-overlap F1 (largest category by count) |
| 5 | adversarial | binary — 1 iff the hypothesis contains "no information available" or "not mentioned", else 0 (no `answer` field exists for this category, only a wrong distractor) |

## Scoring method — upstream-faithful, reimplemented, not vendored

Unlike this repo's LongMemEval adapter (which shells out to a vendored Azure
fork of upstream's Python judge script), **LoCoMo's own upstream scoring is
plain F1/token-overlap plus a substring check — not an LLM judge at all.**
`scripts/eval/locomo/judge/metrics.mts` reimplements it in TypeScript,
byte-for-byte matching upstream's `normalize_answer` pipeline (lowercase ->
strip punctuation -> strip standalone articles "a"/"an"/"the"/"and" — yes,
upstream's regex treats "and" as an article here too, kept as-is for
fidelity -> collapse whitespace) and Porter-stemmed token overlap, verified
against the actual `task_eval/evaluation.py` / `evaluation_stats.py` source
(fetched and read 2026-07-10), not just the paper's description. This keeps
the whole harness Azure-optional for scoring: only the *answering* step
needs Azure; the *judging* step is deterministic and free.

An optional `--llm-judge` pass (Azure `gpt-5-mini`, categories 1-4 only —
category 5 is already a deterministic substring check an LLM pass adds
nothing to) provides a second, semantic-correctness signal alongside the F1
number. Both reports are always written when `--llm-judge` is passed; it is
additive, never a replacement for the upstream-faithful F1 number.

## The harsher-than-upstream caveat — read this before citing any number

**Our token-F1 score will very likely read lower than published LoCoMo
baseline numbers, for a reason that has nothing to do with retrieval
quality.** The original benchmark's own baseline systems produce short,
terse extracted spans as answers (a name, a date, a phrase). Our answerer
(`scripts/eval/locomo/answer.mts`) is instructed to be terse but is still an
LLM generating a natural-language response grounded in retrieved memory
notes — it will often produce a complete short sentence rather than a bare
span. Token-overlap F1 penalizes exactly this: a fully correct answer phrased
as "She moved to Seattle in 2019" scores lower against a gold answer of
"Seattle, 2019" than a terse span would, purely on token-count/precision
grounds, independent of whether the underlying memory recall was correct.

**Anyone citing our F1 number must see this caveat alongside it.** Do not
report our F1 score next to the original paper's or another system's
F1 score as if they were measuring the same thing without also stating this
difference — it makes the comparison read as "less accurate" when the actual
retrieval could be equally or more correct. This is the reason the `--llm-judge`
secondary signal exists: an LLM grading "is this candidate answer correct in
meaning, regardless of phrasing" is far less sensitive to this artifact.
Report both numbers together, not just the F1 one, whenever this run's
results are used for an external claim.

## Dataset and license

- **Source**: `https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json`
  (upstream: [snap-research/locomo](https://github.com/snap-research/locomo)).
- **License: CC BY-NC 4.0** — fine for an internal benchmark run and for
  publishing "as measured by us" numbers; the dataset itself must not be
  resold or bundled/redistributed as part of a commercial product.
- **Verified shape** (downloaded and checked 2026-07-12): 2,805,274 bytes
  (~2.8MB), 10 conversations, 1,986 QA pairs total, **272** content-bearing
  sessions total across all 10 conversations (19-32 sessions per
  conversation, counting only `session_<N>` arrays that actually have turn
  content — see the discrepancy note directly below). This matches the
  adapter's own design-time assumptions (`scripts/eval/locomo/lib/dataset.ts`'s
  header) — no schema-breaking surprises on first real download.
- **Discrepancy worth knowing about**: `scripts/eval/locomo/README.md` and
  this project's own prior citations say **287** sessions total (matching
  the paper's own count, checked against upstream 2026-07-10). A fresh
  download today (2026-07-12, two days later) counts **272** content-bearing
  sessions — either upstream's `main` branch changed in the interim, or the
  287 figure was never independently verified against this exact file. Not
  investigated further here (out of scope for this prep), but flagged
  because it changes the throughput math slightly (see below) and because
  any published number should state which count it was measured against.
  One related, harmless anomaly found while checking this: `conv-26` carries
  `session_<N>_date_time` keys for N=1..35 but content arrays (`session_<N>`)
  only for N=1..19 — a longer synthetic timeline's dates survived in the
  metadata with no matching content. Verified this does **not** silently
  break scoring: none of `conv-26`'s 199 QA pairs' `evidence` dia_ids
  reference a session above 19, and the adapter's own `sessionNumbers()`
  (`scripts/eval/locomo/lib/types.ts`) only iterates content-bearing
  `session_<N>` keys, so ingest already does the right thing here without
  any code change. Worth a glance if a future re-download ever shows a
  QA pair referencing a session number with no matching content array —
  that would be a real gap this adapter doesn't currently guard against.
- Lives at `.eval-data/locomo/locomo10.json` once downloaded — `.eval-data/`
  is `.gitignore`d; never commit the dataset file or any run output.
- `sampleLocomo`'s default (`--n` unset) keeps **all 10 conversations** —
  unlike LongMemEval's 500-question stratified sub-sample, LoCoMo's own
  dataset is small enough to load and run whole; `--n`/`--qa-per-sample` only
  exist for a fast smoke/dry-run subset, not the scored run.

## Reproduce it

```powershell
cd C:\work\mega\astramemory-local
bun install
bun run build

# Just draw/refresh the sample file (downloads the dataset on first run):
bun scripts/eval/locomo/sample.mts

# Full run (see "The one command to run" above for the flags and why):
bun scripts/eval/locomo/run.mts --distill-timeout-ms 28800000 --detach

# Score it:
bun scripts/eval/locomo/judge.mts --hyp <run-dir>/hypotheses.jsonl --ref <run-dir>/sample.json [--llm-judge]
```

## Why this must run from a plain terminal, not a coding-agent's shell

**Verified live (2026-07-08, documented in
`scripts/eval/longmemeval/README.md`): a coding-agent's sandboxed shell
silently reaped a spawned eval daemon mid-run and destroyed a 40-minute
run**, with no trace anywhere in the daemon's own logs, no OS crash dump, no
application-error event — consistent with the sandbox's own background-
process governance reaping the process tree under resource pressure, not an
application bug. A LoCoMo run at the estimated 3.5-5 hour scale is squarely
in the same risk zone. **Launch the run command above from a plain
PowerShell/cmd window you opened yourself**, not from inside a coding
agent's tool call — and prefer `--detach` so it also survives closing that
window.

## Prerequisites — status as of 2026-07-12

| Prerequisite | Status |
|---|---|
| Local Ollama server | Up, version 0.31.2 |
| `qwen2.5-coder:7b` (extraction) | Pulled and currently loaded/resident |
| `mxbai-embed-large` (embeddings) | Pulled and currently loaded/resident |
| `AZURE_OPENAI_KEY` env var | Not set, but not required — `resolveAzureKey()` (`scripts/eval/shared/config.ts`) falls back to a live `az cognitiveservices account keys list` call. Verified working: `az login` is active as `sergey@astragenie.com` with access to the `oai-astragenie-dev-cu` resource (a live key fetch succeeded, key not printed/logged). Set `AZURE_OPENAI_KEY` yourself only if you want to skip that ~1-2s az CLI round trip or don't have `az login` active. |
| Disk space | 215GB free on C: — not a constraint at this dataset size (2.8MB dataset, run output is JSON/JSONL, no media) |
| `dist/` build | Present (`dist/cli/index.js` exists) — re-run `bun run build` if you've pulled new commits since |
| GPU VRAM headroom | 8151 MiB total, ~2GB free with both models resident — same constrained headroom `longmemeval/README.md` documents; do not expect `--shards >1` to give a real speedup on this box (see "Sharding" below) |

**Nothing is blocking a run today.** The one soft note: `AZURE_OPENAI_KEY` is
unset, but the `az` CLI fallback is confirmed working, so this is not a gap
unless `az login` expires between now and when you run it.

## Throughput estimate — extrapolated, not LoCoMo-measured

The harness ships its own `--dry-run-throughput` probe
(`scripts/eval/locomo/run.mts`'s `runDryRunThroughput`) specifically to
replace an extrapolated estimate with a real measured one. **It was
deliberately not run as part of this prep**, because LoCoMo's dataset has no
unit smaller than one whole conversation (19-32 sessions each) — even the
smallest possible probe (`--dry-run-conversations 1`, the default) would
mean spawning a real isolated daemon and running a genuine distill pass to
completion on at least 19 sessions, which at the measured baseline below is
itself a 15-30+ minute live background-daemon invocation. That is squarely
the same shape of activity (a real spawned daemon, run from an automated
shell, for a nontrivial duration) that caused the 2026-07-08 incident above
— so this was treated as "the operator's step," per this repo's own rule
that multi-minute eval invocations run from a human-controlled terminal, not
a coding agent's.

**If you have a spare 20-30 minutes before committing to the full run**,
get a real number first:

```powershell
bun scripts/eval/locomo/run.mts --dry-run-throughput
```

This ingests+distills one real sampled conversation to completion (no
answer/judge step, no Azure calls), then writes
`runDir/throughput-dry-run.json` with a measured seconds/session figure and
an extrapolation to the full dataset — printed directly to the console too.
Re-run the "one command to run" above with `--distill-timeout-ms` adjusted
if the measured rate is meaningfully different from the estimate below.

**Absent that, here is the extrapolated estimate**, computed from this
project's own measured LongMemEval throughput (real, not a guess — see
`scripts/eval/longmemeval/README.md`'s "Throughput" section: 45-60
seconds/session for local `qwen2.5-coder:7b` extraction on this exact
machine/GPU) applied to LoCoMo's **actual downloaded session count** (272,
verified above — not an extrapolated figure):

- 272 sessions x 45s = 12,240s ~ **3.4 hours** (low end)
- 272 sessions x 60s = 16,320s ~ **4.5 hours** (high end)
- Working midpoint (~50s/session): **~3.8 hours**

This is a different benchmark's measured rate applied to LoCoMo's real
session count, not a LoCoMo-specific measurement — treat it as a planning
number, not a guarantee. The `--distill-timeout-ms 28800000` (8 hours) in
the run command above deliberately leaves ~1.75x headroom above the 4.5h
high end, since Ollama is shared with the production daemon and other
sibling agent processes on this box and could run slower than the isolated
baseline measurement did.

### Sharding

`--shards N` round-robins conversations across N isolated daemons. **Not
recommended on this box**: VRAM headroom is ~2GB with both required models
already resident (same constraint `longmemeval/README.md` documents in
detail), not enough for a second concurrent `qwen2.5-coder:7b` slot — a
second shard would likely force onto CPU (slower per-call) or fail, rather
than truly parallelizing. The default `--shards 1` is the right choice here
unless you've independently confirmed more VRAM headroom or raised
`OLLAMA_NUM_PARALLEL` with real spare GPU memory to back it.

## Resuming a killed run

Same mechanism as the LongMemEval adapter (FEAT-462, shared
`scripts/eval/shared/resume-ledger.ts`/`run-params.ts`): every run directory
gets a crash-safe `ingest-ledger.jsonl` and a `run-params.json` recording the
original `--dataset`/`--seed`/`--n`/`--qa-per-sample`/`--shards` scope.

```powershell
bun scripts/eval/locomo/run.mts --resume .eval-data/locomo/runs/<timestamp> --distill-timeout-ms 28800000 --detach
```

`--resume` refuses (non-zero exit) if omitted flags would silently narrow or
change the original run's scope — pass the exact same flags as the original
invocation. If a daemon needs killing first (stuck, not just a closed
terminal), do it by PID only, never by image name:

```powershell
bun scripts/eval/shared/kill-run.mts .eval-data/locomo/runs/<timestamp>
```

This reads `daemon-manifest.json` and signals only the PIDs recorded there,
after confirming via the OS that the recorded port is still bound by that
exact PID (guards against PID reuse on this long-running, multi-tenant
machine) — never a machine-wide `taskkill`/`pkill` sweep (this box also runs
the production astramem daemon, Ollama, and sibling agents' processes).

## Reproducibility pinning (FEAT-457 AC-6)

A published LoCoMo number needs more than dataset/seed/model to be
reproducible. Pinned as of this prep (2026-07-12) — fixed regardless of when
the run executes, since these describe the dataset file and codebase
snapshot, not the run itself:

- **Dataset sha256**: `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`
  (`.eval-data/locomo/locomo10.json`, 2,805,274 bytes) — re-hash before
  publishing if the file is ever re-downloaded, since upstream doesn't
  version-tag it (see the discrepancy note above).
- **Daemon package version**: `0.15.0`
- **Daemon git SHA**: `8b95f1265416aab28bf4eb7b080d2a3f3d5b90d1` — **re-check
  this at actual run time** (`git rev-parse HEAD`) if any commits land
  between now and when the operator runs it; do not assume this SHA is
  still current.

**Must be captured AFTER the run actually executes** (cannot be pinned in
advance — fill these into this doc, or into the run's own manifest, once you
have them):

- [ ] The judge/answerer model's actual snapshot id, not just the deployment
      alias — Azure's `gpt-5-mini` deployment resolves to a specific dated
      snapshot; record what `resolveAzureConfig()` actually hit (check the
      Azure portal or `az cognitiveservices account deployment show`), not
      just the string `"gpt-5-mini"`.
- [ ] The full effective `config.yaml` the isolated eval daemon booted with
      (the sandbox writes a minimal override on top of `defaultConfig()` —
      see `scripts/eval/shared/spawn-daemon.ts`'s `makeIsolatedEvalEnv`).
- [ ] Whether `--llm-judge` was used for this published number, and if so,
      that pass's own judge model snapshot (same caveat as the answerer —
      it's the same deployment here, but say so explicitly rather than
      assuming).
- [ ] The run directory's `run-manifest.json` (already captures config,
      counts, and per-stage timings mechanically) and the judge's
      `hypotheses.jsonl.metrics.json` output — archive both alongside
      wherever the number gets published, not just the summary print-out.

## Isolation — this does not touch your production daemon or data

Same isolation machinery as the LongMemEval adapter
(`scripts/eval/shared/spawn-daemon.ts`'s `makeIsolatedEvalEnv`): the eval
daemon gets a throwaway `APPDATA`/`LOCALAPPDATA`/`HOME` sandbox with no
`sync.json`, so it never pairs to the live production SaaS tenant and never
touches your real config dir, SQLite file, or Ollama models beyond the two
it's configured to use (`qwen2.5-coder:7b`, `mxbai-embed-large` — the same
production defaults, so the eval still exercises the real provider stack).
