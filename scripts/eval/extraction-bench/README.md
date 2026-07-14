# extraction-bench

Extraction-quality + speed benchmark for astramemory-local's distill pipeline
(`src/distill/pipeline.ts`, stages 01-cleanup -> 08-embed-index — this bench
only needs stages 1-7, since atom quality is fully decided before stage 8's
embed+index). Answers: **which local Ollama extraction model (or the Azure
API reference) produces the best typed-atom extraction**, given the current
production default is `qwen3.5:4b` (2026-07-14 — it beats `qwen3:8b` on F1
68 vs 65 and recall 54 vs 48, and unlike `qwen3:8b` it actually fits an 8 GB
card: 3292 MB vs 5896 MB resident; see "What it measures" below).

## What it measures

For each candidate model, every gold fixture is run through the real
extraction stage (`src/distill/stages/05-extract.ts`, same prompt/schema as
production — `src/distill/prompts/extract.ts`), and the resulting atoms are
judged against a hand-authored gold answer key by Azure gpt-5-mini
(`reasoning_effort: low` by default — see "Statistical reliability" below).
Per fixture: **recall** (gold atoms semantically captured), **precision**
(fraction of extracted atoms that aren't junk/hallucinated/trivial), **type
accuracy** (matched atoms with the correct `type`), and — for the fixtures
with nothing worth remembering — an **over-extraction count**. Aggregated
per model: recall / precision / F1 / junk-rate / avg wall-clock per session,
optionally as **mean ± stdev across N runs** with `--runs N` (FEAT-450).

`llm.compaction` is held constant (default `ollama/qwen3.5:4b`, the current
production default — overridable via `--compaction-model`, see
`lib/daemon-runner.ts`'s `DEFAULT_COMPACTION_MODEL`) for every candidate —
only `llm.extraction.model` varies. This isolates "which model extracts atoms
best" as the one variable under test; letting compaction vary too would
confound the comparison. (Until #264, this defaulted to `qwen3:8b` — the
known-broken model on 8GB-class VRAM — which silently confounded any run
that didn't pass `--compaction-model` explicitly.)

## Layout

```
fixtures/            42 gold transcript fixtures (JSON) — see "Fixtures" below
lib/
  fixtures.ts           fixture types + loader
  daemon-runner.ts       Ollama candidates: real daemon HTTP path
  pipeline-direct.ts     Azure gpt-5-mini reference: in-process pipeline path
  azure-reasoning-provider.ts   LLMProvider adapter for gpt-5-mini (see below)
  judge.ts               Azure gpt-5-mini semantic judge + self-agreement (FEAT-450)
  report.ts              aggregation, multi-run combine, markdown rendering (FEAT-450) + report.test.ts
  bun-sqlite.d.ts        ambient type decl for bun:sqlite (no bun-types installed)
run-bench.mts         CLI entry point
results/              output dir (results.json + report.md per run)

../shared/stats.ts      mean/stdev/noise-floor/significance math (FEAT-450) +
                        stats.test.ts — promoted out of this tree (FEAT-457
                        slice 1) so scripts/eval/locomo/'s judge layer can
                        reuse the identical math instead of a duplicate impl;
                        this harness still imports the same single file.
```

Reuses `scripts/eval/shared/spawn-daemon.ts` (isolated daemon spawn +
env sandboxing) and `lib/azure-client.ts` / `lib/config.ts` (Azure OpenAI
client + key resolution via `az` CLI) rather than re-deriving them. Nothing
under `scripts/eval/longmemeval/` was modified — only imported.

## Running it

```
bun scripts/eval/extraction-bench/run-bench.mts --models qwen2.5-coder:7b,llama3.1:8b,azure:gpt-5-mini
```

Multi-run (FEAT-450 — see "Statistical reliability" below):

```
bun scripts/eval/extraction-bench/run-bench.mts --models qwen2.5-coder:7b,llama3.1:8b --runs 5
```

Flags:
- `--models` (required): comma-separated list. A bare Ollama tag
  (`qwen2.5-coder:7b`, `phi4-mini`, ...) runs the **daemon HTTP path** — a
  fully isolated daemon is spawned, every fixture is ingested via the real
  `POST /ingest/transcript`, and `GET /sessions/:id/digest` is polled until
  `ready` (success), `partial` (failure — at least one distill job
  permanently poisoned), or a per-session timeout. `azure:<deployment>`
  (currently only `azure:gpt-5-mini` is meaningful — see below) runs the
  **direct in-process pipeline path** instead.
- `--per-session-timeout-ms` (default `180000`): per-fixture digest-poll
  timeout for the daemon path.
- `--fixtures-dir`: override the fixture directory (useful for a quick
  smoke test against a 1-2 fixture subset before a full paid run).
- `--out-dir`: override the output directory (default
  `results/<ISO timestamp>/`).
- `--skip-judge`: run extraction only, skip the Azure judge call entirely —
  zero Azure spend, useful to sanity-check a new model's plumbing/latency
  before paying for scoring.
- `--runs N` (default `1`, FEAT-450): re-run extraction+judging N times per
  model. `N=1` is byte-for-byte the original single-run report shape. `N>1`
  reports **mean ± stdev** for recall/precision/F1/type-accuracy in the
  table, retains every raw per-run aggregate (`.runs[]` in `results.json`),
  and adds a pairwise **Significance (F1)** section to `report.md` that
  labels a cross-model F1 delta "within noise / not significant" unless it
  exceeds a noise floor derived from the observed stdevs (2×
  standard-error-of-the-difference — see `../shared/stats.ts`'s `compareMeans`).
- `--judge-reasoning-effort <minimal|low|medium|high>` (default `low`,
  FEAT-450): reasoning effort for the Azure judge call. Raised from the
  original hardcoded `minimal` to cut judge-sampling noise (AC-4).
- `--judge-agreement-fixtures N` (default `2`) / `--judge-agreement-repeats N`
  (default `3`) / `--skip-judge-agreement` (FEAT-450): after all models
  finish, re-judges the SAME (first model, first run) extracted-atom set for
  the first N fixtures, `--judge-agreement-repeats` times each, with nothing
  about the atoms changing between repeats — any variance in that block is
  JUDGE noise specifically (not model/extraction noise), and is reported in
  a "Judge self-agreement" section plus `judge-agreement.json`. Set repeats
  below 2 (or pass `--skip-judge-agreement`) to skip this and save a handful
  of extra judge calls.

Each run writes `results.json` (full detail: every extracted atom + judge
verdict, per fixture, per model — always the same top-level shape, a plain
array of per-model reports, regardless of `--runs`) and `report.md` (the
ranked summary table) to `--out-dir`. With `--runs` > 1 and judge
self-agreement enabled, `judge-agreement.json` is also written.

### Statistical reliability (FEAT-450)

Before FEAT-450, every config here was run **once**, over 15 fixtures,
judged by a single non-deterministic `gpt-5-mini` call
(`reasoning_effort=minimal`). Real evidence from 2026-07-09: `qwen2.5:7b`
scored F1 = 50/53/58/59/61/61/67/72 across 8 near-identical-config runs —
a sample stdev of **~7.1 F1 points** (≈14-point peak-to-peak swing), enough
noise to swallow every prompt-v1/v2/v2.1 and temperature-0/0.1 delta tested
that day. That number is this bench's **15-fixture baseline stdev** — see
"Known limitations" for what changed and what still needs a live re-measure
on the (now 40+ fixture) set to confirm the reduction empirically.

`--runs N` (N≥2) turns that into a measured mean±stdev instead of a single
noisy sample, and the Significance section refuses to rank two configs
whose means don't clear the noise floor. Use `--runs 3` to `--runs 5` for
real prompt/temp/model tuning decisions; `--runs 1` (default) is still fine
for a quick sanity/smoke pass.

## Why gpt-5-mini needs a different code path than the Ollama candidates

The daemon's own `src/providers/llm/azure-openai.ts` unconditionally sends
`temperature` and `max_tokens` on every `chat()` call (see the `extract()` /
`compact()` stage call sites, which always pass both). Verified **live**
against the real deployment:

```
curl .../chat/completions -d '{"messages":[...],"temperature":0.1,"max_tokens":50}'
-> HTTP 400 {"error":{"message":"Unsupported parameter: 'max_tokens' is not
   supported with this model. Use 'max_completion_tokens' instead.", ...}}
```

`gpt-5-mini` is a reasoning model: it requires `max_completion_tokens` (not
`max_tokens`) and rejects a `temperature` override entirely. This is a
genuine, pre-existing gap in the daemon's azure-openai provider — not
something specific to this benchmark, and out of scope to fix here (task
scope is "no src/ changes"). Practical effect: pointing
`config.llm.extraction` at `{provider: azure-openai, model: gpt-5-mini}` and
driving it through the daemon (like the Ollama candidates) fails on every
extract call.

`lib/pipeline-direct.ts` works around this by running the **exact same real
stage functions** (`cleanup` -> `normalize` -> `chunk` -> `compact` ->
`extract` -> `reduce` -> `memoryNormalize`, plus the real redaction stage and
`flattenTranscriptContent`) in-process, swapping only the transport for
`lib/azure-reasoning-provider.ts` — an `LLMProvider` adapter that reuses
`scripts/eval/shared/azure-client.ts`'s `azureChatComplete` (already
correct: no `temperature`, `max_completion_tokens`, `reasoning_effort`).
Everything except the HTTP/job-queue/storage layer (stage 8, which this bench
doesn't need) is the identical production code path. If the daemon's Azure
provider is ever fixed to support reasoning models, `azure:gpt-5-mini` could
move onto the same `daemon-runner.ts` path as the Ollama candidates with no
change to the fixtures or scoring.

One more Bun-specific wrinkle: `pipeline-direct.ts`'s throwaway
`BudgetTracker` table uses `bun:sqlite`, not
`better-sqlite3-multiple-ciphers` — per CLAUDE.md, better-sqlite3 (multiple-
ciphers included) is not supported under Bun, and this whole toolchain runs
under `bun` (matching `scripts/eval/longmemeval`'s convention). `bun:sqlite`
is API-compatible for the handful of calls `BudgetTracker` actually makes.

## Fixtures

42 synthetic Claude-Code-style sessions (expanded from the original 15 —
FEAT-450 AC-3, more per-difficulty replicates to shrink per-run F1
variance), each a JSON file with `turns` (the transcript) and `gold_atoms`
(the hand-authored answer key: the facts/decisions/lessons/commands/todos/
notes/events a perfect extractor should produce). Difficulty spread across
all 42 (original 15 + 27 new, same tag set, roughly proportional counts):

| Difficulty | Count | Tests |
|---|---|---|
| clean | 19 | baseline decision-dense/debug/refactor/deploy/config/tool-failure sessions, no noise |
| noisy | 3 | long runs of near-identical tool/build-log/health-check output — junk/duplicate resistance |
| long | 4 | three+ unrelated topics in one session — attribution, not conflating topics |
| nothing | 3 | zero gold atoms — any output is an over-extraction false positive |
| contradiction | 3 | a decision/value is proposed then explicitly reverted mid-session — must capture the FINAL value |
| todo-heavy | 2 | many pending items + a late reprioritization |
| command-heavy | 2 | multi-step shell/db command sequences |
| entity-rich | 2 | many named products/orgs/people/vendors in one session |
| secrets | 2 | contains a fake secret — extractor must skip the secret itself while still capturing the incident lesson |
| ambiguous | 2 | very low-signal musing — tests restraint / confidence calibration |

The original 15 (`fx01`-`fx15`) are listed individually in git history / the
pre-FEAT-450 README revision; `fx16`-`fx42` follow the identical schema and
difficulty tags (see file names in `fixtures/` — each is self-descriptive,
e.g. `fx32-contradiction-port-number.json`, `fx37-secrets-present-webhook-
secret.json`). No loader changes were needed — `lib/fixtures.ts` already
picks up every `*.json` file in the directory.

### Adding a gold transcript

1. Add `scripts/eval/extraction-bench/fixtures/fxNN-slug.json` with:
   ```json
   {
     "id": "fxNN-slug",
     "title": "...",
     "difficulty": "clean|noisy|long|nothing|contradiction|...",
     "notes": "what this fixture is specifically testing",
     "turns": [{ "role": "user", "text": "..." }, { "role": "assistant", "text": "..." }],
     "gold_atoms": [{ "type": "decision", "text": "..." }]
   }
   ```
2. `type` must be one of the 7 values in `src/distill/prompts/extract.ts`'s
   `AtomSchema`: `decision | fact | lesson | command | todo | note | event`.
3. No loader registration needed — `lib/fixtures.ts` picks up every `*.json`
   file in `fixtures/` automatically.
4. Gold atom `text` should be the durable claim in your own words — the judge
   matches semantically, not by string equality, so paraphrasing an
   extractor's output is expected and fine.

### Adding a model

- **Ollama model already pulled**: just add its tag to `--models`, e.g.
  `--models qwen2.5-coder:7b,phi4-mini`. No code changes.
- **Ollama model not yet pulled**: `ollama pull <tag>` first, then add it to
  `--models` the same way.
- **A different Azure deployment**: `--models azure:<deployment-name>` runs
  it through `pipeline-direct.ts` — works for any reasoning-model deployment
  (uses `max_completion_tokens` + `reasoning_effort`, no `temperature`). For a
  non-reasoning Azure deployment (accepts `temperature`/`max_tokens`
  normally), it would need its own small adapter or could go straight through
  `daemon-runner.ts`-style HTTP once pointed at `azure-openai` in config —
  not implemented here since the team's minimal-spend instruction was
  gpt-5-mini only.
- **A template-fill specialist model (not chat/instruct)**: NuExtract is
  trained on one fixed `<|input|>/### Template:/### Text:/<|output|>` shape,
  not a system-prompt + free-text instruction paradigm. Confirmed live
  (2026-07-08): feeding it the real `EXTRACTION_SYSTEM_PROMPT` through the
  standard daemon path poisons every fixture (0 atoms, invalid JSON). Use
  `--models nuextract:adapted` instead — this routes through
  `lib/nuextract-adapter-provider.ts` (direct pipeline path), which reshapes
  the atom schema as a NuExtract template, adds a stop-sequence to prevent
  the model echoing another copy of the template after its own output
  marker, and fills a fixed importance/confidence default (NuExtract has no
  basis to invent a 0-1 score for a field not literally present in the
  source text — it's a span-extraction model). Labelled "adapted prompt" in
  the report table since it isn't judged on the identical verbatim prompt
  every other candidate gets. Even with the adapter fixing the crash,
  2026-07-08's full run scored 0% recall across all 15 fixtures — see
  "Known limitations" below for why.

## Excluded models (2026-07-08, user decision)

- `llama3.1:8b` — ~3x slower than qwen2.5-coder:7b for similar quality in
  the 2026-07-08 baseline run (`results/real-run-2026-07-08/`); not worth the
  latency cost as a local-default candidate.
- Anything above 9B parameters — this machine's practical ceiling for a
  background local daemon process (`qwen2.5-coder:14b`, `qwen3.5:9b`,
  `gemma4` and similar were not benched for this reason).

## Known limitations

- `04-compact.ts`'s `COMPACT_SYSTEM` instructs "Output plain text only" but
  `qwen2.5-coder:7b` (the fixed compaction model for every candidate) was
  observed, on some chunks during the 2026-07-08 A/B run, to instead emit a
  JSON blob (e.g. `{"db_type": "SQLite", ...}`) despite that instruction.
  General chat/instruct models tolerate this malformed "plain text" input
  fine at the extraction step; NuExtract's narrow span-matching does not
  (confirmed via direct reproduction) — a contributing factor, on top of the
  template-paradigm mismatch, to `nuextract:adapted`'s 0% recall. This is a
  pre-existing compaction-stage quirk that affects every candidate equally
  (out of scope to fix as part of this bench — flagged here for whoever
  looks at compaction quality next).
- Atoms sourced from the daemon path carry only `{id, type, text}` (that's
  all `GET /sessions/:id/digest` exposes — see
  `src/server/queries/provenance.ts`'s `DigestMemRow`); atoms from the direct
  path additionally carry `importance`/`confidence`. Scoring only uses
  `type`+`text`, so this doesn't affect recall/precision/type-accuracy, but
  it means importance/confidence calibration isn't compared across paths.
- The daemon path's per-session wall-clock includes HTTP + job-queue-poll
  overhead (750ms poll interval), not just raw LLM latency — this is
  deliberate (it's what a real caller of `/ingest/transcript` actually
  experiences), but it means daemon-path and direct-path timings aren't
  perfectly apples-to-apples; treat cross-model *ranking* as reliable and
  absolute-latency comparisons between the two paths as approximate.
- Ollama model-reload latency (see `scripts/eval/shared/ollama-
  tuning.ts`'s guidance) can spike an individual fixture's wall-clock if the
  model was unloaded between runs — set `OLLAMA_KEEP_ALIVE=-1` for stable
  timing comparisons across a multi-model run.
- The judge itself is an LLM (gpt-5-mini) — it can occasionally misjudge a
  borderline semantic match. `results.json` retains every raw verdict +
  reason so a spot-check is always possible without re-running anything.
  FEAT-450 raised the default judge `reasoning_effort` from `minimal` to
  `low` and added `--judge-agreement-fixtures`/`--judge-agreement-repeats`
  to directly measure this specific noise source (same atoms, re-judged) —
  see "Statistical reliability" above.
- FEAT-450's fixture expansion (15 -> 42) and the `--runs`/judge-effort
  changes were verified via `bunx tsc --noEmit` on every touched file plus
  `lib/stats.test.ts` + `lib/report.test.ts` (synthetic mean/stdev/
  significance-gate math, including a case reproducing the exact
  50/53/58/59/61/61/67/72 qwen2.5:7b noise band from the 2026-07-09 triage
  note). A live multi-model `--runs N` sweep against Ollama + the Azure
  judge to *measure* the new 42-fixture F1 stdev and confirm it is lower
  than the 15-fixture baseline (~7.1 F1 points) was **not** run as part of
  this slice (full sweep is slow/costly and out of this change's verification
  budget) — that live comparison is the one remaining step to fully close
  AC-3 empirically; the mechanism to produce it (`--runs 8` on a fixed model
  against the new fixture set) is in place and unit-tested.
