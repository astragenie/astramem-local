# LongMemEval adapter for astramemory-local

Phase 1 (50-question stratified smoke run) of the plan in
[`docs/eval/longmemeval-plan.md`](../../../docs/eval/longmemeval-plan.md).
Read that doc first — it's the spec this adapter implements. This README is
the "how do I actually run it" companion, plus the things discovered while
building it that the plan doc couldn't have known in advance.

## Layout

```
scripts/eval/
  shared/                  plumbing shared with every eval harness under scripts/eval/
                           (extracted here FEAT-457 so LoCoMo reuses it verbatim — see
                           scripts/eval/locomo/README.md)
    daemon-client.ts       fetch wrappers for /ingest/transcript, /recall, /sessions/:id/digest, /health
    spawn-daemon.ts        spawns an ISOLATED throwaway daemon (see "Isolation" below)
    azure-client.ts        Azure OpenAI chat-completions (plain fetch, no SDK dependency)
    config.ts              Azure endpoint/deployment/key resolution (az cli fallback)
    concurrency.ts         tiny bounded-concurrency map helper
    shard.ts               round-robin item partitioning across N daemon shards
    ollama-tuning.ts       Ollama server status query (/api/version, /api/ps) + tuning guidance
  longmemeval/
    lib/
      types.ts             dataset + hypothesis record shapes
      dates.ts             "YYYY/MM/DD (Dow) HH:MM" -> ISO-8601 UTC
      dataset.ts           loader + deterministic stratified sampler
      envelope.ts          haystack session -> canonical /ingest/transcript envelope
    sample.mts             CLI: stratified sampler
    ingest.mts             CLI + module: haystack -> /ingest/transcript driver
    distill-wait.mts       CLI + module: poll /sessions/:id/digest until ready
    answer.mts             CLI + module: /recall -> Azure gpt-5-mini -> hypotheses.jsonl
    run-smoke.mts          orchestrator: sample -> daemon(s) -> ingest -> wait -> answer -> manifest
                           (single-daemon by default; `--shards N` runs N isolated daemons
                           concurrently and merges the results — see "Sharding" below; also
                           hosts `--dry-run-throughput`, a standalone throughput measurement mode)
    judge.mts              orchestrator: clone upstream (pristine) -> run Azure judge fork -> metrics
    judge/
      evaluate_qa_azure.py Azure-aware fork of upstream's evaluate_qa.py (see its header)
      metrics.mts          our own per-type/overall/abstention aggregator
```

Everything runs directly under `bun` (no build step) — this is a one-shot
eval harness, not part of the daemon's own `tsc -p .` build, and is not
imported by anything under `src/`.

## Run real smoke/full runs from a plain terminal, NOT from inside a coding-agent sandbox

**Verified live (2026-07-08): a coding-agent sandbox session on this machine
silently killed a spawned daemon process partway through a real multi-hour
`--shards 2` distill run, with no trace anywhere.** Reproduced 3 times in a
row with the same shape: the shard with the heavier workload died while the
lighter shard kept running fine. What ruled out an application bug:

- No `FATAL <kind>: <err>` line anywhere in the daemon's own captured
  stdout/stderr (that's what `serve.ts`'s `uncaughtException`/
  `unhandledRejection` handler prints before its own `process.exit(1)` — see
  `src/cli/serve.ts` — so this is not that).
- The daemon's own logs show completely normal `200 OK` request handling
  right up to the very last logged line, then instant silence — no error, no
  warning beyond the expected "encryption disabled" notice at boot.
- No Windows Application-Error crash dump and no System-log event at the
  time of death (ruled out via `Get-WinEvent`) — a native fault or a normal
  OS-visible kill would show up in one of those.
- The child process handle's own `exit` event never fired (checked via
  `DaemonHandle.exitInfo()` — see `../shared/spawn-daemon.ts`), yet the process
  was later confirmed gone from `Get-CimInstance Win32_Process`.
- Separately, in an earlier attempt the same session, an entire `nohup ... &`
  detached background process TREE (including the orchestrating `bun`
  process itself, not just a child daemon) was silently killed the moment
  the synchronous shell tool call that launched it returned — a different,
  even more direct demonstration that this environment reaps background
  process trees under conditions the daemon/harness code has no control
  over and cannot detect from inside.

That combination points at the coding-agent sandbox's own background-process
governance (most likely a resource-pressure-triggered reap — the heavier
workload died first both times, and this machine's free RAM was thin
throughout), not a defect in `astramemory-local` or in this harness.

**Practical consequence: don't trust a real (multi-minute-plus) smoke or full
run's outcome if it was launched from inside a coding-agent tool call**,
sandboxed shell, or similar automation layer that might reap background
process trees. Launch it from a plain interactive terminal you control
instead:

```powershell
# Plain PowerShell/cmd window you opened yourself, NOT a coding-agent's shell tool.
# Runs in the foreground so you can see progress; leave the window open for
# the whole run (see the Throughput section for how long that actually is).
cd C:\work\mega\astramemory-local
bun scripts/eval/longmemeval/run-smoke.mts --shards 2
```

If you need it to survive closing the terminal/logging off, use a genuinely
detached OS mechanism instead of a coding-agent's background shell —
e.g. Windows Task Scheduler (`schtasks /create ...` running the same `bun`
command, one-time trigger) or `Start-Process -WindowStyle Hidden` from a
terminal you started yourself, not from inside an agent session.

## Quick start

```powershell
# 1. Build the daemon if dist/ is missing or stale
bun install
bun run build

# 2. Draw the stratified 50-question smoke sample + run the whole phase-1 pipeline
bun run eval:longmemeval:smoke

# 2b. Same thing, sharded across 2 isolated daemons sharing your one local Ollama
bun scripts/eval/longmemeval/run-smoke.mts --shards 2

# 3. Judge the resulting hypotheses (cheap judge by default)
bun run eval:longmemeval:judge -- --hyp .eval-data/longmemeval/runs/<timestamp>/hypotheses.jsonl --ref .eval-data/longmemeval/longmemeval_s_cleaned.json
```

`run-smoke.mts` writes everything under
`.eval-data/longmemeval/runs/<ISO-timestamp>/`: `sample.json`,
`ingest-manifest.json`, `distill-wait-result.json`, `hypotheses.jsonl`,
`run-manifest.json` (config + counts + per-stage timings, plus
`per_shard_timings` and `failed_shards` when `--shards` > 1). `.eval-data/` is
already `.gitignore`d.

Useful flags on `run-smoke.mts` (all optional):

| flag | default | meaning |
|---|---|---|
| `--n` | 50 | sample size |
| `--seed` | 42 | sampler seed (same seed+n+dataset = same sample, always) |
| `--k` | 10 | recall `limit` |
| `--concurrency` | 4 | parallel `/ingest/transcript` calls within each shard/daemon |
| `--shards` | 1 | number of isolated daemons to spread the sample across (round-robin by question_id) — see "Sharding" below |
| `--distill-timeout-ms` | 900000 (15 min) | **see the throughput section below — this default is almost certainly too low for a real 50-question run; measure first, then raise it** |
| `--run-dir` | `.eval-data/longmemeval/runs/<timestamp>` | override output location |
| `--ollama-url` | `http://127.0.0.1:11434` (or `$OLLAMA_HOST`) | where to query Ollama's `/api/version` + `/api/ps` for the tuning-guidance printout |

## Sharding (`--shards N`)

Per the plan doc's section 4 lever 2 ("parallel daemon instances ... shard
the questions across them"), `run-smoke.mts --shards N` round-robin-
partitions the sampled questions (`lib/shard.ts`) across `N` fully isolated
daemons — each gets its own ephemeral port and its own sandboxed
APPDATA/LOCALAPPDATA/HOME (the same `makeIsolatedEvalEnv` machinery
described under "Isolation" below, invoked once per shard) — and runs
ingest -> distill-wait -> answer concurrently across all `N`, via
`Promise.allSettled` so one shard's daemon dying doesn't lose the others'
results. Outputs are merged back into the single top-level
`ingest-manifest.json` / `distill-wait-result.json` / `hypotheses.jsonl` /
`run-manifest.json` you'd get from an unsharded run — `hypotheses.jsonl` is
re-sorted to the original sample order before writing, so a sharded run's
output is a drop-in replacement for `judge.mts`'s `--hyp` input. Each shard
additionally gets its own
`runDir/shard-N/{ingest-manifest,distill-wait-result}.json` for per-shard
debugging. If a shard's daemon crashes mid-run, its questions are recorded
as failed/timed-out in the merged output (not silently dropped) and the
run's exit code is non-zero, matching how a single-daemon ingest failure or
distill timeout is already reported.

**Sharding is not a free lunch.** All shards share the ONE local Ollama
server — see "Ollama server tuning" below. With Ollama's default
`OLLAMA_NUM_PARALLEL` (effectively 1 concurrent generate/embed slot per
model), N daemons hammering the same Ollama server mostly just interleaves
the same total work through one queue rather than truly parallelizing it;
real wall-clock speedup requires raising `OLLAMA_NUM_PARALLEL` on the Ollama
server itself (not on this harness).

Run `--dry-run-throughput` (next section) to measure your own actual N-shard
speedup before committing hours to a real sharded run.

## `--dry-run-throughput` — measure N-shard speedup before committing hours

```powershell
# Ingest+distill (no answer/judge step) a couple of real sampled questions,
# measured live on --shards 2, compared against the already-documented
# single-thread baseline (README "Throughput" section further down). Prints
# a sessions/hour table + 50q/500q extrapolation.
bun scripts/eval/longmemeval/run-smoke.mts --dry-run-throughput --shards 2

# Also re-measure the shards=1 baseline live instead of citing the README
# number (roughly doubles the wall-clock of the check, since it now runs the
# same sample twice -- sequential, then sharded):
bun scripts/eval/longmemeval/run-smoke.mts --dry-run-throughput --shards 2 --dry-run-compare-baseline
```

| flag | default | meaning |
|---|---|---|
| `--dry-run-questions` | 2 | how many real questions to sample for the measurement (kept small on purpose -- this is a timing probe, not a scored run) |
| `--shards` | 1, clamped up to 2 for this mode | shard count to measure (a 1-vs-N comparison is meaningless below 2) |
| `--dry-run-compare-baseline` | off | also live-measure `--shards 1` on the same sample instead of citing the README's documented 45-60s/session range |
| `--distill-timeout-ms` | 2 hours (not the normal 15-min smoke default) | this mode runs a REAL distill to completion; raise further if your sample draws unusually large haystacks |

Writes `runDir/throughput-dry-run.json` (measured seconds/session, Ollama
status snapshots before/after, and the extrapolation inputs) instead of
hypotheses -- this mode never calls Azure or writes `hypotheses.jsonl`.

Note: the stratified sampler always guarantees at least one `_abs`
abstention question when the `single-session-user` pool has any (see
`lib/dataset.ts`'s `minAbstentionFraction` logic), so `--dry-run-questions 2`
typically draws 3 actual questions, not 2 -- this is intentional (small
samples still exercise the abstention path) and the tool's own printed
session/question counts are the authoritative ones, not the requested flag
value. A real bug was found and fixed here while building this: for small
`n` the apportion math could force `quota - wantAbs` negative, and
`Array#slice(0, negativeN)` silently pulled almost the ENTIRE
`single-session-user` pool instead of zero extra items -- `n=2` returned 66
questions before the fix (`lib/dataset.ts`, clamped to 0, verified live
2026-07-08).

## Ollama server tuning

All shards -- and the single-daemon path -- hit the ONE Ollama server on
this machine. `run-smoke.mts` (both the normal and `--dry-run-throughput`
paths) queries `/api/version` + `/api/ps` at startup and prints current
state plus setup guidance every run; the short version:

- **`OLLAMA_NUM_PARALLEL=2..4`** -- parallel request slots per loaded model.
  Without this, Ollama defaults to serializing requests, so `--shards N`
  mostly just interleaves the same total work through one queue instead of
  truly parallelizing it.
- **`OLLAMA_KEEP_ALIVE=-1`** -- never unload a model between calls. The
  default 5-minute idle-unload silently reintroduces model-load latency into
  every gap between shard bursts, which is NOT reflected in the measured
  45-60s/session baseline below.
- **Both are read by the Ollama SERVER process at its own startup** -- they
  cannot be set from this harness's shell/spawn env (verified: the daemons
  this harness spawns are astramemory-local, not Ollama itself; Ollama here
  runs as the pre-existing, independently-started Windows tray app). The
  harness only detects + prints guidance; it does not and should not try to
  kill/restart your live Ollama service.

**Windows setup** (tray app `ollama app.exe` spawns the `ollama.exe`
server):
1. Quit the Ollama tray app completely (right-click its tray icon > Quit --
   closing just the window leaves the old server process running with its
   old env).
2. Set the vars for your user account (or System vars, if elevated):
   ```powershell
   setx OLLAMA_NUM_PARALLEL 4
   setx OLLAMA_KEEP_ALIVE -1
   ```
   (`setx` only applies to **new** processes -- this is why step 1 matters.)
3. Relaunch the Ollama tray app so its server process inherits the new env.
4. Re-run `--dry-run-throughput` (or check `/api/ps`'s `expires_at` field
   directly) to confirm -- with `OLLAMA_KEEP_ALIVE=-1` the loaded models'
   `expires_at` should stop resetting to a ~5-minute-out timestamp after
   idle gaps.

The harness also snapshots `/api/ps` before/after each measured shard run
and warns (`WARNING: model(s) [...] appear to have been unloaded between
calls`) if a model that was resident beforehand is gone afterward -- that's
live evidence of a mid-run reload inflating the measured time, independent
of whatever `OLLAMA_KEEP_ALIVE` is nominally set to.

**Check your VRAM headroom before raising `OLLAMA_NUM_PARALLEL` above 1.**
Verified live on this machine (2026-07-08, `nvidia-smi`): an RTX 5060 Laptop
GPU with 8151 MiB total VRAM, already at 5681 MiB used just from the two
models this harness needs resident (`qwen2.5-coder:7b` ~4748 MiB +
`mxbai-embed-large` ~618 MiB) -- leaving only ~2219 MiB free. That is NOT
enough headroom for a second concurrent `qwen2.5-coder:7b` slot (needs
~4748 MiB by itself). On hardware this constrained, `OLLAMA_NUM_PARALLEL=2+`
will likely force the extra slot onto CPU (much slower per-call, not a
speedup) or fail outright, rather than truly parallelizing -- so `--shards N`
on THIS machine should be expected to help only marginally (network/queueing
overhead reduction, not real concurrent extraction) until run on hardware
with more VRAM headroom. Check your own GPU's free VRAM (`nvidia-smi
--query-gpu=memory.free --format=csv` on NVIDIA, Task Manager's Performance
tab on Windows generally) before assuming `OLLAMA_NUM_PARALLEL` will buy a
speedup -- this is exactly why `--dry-run-throughput` measures instead of
assumes.

## Resume behavior

- **Ingest** is resume-safe: the `Idempotency-Key` on every
  `/ingest/transcript` call is the (namespaced) `session_id` itself, and the
  body is a pure function of the dataset + that session — re-running
  `ingest.mts` against a daemon that already has some sessions replays
  those (`idempotent: true` in the outcome) instead of double-ingesting.
- **There is no cross-run resume for a whole `run-smoke.mts` invocation** —
  each run spins a fresh throwaway datadir (see Isolation below) and tears
  it down in a `finally` block even on failure. If you need to resume a
  large run that died partway, run the individual steps (`ingest.mts` ->
  `distill-wait.mts` -> `answer.mts`) by hand against a daemon you keep
  alive yourself (`node dist/cli/index.js serve --port <p>` with your own
  `ASTRA_MEMORY_DATADIR`), instead of `run-smoke.mts`'s all-in-one spawn.
- **Judging** (`judge.mts`) is idempotent in the sense that it always
  overwrites `<hyp>.eval-results-<judge>` — re-running re-judges everything,
  it does not skip already-judged rows.

## Isolation — why the eval daemon does NOT use your real config dir

**Do not remove this isolation.** While building this harness we spawned a
daemon that inherited the real `%APPDATA%\Astramem` config dir (only
`ASTRA_MEMORY_DATADIR` overridden) and discovered its `sync.json` is paired
to the **live production SaaS tenant** (`https://api.astramemory.com`) —
`resolveRuntimeConfig` merges `sync.json` over `config.yaml` regardless of
`ASTRA_MEMORY_DATADIR`. Left running, that daemon would have sync-shipped
every synthetic LongMemEval haystack session into a real cloud account.

`../shared/spawn-daemon.ts`'s `makeIsolatedEvalEnv` redirects
`APPDATA`/`LOCALAPPDATA`/`HOME`/`XDG_CONFIG_HOME`/`XDG_DATA_HOME` into a
throwaway temp sandbox for every run (same technique
`tests/smoke/helpers/daemon.ts` uses, independently authored here since
this adapter must not import test-only code). A fresh config dir has no
`sync.json` (sync defaults to `false`) and we write a minimal
`security.encryption.enabled: false` override (same reasoning as that test
helper: skip the real OS credential store too). `defaultConfig()` already
points `llm`/`embedding` at the real local Ollama models
(`qwen2.5-coder:7b` extraction/compaction, `mxbai-embed-large` embeddings),
so the eval daemon still exercises the real provider stack — only the
config/data directories and the bearer token are sandboxed, never the
model backend.

## Throughput — measured, not estimated (2026-07-08)

The plan doc's estimate (1-3s per ingest+distill round trip, dominated by
the embed call) undershoots substantially. What we actually observed across
two real isolated-daemon runs — ingesting 3 questions' full haystacks (133
sessions) and, separately, a single 39-session question run to completion —
is that ingest itself is near-instant (133 sessions posted in 167ms — it
just queues an async extraction job per session), but the **local
qwen2.5-coder:7b extraction step draining that queue is the true
bottleneck**, at roughly **45-60 seconds per session** on this machine
(`GET /health`'s `queue.completed` count sampled against elapsed wall clock
during both runs, not a guess — the single-question run measured 24
sessions completed in 1356s ≈ 56.5s/session; earlier samples across the
3-question run ranged as low as ~20s/session, so there is real variance —
treat 45-60s/session as the honest working range for this machine, not a
single constant).

Extrapolating from that measured range (using ~50s/session as a working
midpoint, single daemon instance, no parallelism):

- **50-question smoke sample** (~50/500 × ~24,500 total-dataset sessions ≈
  **2,450 sessions**): ≈ 2,450 × 50s ≈ **~34 hours single-threaded**. The
  `run-smoke.mts` default `--distill-timeout-ms 900000` (15 min) is nowhere
  near long enough for a full 50-question run at this measured rate —
  **raise it substantially (multiple hours) or, better, use
  the plan doc's §4 parallel-daemon-instance sharding before
  attempting a real 50-question run**, and expect the run to take the
  better part of two days serialized, not minutes.
- **Full 500-question LongMemEval_S** (~24,500 sessions): ≈ 24,500 × 50s ≈
  **~14 days single-threaded** — well past the high end of the plan doc's
  7-20 hour estimate, because that estimate assumed embed-call latency, not
  LLM-extraction latency, as the bottleneck. **The plan doc's §4
  parallelism levers (concurrent ingest within a question, multiple daemon
  instances sharded by question) are not optional cost-cutting for the full
  run — they are a hard prerequisite** at this measured per-session rate.
  Profile per-session latency on your own machine/GPU before committing to
  a full-run wall-clock budget; this number is specific to the local
  Ollama setup this was measured against (qwen2.5-coder:7b, CPU/GPU
  unspecified — check your own `ollama ps` during a run).

This also means **`--concurrency` on `ingest.mts`/`run-smoke.mts` bounds
concurrent HTTP POSTs, not concurrent distillation** — the daemon's own
worker drains the extraction queue at its own (single-threaded, per this
observation) pace regardless of how fast you post. Raising `--concurrency`
past what's needed to keep the queue non-empty does not speed up distill —
only the plan doc's §4 multi-daemon sharding does.

## RESOLVED (historical): `as_of` used real ingest wall-clock time instead of `captured_at`

> **STATUS UPDATE (2026-07-09): FIXED in v0.9.0 — this section is a
> historical record.** The population-side fix landed in the same PR wave
> (#135) that added this README: distill now threads the envelope's
> `captured_at` through to `valid_from` (`src/pipeline/handlers/distill.ts:108-113`,
> mirrored in the events/spool path, terminal write `src/storage/memories.ts:130`;
> CHANGELOG 0.9.0 "Fixed"). The "verified live" bisection below was run against
> a daemon binary that predated the fix — the fix commit (`079117c`) was
> authored 31 seconds before the README commit, and the running service had
> not been rebuilt/reinstalled at measurement time. **Re-verified 2026-07-09
> against a fresh v0.10.0 isolated daemon: FIX CONFIRMED** — the critical case
> (`as_of` after `captured_at`, before real ingest time) returns hits; see
> `.claude/artifacts/crew/validations/20260709T234200Z-validation-asof-population-fix.md`
> for the full bisection table. Temporal-reasoning/knowledge-update questions
> are valid to score. Legacy v0.0 envelopes (no `captured_at`) still fall back
> to wall-clock by design.

**Original finding (2026-07-08, pre-fix daemon):**
Verified live (2026-07-08) against a real completed haystack (39 sessions,
all `captured_at` dated 2023-07 through 2023-12, ingested for real on
2026-07-08): `POST /recall` with `filters.as_of` set to the question's own
`question_date` (2023-12-18, chronologically after every session in its
own haystack) returned **0 hits**, while the identical call with no
`as_of` returned 10 real hits. Bisecting further:

| `as_of` value | hit_count |
|---|---|
| (none) | 5 |
| `2023-12-18` (the question_date — what LongMemEval questions actually need) | **0** |
| `2020-01-01` (before everything) | 0 |
| `2026-07-08` (today — real ingest wall-clock date) | **0** |
| `2030-01-01` (future, past real ingest time) | 5 |

The cutover point is the **real ingestion date**, not any `captured_at`
value from the ingested content. In other words: **memories' bitemporal
`valid_from` is set from wall-clock ingest time, not from the session's
`captured_at`.** The plan doc's section 3.1 assumption — "the existing
`as_of` filter already does exactly the bitemporal-snapshot job LongMemEval
needs — no new daemon feature required, just correct `captured_at`
plumbing at ingest time" — is **false as currently implemented**. Correct
`captured_at` plumbing at ingest time (which this adapter does correctly —
see `lib/envelope.ts`) is necessary but not sufficient; nothing downstream
of ingest currently uses it for `valid_from`.

**Practical consequence**: every LongMemEval question's `question_date` and
every haystack session's `captured_at` are dataset-authored dates in the
past (this sample was all 2023) relative to whenever the harness actually
ingests them (necessarily "now"). Any question that opts into `as_of`
filtering — **temporal-reasoning (133) + knowledge-update (78) = 211 of
500 questions, 42% of the dataset** — will deterministically get 0 recall
hits and score as if abstaining, regardless of retrieval quality, for as
long as this gap exists. `answer.mts` still applies `as_of` for those two
question types per the plan doc (that part of the adapter is correct and
unchanged) — this was a daemon-side gap, not an adapter bug. **Resolved in v0.9.0 — see
the status update at the top of this section.** Re-verify the bisection
table once against a freshly-reinstalled ≥0.10.0 daemon before publishing a
temporal score.

## Known daemon-side gap: poison distill jobs report as "ready"

Observed live during the single-question verification run: `GET /health`
showed `queue: { completed: 24, pending: 15, poison: 1, running: 1 }`.
`buildSessionDigest` (`src/server/queries/provenance.ts:102-107`) only
checks `state IN ('pending', 'running')` to decide `pending` vs `ready` — a
`poison` job (permanently failed after exhausting retries) is neither, so
**a session whose distill job goes poison reports `status: 'ready'` via
`/sessions/:id/digest` even though that session's content was never
actually extracted into memories.** This is exactly the plan doc's risk #1
(silent under-count deflating the score with no visible error), just via a
different mechanism (poison jobs) than the one the plan doc anticipated
(merely-slow jobs). `distill-wait.mts` only checks digest status today, so
it would NOT catch this case — escalated to the daemon owners as a known
gap, not fixed here (out of this adapter's scope).

## Azure / reasoning-model notes

- `gpt-5-mini` (deployment `gpt-5-mini`, model snapshot `2025-08-07`) is a
  **reasoning model**: it takes `max_completion_tokens` (not `max_tokens`)
  and `reasoning_effort`, and — verified live — does **not** accept an
  explicit `temperature` override (omit it entirely; default is fine).
  `reasoning_effort: 'minimal'` keeps `reasoning_tokens: 0` in the observed
  usage breakdown, i.e. it behaves as a fixed, cheap, fast model for both
  the answerer role and the smoke-judge role — this is why the plan doc's
  instruction to pin `reasoning_effort` matters: without it, a reasoning
  model could spend an unbounded, non-deterministic number of hidden
  reasoning tokens per call, defeating the "fixed cheap model" premise the
  whole benchmark's validity depends on.
- Verified working API version: `2024-12-01-preview` against
  `https://oai-astragenie-dev-cu-c4858.openai.azure.com`.
- `gpt-4o` (final-published-numbers judge only, per the plan doc's cost
  note — don't burn it on routine smoke iterations) is Azure snapshot
  `2024-11-20`, **not** the upstream official script's hardcoded
  `gpt-4o-2024-08-06`. See the next section for why that matters.

## Judge step — two real incompatibilities with the upstream scripts

Fetched and read the actual upstream source
(`xiaowu0162/LongMemEval/src/evaluation/{evaluate_qa,print_qa_metrics}.py`,
2026-07-08) before assuming the plan doc's "call them unmodified, shim
OPENAI_BASE_URL" approach would work. It doesn't, for two concrete reasons:

1. **`evaluate_qa.py`'s `model_zoo` is hardcoded** to
   `{llama-3.1-70b-instruct, gpt-4o-mini, gpt-4o}` — it exits immediately on
   any other `metric_model_short`, so `gpt-5-mini` cannot be passed through
   at all, modified or not. It also builds a plain `OpenAI(api_key=...,
   base_url=...)` client, which does not correctly authenticate against
   Azure (Azure needs the `api-key` header and a mandatory `api-version`
   query param that `base_url`-pointing alone does not supply — you need
   `AzureOpenAI`).
2. **`print_qa_metrics.py` has a hard
   `assert entry['autoeval_label']['model'] == 'gpt-4o-2024-08-06'`** — it
   aborts on any judge run whose recorded model string isn't that exact
   OpenAI snapshot id. Since Azure's `gpt-4o` deployment here is snapshot
   `2024-11-20`, even judging with "real gpt-4o" (just via Azure, not
   OpenAI's public API) would trip this assert.

Given that, this adapter:

- Vendors `judge/evaluate_qa_azure.py`, a clearly-labeled fork of
  `evaluate_qa.py` (see its own header comment for the exact diff) that
  adds the two Azure deployment names to `model_zoo`, builds an
  `AzureOpenAI` client, and switches to reasoning-model kwargs for
  `gpt-5-mini`. Every prompt template (`get_anscheck_prompt`) and all
  scoring logic is byte-identical to upstream — only client construction
  and the reasoning-model kwargs branch differ.
- Clones the **pristine, unmodified** upstream repo to
  `.eval-data/LongMemEval/` (gitignored) purely for provenance/diffing —
  `git diff --no-index .eval-data/LongMemEval/src/evaluation/evaluate_qa.py scripts/eval/longmemeval/judge/evaluate_qa_azure.py`
  shows exactly what changed. It is never executed directly.
- Does **not** use upstream's `print_qa_metrics.py` at all (that assert
  would abort on our recorded model strings) — `judge/metrics.mts`
  reimplements its per-type/task-averaged/overall/abstention accuracy
  aggregation in TypeScript, keyed only on `autoeval_label.label`, never on
  the model string. This is the one place this adapter's numbers are
  computed by code we wrote rather than the official script — the judge
  *prompts themselves* (the part that actually defines "correct") are
  still verbatim upstream.

`judge.mts` requires `python3`/`python` on PATH (auto-installs
`openai`/`backoff`/`tqdm`/`numpy` via pip if missing) purely to run the
vendored fork — the rest of this adapter is pure TypeScript.

## Azure key handling

`AZURE_OPENAI_KEY` env var if set, otherwise a live
`az cognitiveservices account keys list` call every invocation (~1-2s, not
cached to disk anywhere) — see `lib/config.ts:resolveAzureKey`. Never
written to a file. If `az login` isn't active, set `AZURE_OPENAI_KEY`
yourself first.

## Cost notes

- Local Ollama embed + extraction: no API cost, dominant WALL-CLOCK cost
  (see Throughput above).
- Answerer (`gpt-5-mini`, `reasoning_effort: minimal`, ~300
  `max_completion_tokens` cap): cheap per plan doc §6, fixed across the
  whole run and across sweep iterations by design.
- Smoke judge (`gpt-5-mini`, `max_completion_tokens: 200`): cheap, same
  reasoning as the answerer.
- Final judge (`gpt-4o`, `--judge gpt-4o`): reserve for the real
  500-question run's final published numbers per the plan doc's cost note
  — not for routine iteration.
