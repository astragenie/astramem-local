# LoCoMo adapter for astramemory-local

FEAT-457: a second, independent eval harness alongside
[`scripts/eval/longmemeval/`](../longmemeval/README.md), reusing its proven
daemon-isolation plumbing (`../shared/`) but with its own conversation-centric
data model, date format, and scoring — LoCoMo's shape is genuinely different
from LongMemEval's, not a re-skin. Read `../longmemeval/README.md` too: the
isolation rationale, sandbox-vs-plain-terminal warning, and Ollama tuning
guidance sections apply here unchanged and aren't repeated in full below.

## What is LoCoMo

[LoCoMo](https://github.com/snap-research/locomo) ("**Lo**ng-term
**Co**nversational **Me**mory") is Maharana et al.'s ACL 2024 benchmark
(arXiv:2402.17753): 10 long, multi-session, two-persona conversations (287
sessions total, spanning months of simulated time per conversation) with
~1,986 human-authored QA pairs across 5 categories. It's one of the two
benchmarks named in the packaging audit
(`docs/research/2026-07-09-packaging-audit.md`) as the credibility bar for
an OSS launch — competitors (Zep/Graphiti, mem0) cite LoCoMo numbers, and
this harness exists so astramemory-local can publish a first-party,
reproducible one run by its own code against its own daemon.

## License — CC BY-NC 4.0, non-commercial, attribution required

The dataset ships its own `LICENSE.txt` in the upstream repo:
**Creative Commons Attribution-NonCommercial 4.0 International**. This
harness never commits the dataset (`sample.mts`/`run.mts` download it into
`.eval-data/locomo/`, which is already `.gitignore`d at the repo root — no
redistribution risk), but any published number or blog post using it must
still attribute the dataset and its paper:

```bibtex
@article{maharana2024evaluating,
  title={Evaluating very long-term conversational memory of llm agents},
  author={Maharana, Adyasha and Lee, Dong-Ho and Tulyakov, Sergey and Bansal, Mohit and Barbieri, Francesco and Fang, Yuwei},
  journal={arXiv preprint arXiv:2402.17753},
  year={2024}
}
```

Non-commercial only: fine for an internal benchmark run and an "as measured
by us" public number, but the dataset itself must not be resold or bundled
into a commercial product.

## Layout

```
scripts/eval/
  shared/                  daemon-plumbing tier shared with ../longmemeval/
                           (spawn-daemon, daemon-client, azure-client, config,
                           concurrency, shard, ollama-tuning — see that
                           README's "Isolation" section for why spawn-daemon
                           exists at all; extracted here unmodified, FEAT-457)
  locomo/
    lib/
      types.ts             dataset shapes + the category-number derivation
                           (see its header — categories are NOT self-
                           describing in the raw JSON)
      dates.ts             "H:MM am/pm on D Month, YYYY" -> ISO-8601 UTC
      dataset.ts           loader + downloader + deterministic sampler
      envelope.ts           conversation session -> canonical /ingest/transcript
                           envelope (conversation-centric, NOT per-question —
                           see "Data model" below)
    sample.mts             CLI: download (if needed) + deterministic sample
    ingest.mts              CLI + module: sessions -> /ingest/transcript driver
    distill-wait.mts        CLI + module: poll /sessions/:id/digest per conversation
    answer.mts               CLI + module: /recall -> Azure gpt-5-mini -> hypotheses.jsonl
    run.mts                  orchestrator: sample -> daemon(s) -> ingest -> wait ->
                             answer -> manifest (mirrors ../longmemeval/run-smoke.mts;
                             also hosts --dry-run-throughput)
    judge.mts                orchestrator: F1/token-overlap scoring (+ optional
                             --llm-judge secondary pass)
    judge/
      porter-stemmer.ts      our own Porter (1980) stemmer implementation —
                             99.93% exact match against the algorithm author's
                             own 23,531-word reference corpus (see its header)
      metrics.mts             per-category + overall accuracy aggregator,
                             reimplementing the upstream benchmark's own
                             scoring (task_eval/evaluation.py) in TypeScript;
                             also hosts combineMetricsReports (multi-run
                             mean±stdev, FEAT-457 slice 1, reusing
                             ../../shared/stats.ts)
```

## Data model: conversation-centric, not question-centric

This is the load-bearing architectural difference from LongMemEval
(`../longmemeval/lib/envelope.ts:8-16`, one fully isolated daemon "haystack"
per *question*, because LongMemEval reuses raw sessions across many
questions' haystacks and would leak recall pools if it didn't). LoCoMo is
the opposite: one conversation's ~20-35 sessions are ingested **once**, into
one project (`locomo-<sample_id>`), and every one of that conversation's QA
pairs (anywhere from a handful to ~250) is then answered against that same
project. `ingest.mts`'s manifest is keyed `by_sample` (conversation), not
per-question; `distill-wait.mts` waits per conversation; `answer.mts` fans
out every QA pair for a ready conversation. `--shards N` in `run.mts`
partitions **conversations** round-robin across N isolated daemons, not
questions.

## Categories — verified against the actual upstream scoring code, not just the paper's prose

The raw `qa[].category` field is just an integer 1-5 with no name attached.
Cross-checking the paper's category descriptions against real sampled
question text turned out to disagree with a plausible-looking numeric
ordering — the only trustworthy source is the upstream repo's own scoring
code (`task_eval/evaluation.py`, fetched and read 2026-07-10, not
paraphrased from memory). See `lib/types.ts`'s header for the full
derivation trail (comment order, the semicolon-split special-case for
category 3, and `evaluation_stats.py`'s farthest/latest-evidence-session
span logic that only makes sense for category 1). Final mapping, used
throughout this harness:

| category | name | scoring |
|---|---|---|
| 1 | multi-hop | comma-split multi-answer F1 (`f1()` upstream) |
| 2 | temporal | plain token-overlap F1 |
| 3 | open-domain | plain F1, but only against `answer.split(';')[0]` |
| 4 | single-hop | plain token-overlap F1 (largest category, 841/1986 in the full dataset) |
| 5 | adversarial | binary: correct iff the hypothesis contains "no information available" or "not mentioned" (case-insensitive) — these QA pairs have no `answer` field at all, only a `adversarial_answer` distractor |

## Scoring: F1/token-overlap by default, Azure LLM-judge optional

Unlike LongMemEval, **LoCoMo's own upstream scoring is not an LLM judge at
all** — it's Porter-stemmed token-overlap F1 (`normalize_answer` +
`f1_score`/`f1` in `task_eval/evaluation.py`), reimplemented faithfully in
`judge/metrics.mts` (see that file's header for the exact algorithm,
including the upstream quirk that `normalize_answer` strips "and" as if it
were an article). This is Azure-free and deterministic — `judge.mts` runs it
by default on nothing but the hypotheses file and the reference sample file.

The catch: the upstream benchmark's own models produce short extracted
spans, but this harness's answerer produces natural-language sentences from
a `/recall`-grounded prompt (see `answer.mts`'s prompt, which does ask for
brevity). Token-F1 against a longer, correctly-phrased sentence is a harsher
measure than against a terse span, independent of retrieval quality. Pass
`--llm-judge` to additionally run an Azure semantic-correctness pass over
categories 1-4 (reusing `../shared/config.ts` + `../shared/azure-client.ts`,
same deployment as the answerer) as a second, more lenient signal — both
reports are always written, `--llm-judge` is additive, never a replacement
for the upstream-faithful F1 number.

Porter stemming needed its own implementation (`judge/porter-stemmer.ts`) —
not vendored from a library, verified live against the algorithm author's
own 23,531-word test corpus at 99.93% exact match (16 known "-bly"/"-logy"
edge-case mismatches, see that file's header).

## No `as_of` filtering for the temporal category

LongMemEval's temporal-reasoning/knowledge-update question types set
`filters.as_of` to the question's own `question_date` (see
`../longmemeval/answer.mts`) — a bitemporal "what did the memory system know
as of date Y" query. LoCoMo's temporal category (2) doesn't have that shape:
its questions ask about date relationships **within the retrieved
conversation content itself** (e.g. "how long ago was Caroline's 18th
birthday?"), not about a memory-system snapshot at a point in time, and the
schema has no per-question date to anchor an `as_of` filter to. `answer.mts`
does not set `as_of` for any LoCoMo category — the answerer LLM reasons over
dates present in the retrieved notes directly. This means LoCoMo's temporal
category does not depend on the `valid_from`/`captured_at` bitemporal fix
documented in `../longmemeval/README.md`'s "RESOLVED" section (that fix
matters for LongMemEval's `as_of` filter, which this harness doesn't use).

## Quick start

```powershell
bun install
bun run build

# 1. Sample (downloads locomo10.json into .eval-data/locomo/ if not present,
#    then writes a deterministic sample — default is the WHOLE dataset,
#    10 conversations, since LoCoMo is small enough to load-all)
bun run eval:locomo:sample

# 2. Run the full pipeline: ingest -> distill-wait -> answer
bun run eval:locomo:run

# 2b. Sharded across 2 isolated daemons (partitions CONVERSATIONS, not questions)
bun scripts/eval/locomo/run.mts --shards 2

# 3. Score (F1/token-overlap by default; --llm-judge adds an Azure secondary pass)
bun run eval:locomo:judge -- --hyp .eval-data/locomo/runs/<timestamp>/hypotheses.jsonl --ref .eval-data/locomo/runs/<timestamp>/sample.json
```

### Multi-run (mean±stdev, FEAT-457 slice 1)

A single `run.mts` invocation is one sample of whatever noise the daemon/
model pipeline has (Ollama sampling, distill timing, etc.) — repeating the
same invocation into separate run dirs and judging all of them together
reports mean±stdev instead of a single point estimate:

```powershell
# Repeat the same run N times into distinct run dirs (each full run.mts
# invocation — ingest+distill+answer — takes minutes; see the plain-terminal
# warning above).
bun scripts/eval/locomo/run.mts --run-dir .eval-data/locomo/runs/rep-1
bun scripts/eval/locomo/run.mts --run-dir .eval-data/locomo/runs/rep-2
bun scripts/eval/locomo/run.mts --run-dir .eval-data/locomo/runs/rep-3

# judge.mts: repeat --run-dir once per run dir. Each run dir must contain the
# hypotheses.jsonl + sample.json pair run.mts always writes into it.
bun run eval:locomo:judge -- \
  --run-dir .eval-data/locomo/runs/rep-1 \
  --run-dir .eval-data/locomo/runs/rep-2 \
  --run-dir .eval-data/locomo/runs/rep-3
```

This prints mean±stdev per category and overall (reusing
`../shared/stats.ts`'s `computeStats`/`formatStatsPct` — the same math
extraction-bench's `--runs N` uses) and writes the same `runs`/`*_stats`
shape into the output JSON. A single `--run-dir` (or the plain `--hyp`/
`--ref` form above) reports identically to the pre-multi-run output — no
mean/stdev section, since there's nothing to average over one run.

#### Cross-run comparability is enforced, not just documented

Averaging accuracy across run dirs is only honest if every run was sampled
with the same scope — mixing, say, a `--n 20` smoke-test dir in with two
full-`--n` real runs would print a confidently-formatted mean±stdev over
runs that were never comparable in the first place. Rather than relying on
an operator to remember "use the same params" (a documentation-only
safeguard is exactly the failure shape FEAT-462a's resume guard was built
to close), `judge.mts`'s multi-run path reads every `--run-dir`'s
`run-params.json` (written by `run.mts` on every invocation) and **hard-
refuses** before scoring anything if:

- any two run dirs disagree on a scope-determining flag (dataset hash,
  seed, `--n`, `--qa-per-sample`, `--shards`) — the refusal names every
  offending dir and every differing param, or
- any run dir is missing `run-params.json` entirely (predates FEAT-462's
  resume support, so there's no record of its sampling flags to compare).

There is no override flag, matching this project's DEC-012 refuse-on-
mismatch posture (`../shared/run-params.ts`'s `evaluateMultiRunParamsGuard`
— the same comparison logic `evaluateResumeGuard` uses for single-run
`--resume`, one stage earlier in the pipeline). A single `--run-dir` needs
no comparison and always proceeds. If the guard refuses, start fresh,
matched run dirs — there's no way to force a combination of non-comparable
runs.

`run.mts` itself is unchanged and has no `--runs` flag of its own: each
repetition is a full, independently-timed daemon lifecycle (ingest+distill
can run to tens of minutes even for a subset), so repeating it is left to
the caller (a loop, or CI) rather than orchestrated inside one `run.mts`
process.

**Run real (multi-minute-plus) `run.mts` invocations from a plain terminal
you opened yourself, not from inside a coding-agent's shell tool** — see
`../longmemeval/README.md`'s "Run real smoke/full runs..." section for the
full incident writeup (verified live 2026-07-08: a coding-agent sandbox
silently reaped a spawned daemon mid-run). The same risk applies here
unchanged; this harness spawns daemons the identical way.

Useful flags on `run.mts` (mirrors `../longmemeval/run-smoke.mts`'s surface):

| flag | default | meaning |
|---|---|---|
| `--n` | 10 (all) | number of conversations to sample |
| `--qa-per-sample` | (no cap) | cap QA pairs kept per conversation, category-stratified — for a fast smoke subset |
| `--seed` | 42 | sampler seed (same seed+n+qa-per-sample+dataset = same sample, always) |
| `--k` | 10 | recall `limit` |
| `--concurrency` | 4 | parallel `/ingest/transcript` calls within each shard/daemon |
| `--shards` | 1 | number of isolated daemons, round-robin partitioned by conversation |
| `--distill-timeout-ms` | 900000 (15 min) | almost certainly too low for a real run — see LongMemEval's measured throughput section for the order of magnitude (this harness hasn't published its own measured rate yet; use `--dry-run-throughput` first) |
| `--run-dir` | `.eval-data/locomo/runs/<timestamp>` | override output location |
| `--ollama-url` | `http://127.0.0.1:11434` (or `$OLLAMA_HOST`) | Ollama status/tuning query target |
| `--resume <run-dir>` | (none) | resume a killed run — see "Resume behavior" below |

`--dry-run-throughput` (ingest+distill only, no Azure) measures real
sessions/sec on your own machine before committing to a full run —
`--dry-run-conversations N` (default 1) picks how many real conversations to
sample for the probe. See `../longmemeval/README.md`'s Ollama tuning section
for `OLLAMA_NUM_PARALLEL`/`OLLAMA_KEEP_ALIVE` guidance; it applies verbatim
since both harnesses share the one local Ollama server.

## Resume behavior

`run.mts --resume <run-dir>` resumes a whole killed run (FEAT-462) —
identical mechanism and flag surface to `../longmemeval/run-smoke.mts`'s
`--resume` (same shared `../shared/resume-ledger.ts` module, AC-6 of that
FEAT). See that README's "Resume behavior" section for the full writeup;
the short version:

```
bun scripts/eval/locomo/run.mts --resume .eval-data/locomo/runs/<timestamp> \
  --n 10 --seed 42 --shards 2
```

Pass the same `--dataset`/`--seed`/`--n`/`--qa-per-sample`/`--shards` flags
as the original invocation. Each shard's crash-safe `ingest-ledger.jsonl`
(written as each session completes, not batched to end-of-phase like
`ingest-manifest.json`) is what makes the resume exactly-once rather than
merely idempotency-key-safe. `--dry-run-throughput` does not support
`--resume`.

Two more files appear in the run dir on EVERY invocation, resume or not:
the per-shard `ingest-ledger.jsonl` above and a top-level `run-params.json`
recording the sampling flags the run dir was created with. **`--resume`
REFUSES (non-zero exit, not a warning) to proceed if the re-derived flags
don't match `run-params.json`** — a smaller `--n` under the same seed
produces a sample that is a strict subset of a larger original one (same
seeded-shuffle-then-slice reasoning as `sampleStratified`), so a mismatched
`--resume` would otherwise silently complete a scope-narrowed run that
looks fully successful instead of erroring. A run dir with no
`run-params.json` (predates this guard) also refuses. No override flag —
start a fresh run dir for different params. Implementation:
`../shared/run-params.ts`'s `evaluateResumeGuard`, identical to
`../longmemeval/run-smoke.mts`'s (see that README's "Resume behavior"
section for the full writeup).

## Detached execution, status, and the PID/port manifest

`run.mts --detach` / `--status <run-dir>` and the `daemon-manifest.json`
PID/port manifest (FEAT-462 slice B) are identical mechanism and flag
surface to `../longmemeval/run-smoke.mts`'s — same shared
`../shared/detach.ts` / `../shared/run-status.ts` / `../shared/daemon-manifest.ts`
modules. See that README's "Detached execution, status, and the PID/port
manifest" section for the full writeup; the short version:

```
bun scripts/eval/locomo/run.mts --detach --shards 2
bun scripts/eval/locomo/run.mts --status .eval-data/locomo/runs/<timestamp>
```

`run-status.json` and `daemon-manifest.json` appear in the run dir on
EVERY invocation, `--detach` or not. `killManifestDaemons`'s PID-reuse
identity guard (confirms a manifest pid still owns its recorded port via
`netstat`/`lsof` before signaling anything, skip-by-default on ambiguity)
is identical too — see that README's writeup for the full rationale.

## "My detached run looks stuck" — operator playbook

Identical steps to `../longmemeval/run-smoke.mts`'s playbook — see that
README's "My detached run looks stuck" section for the full walkthrough
(check `--status`, inspect `run-status.json`/`daemon-manifest.json`, scoped
kill, `--resume`). Substituting this harness's paths:

```powershell
bun scripts/eval/locomo/run.mts --status .eval-data/locomo/runs/<timestamp>
bun scripts/eval/shared/kill-run.mts .eval-data/locomo/runs/<timestamp>
bun scripts/eval/locomo/run.mts --resume .eval-data/locomo/runs/<timestamp> --shards 2 --detach
```

## Reproducibility — what to pin before publishing a number

Per the FEAT's architecture note, a published LoCoMo number needs more than
just dataset/seed/model:

- dataset sha256 (hash `.eval-data/locomo/locomo10.json` at run time —
  upstream doesn't version-tag the file, so a hash is the only stable
  provenance anchor)
- daemon package version **and** git SHA (not just the npm version — see
  `run-manifest.json`'s config block; cross-reference against `git rev-parse
  HEAD` at run time)
- the judge model's actual snapshot id, not a deployment alias (e.g. Azure's
  `gpt-5-mini` deployment resolves to a specific dated snapshot — record
  what `../shared/config.ts`'s `resolveAzureConfig()` actually hit, not just
  the deployment name string)
- the full effective `config.yaml` the eval daemon booted with (the
  isolated sandbox writes a minimal override — see `../shared/spawn-daemon.ts`)
- `--llm-judge` on or off, and if on, its own judge model snapshot separately
  from the answerer's

This harness doesn't auto-generate that manifest yet (no run has been
published from this repo) — `run-manifest.json` already carries most of the
mechanical fields (config, counts, timings); a repro doc under `docs/eval/`
should be written alongside the first real published run, not speculatively
ahead of one.

## Tests

`lib/dates.test.ts`, `lib/dataset.test.ts`, `lib/envelope.test.ts`,
`judge/porter-stemmer.test.ts`, `judge/metrics.test.ts`, `sample.test.ts` —
all pure-function / fixture-based, no live Ollama, no live Azure, no network
(sampler tests use a synthetic in-memory dataset, never the real download).
`run.mts` itself (like `../longmemeval/run-smoke.mts`) has no unit test —
it's a top-level orchestrator script meant to be run, not imported; its
component functions (`ingestConversations`, `waitForSamplesDistilled`,
`answerConversations`) are each independently testable but the orchestration
logic itself is only exercised by an actual run.
