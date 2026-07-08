# extraction-bench

Extraction-quality + speed benchmark for astramemory-local's distill pipeline
(`src/distill/pipeline.ts`, stages 01-cleanup -> 08-embed-index — this bench
only needs stages 1-7, since atom quality is fully decided before stage 8's
embed+index). Answers: **which local Ollama extraction model (or the Azure
API reference) produces the best typed-atom extraction**, given the current
production default is `qwen2.5-coder:7b`.

## What it measures

For each candidate model, every gold fixture is run through the real
extraction stage (`src/distill/stages/05-extract.ts`, same prompt/schema as
production — `src/distill/prompts/extract.ts`), and the resulting atoms are
judged against a hand-authored gold answer key by Azure gpt-5-mini
(`reasoning_effort: minimal`). Per fixture: **recall** (gold atoms
semantically captured), **precision** (fraction of extracted atoms that
aren't junk/hallucinated/trivial), **type accuracy** (matched atoms with the
correct `type`), and — for the one fixture with nothing worth remembering —
an **over-extraction count**. Aggregated per model: recall / precision / F1 /
junk-rate / avg wall-clock per session.

`llm.compaction` is held constant at `ollama/qwen2.5-coder:7b` (the current
production default) for every candidate — only `llm.extraction.model` varies.
This isolates "which model extracts atoms best" as the one variable under
test; letting compaction vary too would confound the comparison.

## Layout

```
fixtures/            15 gold transcript fixtures (JSON) — see "Fixtures" below
lib/
  fixtures.ts           fixture types + loader
  daemon-runner.ts       Ollama candidates: real daemon HTTP path
  pipeline-direct.ts     Azure gpt-5-mini reference: in-process pipeline path
  azure-reasoning-provider.ts   LLMProvider adapter for gpt-5-mini (see below)
  judge.ts               Azure gpt-5-mini semantic judge
  bun-sqlite.d.ts        ambient type decl for bun:sqlite (no bun-types installed)
run-bench.mts         CLI entry point
results/              output dir (results.json + report.md per run)
```

Reuses `scripts/eval/longmemeval/lib/spawn-daemon.ts` (isolated daemon spawn +
env sandboxing) and `lib/azure-client.ts` / `lib/config.ts` (Azure OpenAI
client + key resolution via `az` CLI) rather than re-deriving them. Nothing
under `scripts/eval/longmemeval/` was modified — only imported.

## Running it

```
bun scripts/eval/extraction-bench/run-bench.mts --models qwen2.5-coder:7b,llama3.1:8b,azure:gpt-5-mini
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

Each run writes `results.json` (full detail: every extracted atom + judge
verdict, per fixture, per model) and `report.md` (the ranked summary table)
to `--out-dir`.

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
`scripts/eval/longmemeval/lib/azure-client.ts`'s `azureChatComplete` (already
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

15 synthetic Claude-Code-style sessions, each a JSON file with `turns`
(the transcript) and `gold_atoms` (the hand-authored answer key: the
facts/decisions/lessons/commands/todos/notes/events a perfect extractor
should produce). Difficulty spread:

| Fixture | Difficulty | Tests |
|---|---|---|
| fx01-clean-decision | clean | baseline — decision-dense, no noise |
| fx02-debugging-race-condition | clean | debug session: symptom -> root cause -> fix -> todo |
| fx03-refactor-extract-module | clean | captures an explicit *non-action* ("leave X alone") correctly |
| fx04-deploy-incident | clean | incident response: event -> lesson -> rollback -> fix |
| fx05-config-decision | clean | "decided NOT to change X" — don't invent a config change that didn't happen |
| fx06-tool-failure-permission | clean | tool failure -> root cause -> fix -> verification |
| fx07-noisy-tool-spam | **noisy** | long runs of near-identical tool-output lines — tests junk/duplicate resistance |
| fx08-long-multitopic | **long** | three unrelated topics in one session — tests attribution, not conflating topics |
| fx09-nothing-worth-remembering | **nothing** | zero gold atoms — any output is an over-extraction false positive |
| fx10-contradiction-correction | **contradiction** | a decision is proposed then explicitly reverted mid-session — must capture the FINAL value, not the stale one |
| fx11-todo-heavy | todo-heavy | many pending items + a late reprioritization |
| fx12-command-heavy | command-heavy | multi-step shell command sequences |
| fx13-entity-rich | entity-rich | many named products/orgs/people in one session |
| fx14-secrets-present | secrets | contains a fake API key — extractor must skip the secret itself (per its own prompt rule) while still capturing the incident lesson |
| fx15-short-ambiguous | ambiguous | very low-signal musing — tests restraint / confidence calibration |

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
- Ollama model-reload latency (see `scripts/eval/longmemeval/lib/ollama-
  tuning.ts`'s guidance) can spike an individual fixture's wall-clock if the
  model was unloaded between runs — set `OLLAMA_KEEP_ALIVE=-1` for stable
  timing comparisons across a multi-model run.
- The judge itself is an LLM (gpt-5-mini) — it can occasionally misjudge a
  borderline semantic match. `results.json` retains every raw verdict +
  reason so a spot-check is always possible without re-running anything.
