# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **Meeting-caption capture, daemon-side acceptance (FEAT-491, contracts
  2.3.0 -> 2.4.0).** Accepts caption-sourced transcripts scraped by the
  astramem-plugin browser extension (Meet/Teams native live captions —
  bot-free, zero-ASR): `capture-envelope.v1.schema.json` widens
  `capture_source` to add `meeting_captions`, adds capture-session
  `platform`/`meeting_id` fields and a per-turn `speaker` label, and adds an
  ADR-017 `consent_disclosed` server-side consent marker (required `true`
  whenever `capture_source: "meeting_captions"` is present). Ingest
  (`CanonicalIngestSchema`) mirrors the widen and hard-rejects a
  meeting-captions envelope missing consent or with
  `captureSource.meetingCaptions.enabled` off in config (default OFF, ADR-017
  decision 3). Turn speaker labels flow through distill to the stored atom's
  `evidence[].speaker_label` (FEAT-496); `memories.consent_disclosed` and
  `transcripts.platform/meeting_id/consent_disclosed` are new columns
  (migration 050 — provisional number, see that file's own header comment).
  New doctor "Meeting-captions capture reminder" WARN row
  (mirrors `checkProxyCaptureReminder`) and `capture meeting-captions disable
  [--purge|--keep]` CLI, scoped to `capture_source = 'meeting_captions'`
  only, reusing the existing generic `/capture/purge` route.
- **Content-hash embedding cache (FEAT-492), document-role only.** Ports cloud's
  `CachingEmbeddingProvider.cs` pattern: a SQLite table (migration 043) keyed
  `(content_hash, model, dim)` caches document-side embeddings so re-running
  distill/reembed over unchanged content issues zero Ollama embed calls.
  `dim` rides in the key alongside `model` (not inferred from it) so a
  configured-dim change without a model-name change can never serve a
  wrong-length vector. Scoped to document-role embeds only — the worker's
  extended context (`src/cli/serve.ts`) gets its own `providers.embed` wrapped
  in `CachingEmbedProvider`; the raw provider still flows to query-role search
  routes and the doctor/preflight probes, since a query embed is never
  repeated verbatim and caching it buys nothing while adding a correctness
  risk (see `src/providers/embed/cache.ts`'s doc comment). LRU eviction caps
  the table at 20,000 rows. New doctor check "Embed cache hit rate" surfaces
  cumulative hit/miss counters (purely informational, never fails).

## [0.18.0] - 2026-07-14

### Changed

- **Default LLM provider (compaction AND extraction): `ollama` (qwen3.5:4b) -> `codex-subscription` (`gpt-5.4-mini`).**
  Every local-ollama qwen default tried here has broken shipped installs at
  least once — `qwen3:8b` returned empty output under thinking mode +
  `format:json` (distill poison), and separately blew this hardware class's
  8 GB VRAM ceiling once the `mxbai-embed-large` embedder was resident
  alongside it (see "Ollama 8GB VRAM ceiling" / "qwen3:8b breaks distill
  extract" in CLAUDE.md); `qwen3.5:4b` fixed the VRAM fit but is still a weak
  local model relative to a cloud-tier LLM. `codex-subscription` runs off-box
  against the operator's own ChatGPT plan and is immune to this box's VRAM
  ceiling entirely. **Requires `codex login` (a paid ChatGPT plan)** before
  compaction/extraction will work — there is no anonymous/free path. Cost is
  metered by the ChatGPT subscription's own quota, not by `budget.daily_usd`
  (every shipped LLM provider, including this one, hardcodes `usage.usd: 0`).
  Embedding is unchanged — stays on `ollama`/`mxbai-embed-large`; codex has
  no embeddings endpoint. Changed in `defaultConfig()`
  (`src/config/config.ts`) and the `init` wizard's default LLM provider pick
  (`src/cli/init.ts`, both the interactive `promptSelect` default and the
  non-TTY `gatherNonInteractive` fallback). `ollama` and the other cloud
  providers (`azure-openai`, `openai-compatible`) remain fully selectable —
  only the default choice changed.

### Changed (carried from Unreleased)

- **Default Ollama model (compaction AND extraction): `qwen3:8b` -> `qwen3.5:4b`.**
  `qwen3:8b` (5896 MB resident) plus the `mxbai-embed-large` embedder (590 MB)
  exceed the ~8 GB VRAM ceiling on consumer-class GPUs before any KV cache is
  added — Ollama spills layers to CPU, calls that should take seconds take
  9-35s, and distill jobs time out and poison (see "Ollama 8GB VRAM ceiling"
  in CLAUDE.md). `qwen3.5:4b` (3292 MB) fits with real headroom and scores
  higher on every axis actually measured: F1 68% vs 65%, recall 54% vs 48%
  (extraction bench, 3-run average). There is no remaining case for
  `qwen3:8b` as a default.
  **Caveat: that F1/recall number measures extraction, not compaction,
  quality** — nobody has benchmarked either model specifically as a
  compactor. Compaction's move to `qwen3.5:4b` is a safety + VRAM fix, not a
  proven compaction-quality win; extraction's move is both a safety fix and
  a measured quality improvement.
  Changed in three places, all now consistent:
  `defaultConfig()` (`src/config/config.ts`) for both `llm.compaction.model`
  and `llm.extraction.model`; the `init` wizard's `DEFAULT_OLLAMA_LLM_MODEL`
  (`src/cli/init.ts`), which is what real installs actually get (see below);
  and `OllamaLLMProvider`'s constructor fallback (`src/providers/llm/ollama.ts`),
  a defensive default for ad-hoc instantiation with no model.
  This change does not touch the extraction prompt
  (`src/distill/prompts/extract.ts`).
  **Who this affects:** new `init`-wizard installs get `qwen3.5:4b` for both
  roles — the wizard writes an explicit value from its single compaction+
  extraction tier picker, so this is the change that actually reaches users.
  Existing installs with an explicit `llm.*.model` in `config.yaml` are
  **unaffected** — `config.yaml` is read once per process at boot with no
  live reload, deep-merged, and an explicit value always wins over the
  default; they stay on whatever they were pinned to (including `qwen3:8b`,
  if that's what an earlier `init` wrote) until they hand-edit `config.yaml`
  or re-run `init`. **`reinstall` does not re-run the wizard or rewrite
  `config.yaml`** — it only repoints the release pointer (see CLAUDE.md's
  "Service / upgrade" section) — so users on the old default are not
  auto-upgraded by upgrading the binary. Follow-up worth naming: there is no
  migration path today that moves an already-installed user off a pinned
  `qwen3:8b` onto the new default; doctor could plausibly flag it but
  doesn't yet.
- **extraction-bench (#264): the bench's own `--compaction-model` default was
  hardcoded to `qwen3:8b`** (`scripts/eval/extraction-bench/lib/daemon-runner.ts`'s
  `DEFAULT_COMPACTION_MODEL`), the known-broken model above. Any bench run that
  didn't pass `--compaction-model` explicitly silently ran its compaction stage
  on it — including the historical `qwen3-live-2026-07-13` result (20 failed
  fixtures, 154.5s/session, no F1) that was cited as evidence `qwen3:8b` is
  broken as an *extractor*, without ever isolating extraction from compaction
  as the failing stage. Default now tracks the production compaction default
  (`qwen3.5:4b`).

## [0.17.1] - 2026-07-13

### Fixed

- **The v0.17.0 CRLF fix was a one-way door — it broke `reinstall --rollback`**
  (#244). v0.17.0's migration hash guard *rewrote* stored hashes to normalized
  (LF) form. Once it opened a database, **every older release refused to boot on
  it** — they still hash raw bytes and saw a mismatch they could not explain.

  Hit live: a v0.17.0 upgrade rolled back on a health-check timeout (a zombie
  `daemon.lock`, unrelated to the release), and the restored v0.16.0 then could
  not start on its own database — **down on both versions, with perfectly good
  data.** Rolling back is the one thing that must never be able to fail.

  Now: **verify, don't migrate.** A stored hash matching *either* the raw bytes
  *or* the normalized content proves the file is identical modulo line endings —
  which SQLite does not care about — so accept it and **leave the row alone**.
  Old and new releases boot on the same database in either direction. Real
  tampering still throws (it matches neither hash).

  **If you are on 0.17.0, upgrade.** Your rollback path is currently broken.

## [0.17.0] - 2026-07-13

A stability release. Almost everything here is the same bug wearing different
clothes: **a failure that looked like a success.** Nothing errored, nothing went
red, and the damage was invisible until someone measured it. The fixes are less
interesting than the reason they were all findable at once — see ADR-015.

### Fixed — silent data loss

- **A fact with a future end date was hidden from search** (#228). Atom-level
  validity extraction (#216) started populating `memories.valid_to`, and the
  default recall filter was `valid_to IS NULL` — which means *unbounded*, not
  *currently valid*. So "the contract runs through March 2027" was extracted
  correctly and then became **invisible to every normal search, immediately**.
  The feature inverted: the better extraction got at finding real end dates, the
  more live facts disappeared. Default recall now asks
  `(valid_to IS NULL OR valid_to > now)`.
- **A hallucinated date permanently deleted a memory** (#228). `invalid_at` was
  `z.string()` fed to `Date.parse` — no format check, no range, no ordering.
  One bad token from a 7B model wrote garbage into `valid_to` and the memory was
  never retrievable again: row on disk, write reported success, nothing errored,
  canary green. Now guarded — an implausible bound is refused and the atom is
  **kept unbounded**. Keep the atom, drop the bound; never the atom. Refusals are
  counted (`validity_guard_drops`, migration 038) so a model that starts
  hallucinating dates is *measurable*, not silently absorbed.
- **The junk-name filter was eating "C" and "R"** (#219) — real, commonly-used
  programming languages, destroyed pre-persistence and counted as noise. The
  guard is now kind-aware. (Entity names are stored lowercased, so the language
  `C` is byte-identical to the `"c"` junk actually seen in production; only
  `kind` distinguishes them.)
- **The proxy spooled transcripts to disk before redaction** (#225) — the
  quarantine directory was the single most likely place on the machine for a live
  credential to sit indefinitely. Redaction now happens before the bytes land.
- **Sync could never ship a promoted memory, and wedged the device forever**
  (#210). A `create` event froze `scope: "private"` in its payload; promotion
  changed the row but not the event, so the cloud rejected it every 30 seconds,
  permanently, blocking everything queued behind it.

### Fixed — canaries that could not fail

- **Doctor never actually ran unattended** (#226). The canaries existed, were
  wired, and nothing invoked them. They are now scheduled — and
  `checkMemoryHealth`, which had exactly one return path (`{ok: true}`), can now
  go red.
- **The entity-link canary asked "does any success exist?"** (#215) — so it
  reported green for weeks while ~87% of memories were receiving zero entities.
  It now measures a **rate**. This is what made the extraction repair *provable*:
  live production went from ~87% unlinked to **0.0% unlinked** in the most recent
  100 memories.
- **Nine doctor checks reported healthy when they could not run** (#208) —
  `catch { return { ok: true } }`. A check that cannot run is not a check that
  passed. They now return an `inconclusive` tier.
- **The same bug was reintroduced four times within hours**, by authors who had
  read ADR-015 and cited it in their own comments. Documentation cannot fix a bad
  default, so #221 adds a test that **fails the build** on any catch block
  returning `ok: true` without `inconclusive: true`. It has already caught one.
- **An eval run where every question was skipped exited 0** (#204) — and the
  guard written against silent failure had a silent failure ten lines from its
  own throw.

### Fixed — refuses to boot

- **The migration hash guard halted the daemon over a carriage return** (#242).
  It hashed raw bytes; Git's `core.autocrlf` (the Windows default) checks the
  same committed file out as CRLF in one worktree and LF in another. Measured on
  one file: 4593 bytes / 0 CR vs 4674 bytes / 81 CR, `git status` clean in both,
  one commit, identical SHA once the CRs are stripped. The daemon refused to
  start and told the operator to reconcile `schema_version` **by hand**. Migration
  hashes are now computed on normalized content, and a legacy raw-byte hash
  self-heals rather than flipping the bug onto the other half of users.
- **Two migration files could claim the same version number** (#223) — the
  second silently won, one migration never ran, and the daemon bricked at boot.
  This happened in production this morning; recovery was by hand.
- **A recycled PID was fair game for the watchdog** (#224) — it now verifies the
  daemon's identity before killing anything.
- **A 5s timeout on a 5.8s cold start failed closed on every call** (#237), and
  nothing surfaced it.

### Fixed — performance

- **A 5s dashboard auto-refresh on an 8s render** stacked synchronous queries and
  starved the daemon's event loop (#213). Left alone, it would have fed the new
  hang-watchdog into a restart loop.
- **Two unbounded full-table scans were promoted onto a 15-minute unattended
  loop** (#232) by the very change that made the canaries run.

### Added

- `astramem-local entity-purge-junk` (#240) — removes junk entity rows written
  before the write-path guard existed. Uses the **same rule** as the guard and the
  doctor canary (importing the identical function, not a copy). Previews by
  default; `--yes` to delete. Never deletes a memory, only entity rows.
- Guard-drop counters as one readable family: `relation_guard_drops` (029),
  `entity_name_drops` (034), `validity_guard_drops` (038), `entity_link_drops`
  (039). Each exists so a **real zero** stays distinguishable from a **broken
  zero**.
- Windows hang-watchdog parity (#211) — a wedged-but-lock-holding daemon could
  previously only be recovered by a human noticing and killing the PID.

### Changed

- `SCHEMA_VERSION` is **derived from the migrations directory** (#229). It had
  been hand-maintained in nine places, which made every migration PR conflict with
  every other one — the direct cause of **nine migration-number collisions in a
  single day**, one of which bricked production.
- The MCP tool count is derived rather than hand-maintained in three places
  (#241).

## [0.16.0] - 2026-07-13

### Added
- **Temporal grounding in extraction** (#189, #191). The session's capture date is now threaded into the extraction LLM call, so relative time expressions ("yesterday", "last year") are resolved to absolute ISO dates **in the atom's text**. Previously **zero** of 191 stored memories contained an absolute date — every date-bearing memory was an unresolved relative expression with no anchor, which made "when did X happen" unanswerable. `captured_at` now carries the local UTC offset (migration 032, `SCHEMA_VERSION` 32); an earlier revision used the UTC calendar date, which resolved "yesterday" one day off for any user west of UTC capturing in the evening.
- **Multi-hop query decomposition** (#193) — **opt-in, `multiHop.enabled: false` by default.** Splits a multi-hop question into sub-queries and merges supplemental candidates. Dilution is bounded structurally: supplemental hits are fused in a *separate* pass and never share `fuse.ts`'s min-max normalization pool with primary candidates, are capped (`maxSupplemental`, default 5), and damped (`supplementalWeight`, default 0.5) — they can fill unused slots but cannot evict a stronger direct hit. Ships making no claim; enable only on evidence.
- **LoCoMo single-hop retrieval diagnostic** (#195). Classifies each missed question as `not-in-db` / `rank-miss` / `rank-ok`, measured against a **production-matched candidate pool** (`vecK` identical to the real `k=10` path — a naive large `limit` silently changes `vecK` and therefore the ranking). Also lands `--extract-profile` / `--extraction-provider` / `--compaction-provider`, without which the project's headline LoCoMo result was **not reproducible from `main`**.

### Fixed
- **A linked git worktree can no longer touch the PRODUCTION datadir** (#187, #194). A worktree gets its own branch and `dist/` but **not** its own datadir — `defaultDataDir()` resolved to the same production directory regardless of checkout. On 2026-07-13 that let an agent apply an *uncommitted* migration to the live database; the daemon then would not boot. Now refused at `resolveRuntimeConfig()` unless the caller is explicit (`ASTRA_MEMORY_DATADIR`, `:memory:`, `ASTRA_MEMORY_ISOLATED=1`, `--data-dir`, or `ASTRA_ALLOW_PROD_DATADIR=1`). No-ops for the primary checkout and for npm-installed users (no `.git`).
- **Honest usefulness-feedback canary** (#190, #196). `doctor` now WARNs whenever `usedDistinct == 0`, regardless of `correctedDistinct`. It previously reported **green** on `0 used, 854 corrected` — but those "corrections" were not external feedback at all: they came from consolidation's *own* auto-merge. The positive signal (`recall_used`) has **never fired in production**, because nothing in the real usage path calls `submit_feedback`/`mark_memory_used` (the daemon cannot know whether a memory was used; only the consumer can — a plugin-side fix, not yet built). Corrections are now source-tagged (`consolidation_auto` / `external`) so the two can never be conflated again. `epsilon` is **unchanged at 0.1**: with no positive signal, `usefulness` is uniformly neutral, so ε is provably rank-invariant (byte-identical ADR-005 floors at 0.1 and 0) — inert, not harmful.
- **Migration-030 collision** (#185, #186). Two different migrations were numbered `030`; `migrate()` keys identity on the number alone, so one was **silently skipped**. Renumbering then re-collided and bricked databases that had already applied the original. Guard test added; root cause (no content hash on `schema_version`) tracked in #188.

### Changed
- **Default extraction/compaction model: `qwen3:8b`** (was `qwen2.5:7b`; the wizard's retired "fastest" tier `qwen2.5-coder:7b` is also swept). Operator standardization, 2026-07-13 — not an A/B-benchmarked swap: there is no F1 evidence yet for `qwen3:8b` on the extraction bench (the 2026-07-08 A/B run's `qwen3:8b` row is invalid — it predates the `think:false` fix in commit `1915521`, so it ran with thinking on + `format:json` and returned empty bodies). A fresh benchmark run is pending; `astramem-local init`'s tier picker now shows "benchmark pending" instead of carrying over the old model's measured stats under the new name. Existing installs keep their configured model. `qwen3:8b` is heavier on RAM than the retired defaults (~5.76 GB resident with flash-attention + q8 KV cache, ~6.2 GB without, vs ~5 GB for `qwen2.5-coder:7b`) — see docs/providers.md for the updated total.

## [0.15.1] — 2026-07-12

### Fixed
- **Close-capture provenance + auto-capture canary (874c931)** — `capture claude` (the astramem-plugin close-capture hook path) now stamps `capture_source = 'hook_close'` on every spooled envelope; previously these landed as NULL while the doctor "Auto-capture" canary counted only `'auto_capture'` rows, leaving the canary permanently red even with capture fully working. The canary now counts both provenance values, and its fix hint names the failure mode found live in production: a stale global `astramem-local` install predating the `capture` subcommand silently no-ops inside the hook. `'auto_capture'` stays reserved for the future opt-in denser-sampling trigger, and `capture auto-capture disable --purge` remains scoped to `'auto_capture'` rows only — hook-close memories are never purged by that flow.

### Added
- **E2E smoke: auto-capture close pipeline** (`tests/e2e/auto-capture-close.e2e.test.ts`) — drives the real CLI → spool → drain → distill → memory chain against an isolated daemon, deleting the source transcript mid-flight to prove the ephemeral-transcript race fix, and asserts the doctor canary goes green.
- **E2E smoke: profile learning** (`tests/e2e/profile-learning.e2e.test.ts`) — proves the behavioral claim end-to-end: a superseded mistake disappears from search, its correction surfaces, `submit_feedback` measurably re-ranks results via the usefulness epsilon, and `agent_profile.corrections`/`top_lessons` + `user_profile.recurring_lessons` populate correctly.

### Upgrade note
- A daemon older than this release rejects `hook_close` spool envelopes (closed ingest enum) and quarantines them after 5 drain attempts — upgrade the daemon (`reinstall`) before or together with the global CLI.

## [0.15.0] — 2026-07-12

### Added
- **Purge-batch reversible soft-delete primitive (FEAT-467)** — batch memory purges are now recorded as reversible soft-delete batches (schema migration 25) with a restore window; the purge event payload surfaces `restore_deadline_at` so clients can show exactly how long an undo remains possible.
- **Hang-watchdog probe for systemd/launchd (FEAT-443, slice 2)** — Linux/macOS installs get a recurring `/health` probe (systemd `OnUnitActiveSec` timer / launchd `StartInterval` agent, installed automatically alongside the main service) that detects an alive-but-wedged daemon — the blind spot `Restart=on-failure`/`KeepAlive` can't see — kills whatever actually holds `daemon.lock`, and restarts via the platform adapter. A review fix ensures a failed `stopLockHolder` aborts the restart path instead of being silently ignored.
- **`bulk_accepted` provenance on `consolidate accept --all` (FEAT-437 residual)** — bulk-accepted consolidation candidates are now distinguishable from individually reviewed ones in provenance.
- **Git post-merge hook auto-activation (FEAT-439 residual)** — `init` and `reinstall` from a git checkout idempotently run `git config core.hooksPath scripts/git-hooks`, activating the migration-currency post-merge hook with no manual step; silent no-op for npm-installed users. Overwrite of a foreign `core.hooksPath` is reported distinctly from fresh activation.

### Fixed
- **Numeric-secret redaction (FEAT-468, security)** — digit-only secrets (below the entropy threshold by alphabet math, the known limitation shipped in 0.13.0) are now caught by a digit-run heuristic with label-awareness. Two adversarial review rounds hardened it: benign labeled numerics (`PASSWORD_MIN_LENGTH=8`, port numbers, timestamps) stay untouched via a same-line-only label lookback and a raised numeric floor.
- **Smart/curly-quote credential labels (FEAT-473, security)** — the `generic_credential_quoted` detector family and both entropy-stage label guards now recognize Unicode smart quotes (U+2018/U+2019/U+201C/U+201D), including one-sided auto-curl mangles; previously a short secret in smart-quoted JSON leaked in full, and a curly-quoted benign label could be wrongly flagged as high-entropy.
- **Sync-token keystore identity scoped per configDir (FEAT-472, security)** — the sync token now uses the same per-install scoped OS-credential-store identity that FEAT-466 gave the bearer and db-key, so a sandboxed/test init can no longer collide with a real install's sync pairing.
- **Distill rationale-marker precision (FEAT-448)** — `RATIONALE_MARKER_RE` is tightened to causal proximity and the because/reason contentless check is scoped per occurrence, cutting false "rationale" classifications on incidental marker words.
- **Stabilization quick-wins batch (FEAT-470)** + **spawn-heavy test timeout budgets (FEAT-471)** — CI suite reliability under parallel load; no runtime behavior change.

### Governance
- **ADR-014 local fusion governance (FEAT-428)** — search fusion component ceiling (N=3) plus an eval-evidence gate enforced by a shipped-config test.

### Upgrade note
- This release contains schema migration **25** (purge-batch soft-delete tables). Migrations run automatically on daemon start; rolling back to a pre-0.15.0 binary after migration 25 has applied is untested — prefer `reinstall --rollback` only before the upgraded daemon has started.

## [0.14.0] — 2026-07-10

### Added
- **Multi-run eval aggregation (FEAT-457, slice 1)** — the LoCoMo judge (`judge.mts`) now accepts repeated `--run-dir` inputs and reports mean ± sample-standard-deviation across runs (mean-of-run-means, correctly labeled), promoting the stats helpers to `scripts/eval/shared/stats.ts`. A cross-run comparability guard hard-refuses to combine run dirs sampled with different `--dataset`/`--seed`/`--n`/`--qa-per-sample` (each differing parameter named), extending FEAT-462a's "never silently publish a meaningless number" posture one layer up the pipeline. Single-run and no-`run-params.json` paths stay backward-compatible.
- **Detached eval execution + scoped cleanup (FEAT-462, slice B)** — the LongMemEval and LoCoMo harnesses gain `--detach` (spawn a survives-the-session child), a throttled `run-status.json` progress file readable via `run-smoke.mts --status <run-dir>`, and a `daemon-manifest.json` recording each spawned daemon's PID + port. A new `kill-run.mts` operator CLI cleans up a stuck detached run and signals **only** the manifest's own daemons, guarded by a fail-closed PID-reuse identity check (`checkPortOwner` via `netstat`/`lsof`): if the recorded PID no longer owns its recorded port, the kill is skipped rather than risking an innocent process — the exact failure class CLAUDE.md's Do-NOT section records. Both eval READMEs gain a copy-pasteable "my detached run looks stuck" operator playbook.

### Fixed
- **extraction-bench imports repointed at `scripts/eval/shared` (FEAT-469)** — post-0.13.0 fix unblocking the FEAT-450 extraction sweep; no runtime behavior change to the daemon.

## [0.13.0] — 2026-07-10

### Added
- **Eval-harness resume + kill-resilience (FEAT-462, slice A)** — both the LongMemEval and LoCoMo harnesses now write a crash-safe append-only progress ledger (`ingest-ledger.jsonl`) on every run and accept `--resume <run-dir>` to skip already-completed sessions after a crash or kill, with exactly-once ingest accounting verified by a real SIGKILL + respawn integration test. A `run-params.json` scope guard hard-refuses a resume whose `--dataset`/`--seed`/`--n`/`--shards` differ from the original run (each differing parameter named), so a resumed run can never silently produce a narrower-scope eval number. Detached execution (`--detach`) is a follow-up slice.

### Fixed
- **Stage-0 redaction now catches quoted/JSON label forms (FEAT-463, security)** — credential labels wrapped in quotes (`"OPENAI_API_KEY": "sk-..."`, `'DB_PASSWORD' => 'hunter2'`, `"SECRET_KEY"=value` and PHP array-arrow forms) previously evaded the `generic_credential` detector because the closing quote broke keyword–separator adjacency. Six new detector entries (logged as `generic_credential_quoted`) cover quoted-label × quoted/bare-value shapes. The accompanying entropy-stage guard survived three adversarial review rounds: suppression now requires a low-entropy label core AND a safe following value AND a non-hex-shaped identifier, closing two reproduced bypass classes (standalone `secret…=` tokens and decoy-suffix variants). Known limitation: digit-only secrets sit below the entropy threshold by alphabet math (pre-existing, tracked as FEAT-468).
- **`configToYaml()` no longer silently drops newer `Config` fields (FEAT-461)** — `writeConfig()` (triggered by `init`, `reembed-dim`, `pair`, and auto-capture disable) previously re-emitted config.yaml without `archival`, `ingestIdempotency`, `distill`, `memoryHealth`, `ingest`, `consolidation.contradictionDetection`, `search.governance.maxComponentWeight`, and `crossEncoder.model` — since the loader deep-merges over `defaultConfig()`, every field the emitter dropped silently reverted to its code default on next load. A new structural key-diff (`findMissingConfigKeys`) now runs on every emit and logs a warning if a future field is left unwired, so this bug class can't recur silently.
- **Config loader comment-stripping is now quote-aware (FEAT-465)** — `src/config/loader.ts` previously stripped `#` comments with a quote-unaware regex, silently truncating any scalar (or flow-sequence entry) whose value contained a whitespace-preceded `#`. A `#` inside a single- or double-quoted value — including one embedded in a `security.redaction.customPatterns` flow-sequence entry — is now treated as literal content; genuine trailing comments, including ones after a closed quoted value, are still stripped.
- **OS credential-store identity collision across installs (FEAT-466, security)** — a sandboxed/test `init` previously overwrote a real install's bearer/db-key in the OS credential store (Windows Credential Manager / keychain), because the store identity was fixed and machine-global rather than scoped per install. Both the db-key and bearer identities are now scoped to a hash of `configDir`, with a read-only fallback to the legacy unscoped identity so existing installs keep working after upgrade with no re-init. `doctor` now reports which identity (`scoped`/`legacy`) is in use. `ASTRA_MEMORY_TEST_FORCE_KEYFILE` (previously db-key only) now also covers the bearer, so a sandboxed/test `init` can be configured to never touch the real OS credential store at all.

### Compatibility caveat
- **`security.redaction.customPatterns` and downgrade compatibility.** This release adds minimal YAML flow-sequence support (`customPatterns: ["a","b"]`) for the one array-typed `Config` field. If you configure a non-empty `customPatterns` list and later **roll back** to a daemon binary older than this release (e.g. `reinstall --rollback` past this version), that older binary's config loader cannot parse the array syntax and will misread the line — **remove the `customPatterns` line from config.yaml before rolling back** in that case. An unconfigured (empty, the default) `customPatterns` is unaffected: the line is omitted entirely when empty, specifically so a default config.yaml stays byte-identical across a rollback.
- **Rolling back past the FEAT-466 keystore-scoping release is safe, INCLUDING after a `token rotate`, because `secrets.env` now unconditionally carries the current `MEMORY_BEARER=` line.** Before this fix, `secrets.env` was written only when the OS credential-store write failed (a "fallback of last resort"); a pre-FEAT-466 binary reads the OS credential store's unscoped identity *before* `secrets.env` (see `bearer-keystore.ts`'s documented resolution order), so a rollback right after a rotate could otherwise resolve a stale bearer, or — on a fresh install with no legacy OS entry at all — fall all the way through to the hard-coded `'devtok'` default. Two changes close this: (1) `secrets.env` is now always written with the current bearer, regardless of OS-store success, so a rolled-back binary with no legacy OS entry finds the current token via its own `secrets.env` fallback; (2) `token rotate` additionally write-throughs the new bearer into the legacy unscoped OS-credential-store identity (not just the new scoped one), so a rolled-back binary that reads the OS store directly also finds the current token rather than a stale pre-upgrade one. (`init`'s first-time provisioning deliberately does NOT write-through the legacy identity — doing so from a sandboxed/test `init` is exactly the mechanism the original FEAT-466 incident closed.)

---

## [0.12.1] — 2026-07-10

### Fixed
- **Stage-0 redaction hardening (FEAT-459, security)** — compound credential labels are now detected: `INTERNAL_SECRET=`, `OPENAI_API_KEY=`, and leading/middle-keyword forms like `SECRET_KEY=` / `DJANGO_SECRET_KEY=` / `secret_key_base:` (previously all silently unredacted). Two-tier precision design: high-confidence keywords (`secret`, `password`, `passwd`, `pwd`) match in any label segment with a numeric/boolean value guard (`PASSWORD_MIN_LENGTH=8` stays untouched); ambiguous keywords (`token`, `api_key`) remain trailing-only (`TOKEN_LIMIT=4096` never matches). Labeled short secrets are redacted regardless of length; the entropy detector's length floor still applies to unlabeled matches only. Perf smoke added — no hot-path regression.
- Distill no longer drops an entire atom when one extracted entity has an out-of-enum `kind` — the entity is coerced to `other` (mirrors cloud `EntityKinds.Normalize()`); atoms still drop for genuine schema violations (#152).

---

## [0.12.0] — 2026-07-10

### Added
- **Hook-tap auto-capture (FEAT-455, ADR-012 tier 1)** — daemon-side support for high-frequency passive capture of session transcripts: `capture_source` provenance column (migration 024) threads envelope → transcript → distilled atoms; standalone source-side relevance gate (`src/capture/relevance-gate.ts` — size caps, per-session dedup window, structural junk heuristics; disjoint from the durability gate per its AC-6); `capture.autoCapture.enabled` config, default **OFF**, enabled only via the `init` wizard's explicit disclosure prompt; `doctor` row showing enabled state + auto-captured count; `capture auto-capture disable [--purge|--keep]` — disabling offers retroactive purge scoped to auto-captured atoms via the existing erasure path. Auto-captured payloads flow through the same stage-0 redaction as every other ingest.
- **Fact-level bitemporal validity on entity links (FEAT-453 slice 2)** — `memory_entities` rebuilt with `valid_at`/`invalid_at` windows (migration 023, data-preserving), at-most-one-open-window-per-pair partial unique index, `linkWithValidity`/`closeAndRelink`/`memoryIdsForEntitiesAsOf` storage primitives, and entity+`as_of` search composition (both filters apply). atom@2 contract relaxed additively for entity validity fields (contracts `2.1.0`); extraction prompt emits validity hints. _(Clarification added 2026-07-12: this is **valid-time only** — there is no queryable transaction-time axis, so "bitemporal" above overstates it. See the 2026-07-12 amendment in `docs/adr/ADR-001-canonical-memory-atom.md`. Wording preserved as originally released.)_

### Fixed
- `writeConfig()` now emits the `capture` config block (previously silently dropped, so wizard opt-in and disable would not persist). Remaining missing blocks tracked as FEAT-461.

### Notes
- Schema version 22 → 24 (migrations 023, 024). Upgrade is automatic and data-preserving.

---

## [0.11.0] — 2026-07-10

### Added
- **User profile (FEAT-451)** — `GET /profile` + MCP `user_profile` tool (18th tool): live-computed standing profile rolled up from existing atoms (standing facts, preferences, recurring lessons, recent decisions, known entities), deterministic ordering, scope-aware (private by default), zero schema change.
- **Contradiction detection, propose-only (FEAT-456 slice 1)** — the consolidation pass can now flag likely-contradicting memory pairs via an LLM judge and file them as `kind:'contradiction'` proposals in the existing proposal queue (accept → normal audited supersede). Default **off** (`consolidation.contradiction.mode`); migration 022 adds `metadata_json` to proposals. No auto-action — per ADR-004, contradiction resolution requires an explicit accept.
- **Rerank provenance (FEAT-452)** — reranked search hits now carry `reranked`, `rerank_score`, and `explanation.signals.cross_encoder` while `score` keeps the original fused value (previously overwritten in place); outcome-tagged structured logs for the rerank stage; runbook documents the sidecar-satisfies-local-only decision.
- **Named retrieval presets (FEAT-454)** — `preset` (`default|recent|exact|entity|temporal`) on `GET /search`, `POST /recall`, and the MCP search/recall tools; presets are weight-routings over the existing fusion pipeline, constructed through fusion governance; `default` is byte-identical to prior behavior (snapshot-tested).

### Fixed
- Vestigial shebang in `scripts/git-hooks/post-merge-rebuild.mjs` broke the suite's dynamic import under vitest's `node:vm` evaluator.
- LongMemEval harness: distill-wait polling no longer bursts every session concurrently (Windows ephemeral-port exhaustion at n=50); sequential short-circuit + 5s interval.

---

## [0.10.0] — 2026-07-09

### Changed
- **BREAKING — atom@2 contract cut.** Retrieval/sync entities are now typed across 12 `ENTITY_KINDS`; the `repo`/`personal` scope fields are dropped in favour of `project`, and result types are widened. Local extraction retags to atom@2, the sync create-event payload embeds typed entities, and the daemon advertises `atom@2` in `WIRE_VERSIONS_SUPPORTED`. Contracts published as `contracts-v2.0.0`. Clients on the v1 entity shape must upgrade.
- **`engines.node` floor raised to `>=22`** to match the SQLCipher prebuilt matrix.

### Added
- **Durable ingest spool (FEAT-449)** — transcript content is captured at session close and the daemon drains the spool asynchronously, closing the ephemeral-worktree-transcript starvation class where paths were deleted before async ingest could read them.
- **Distiller durability quality gate (FEAT-441)** — `distill.durabilityGate` (`off` | `lenient` | `strict`, default `off`) skips low-signal atoms at the store layer; `/remember` bypasses the gate by construction. Ships inert (`off`) — byte-identical to prior behaviour until opted in.
- **Memory-health score (FEAT-444)** — surfaced in `doctor`, `GET /health`, and the CLI.
- **Consolidation auto-accept (FEAT-442)** — opt-in auto-accept above a confidence threshold, plus un-supersede reversal.
- **Release-pinned service pointer + rollback for systemd/launchd (FEAT-443)** — parity with the Windows release-pinning model.
- **Crash-loop visibility + schema-drift probe (FEAT-440, FEAT-439)** — doctor reports crash-loop state; post-merge migration-currency probe and rebuild.
- Authed `GET /whoami` bearer-verification probe.
- Extraction eval infrastructure: codex/qwen3 provider fixes, prompt/temperature A/B harness, cloud benchmark specs, junk-pollution eval fixtures.

### Fixed
- **Release-pinning was silently broken** — `migrations/` is now materialized into the pinned release (previously omitted, so pinned releases could run against a stale schema).
- Service reliability: `reinstall` stops the actual daemon PID (not just the scheduler task) and widens the verify-health budget to 90s; `pidAlive` treats `EPERM` as alive; daemon stderr is redirected to an fd instead of buffered in memory.
- Sync CLI closes its DB handle exactly once per subcommand on both success and error paths.
- CI: fetch the pinned prebuilt SQLCipher addon instead of compiling.

---

## [0.9.1] — 2026-07-08

### Changed
- **Default extraction/compaction model: `qwen2.5:7b`** (was `qwen2.5-coder:7b`). A/B benchmark (prompt v2, 15 gold fixtures): F1 67% / precision 99% / junk 1% vs the coder variant's 59% / 90% / 8%, at ~21.6s vs ~8.7s per session — quality wins for a background daemon. Existing installs keep their configured model; the wizard's tier picker offers `qwen2.5-coder:7b` as the "fastest" tier.
- **Extraction prompt v2**: type decision-tree, contrastive few-shot examples, recall directive; compaction now preserves unresolved tool failures and per-topic coverage. Moved the API-reference model from F1 67% to 81% on the same fixtures — full results in `scripts/eval/extraction-bench/results/ab-run-2026-07-08/`.

### Added
- One-line installers (`install.sh` / `install.ps1`) and the "Retrieval quality gates" README section with `docs/eval/methodology.md`.
- Sync failures now include the HTTP response body (`sync ship failed: HTTP 403 {"error":"sync_disabled"}`).
- Migration 018: index for session digest poison-job lookups.
- `ASTRA_MEMORY_ISOLATED=1` now also isolates bearer-token resolution (ephemeral token; OS credential store and secrets.env untouched).

### Fixed
- `demo` command works with isolated-mode ephemeral tokens (server/client token mismatch).

---

## [0.9.0] — 2026-07-08

Package renamed to `astramem-local` on npm (was `@astragenie/astramemory-local`, deprecated at 0.4.0).

### Added
- `openai-compatible` LLM provider — BYO key for any `/v1/chat/completions` endpoint (vLLM, Groq, OpenAI).
- `codex-subscription` LLM provider (EXPERIMENTAL) — extraction on your ChatGPT subscription via the Codex CLI login; live-verified (SSE streaming, token refresh). See docs/providers.md for the ToS/quota warning.
- `astramem-local mcp install --client claude-code|cursor|claude` — writes the client's MCP config automatically (idempotent, with backup).
- `astramem-local demo` — 30-second in-memory trial, no Ollama required.
- Agent profile: `GET /agents/:agent/profile` + `agent_profile` MCP tool — usefulness-ranked lessons, recent decisions, and correction warnings per agent.
- `pipeline.concurrency` (1–8) — concurrent distill workers (default 1, unchanged behavior).
- `ASTRA_MEMORY_ISOLATED=1` — test/eval isolation: OS config dir ignored, sync hard-disabled.
- Init wizard: Ollama installed/pulled on demand only (explicit size + time notices); extraction-model tier picker; BYO-cloud pivot into the full provider set.
- Shared contracts: `@astragenie/astramem-contracts/wire` constants module (wire version, pattern, protocols).
- LICENSE (MIT), SECURITY.md, CONTRIBUTING.md.

### Fixed
- `as_of` bitemporal filtering now keyed on the envelope's `captured_at`, not ingest wall-clock time — backfilled/re-ingested content dates correctly.
- Session digest reports `status: partial` + `poison_jobs` when a distill job permanently failed (was silently `ready`).
- Azure OpenAI provider works with reasoning models (gpt-5*/o-series): sends `max_completion_tokens`, omits `temperature`.
- `wire_version` minor-version regex now byte-matches the SaaS backend (rejects `v1.01`).
- Wizard no longer attempts `ollama pull` of non-Ollama model names in mixed-provider setups.

---

## [0.8.1] — 2026-07-06

### Added
- **`pair` defaults `--url` to `https://api.astramemory.com`** (#87, closes #85) — `pair <code>` now works with no flag/env against the prod root-relative host (astragenie/common #167/#169). Precedence `--url` > `ASTRA_SYNC_URL` > default; an explicit url now wins over the cloud-echoed `apiUrl` (was silently overridden), and `pair` logs the effective sync base + its source.

---

## [0.8.0] — 2026-07-06

### Fixed
- **sync: device token sent under the ApiKey scheme, not Bearer** (#82, closes #79/#83) — the cloud `AuthMiddleware` accepts `Authorization: ApiKey <key>` for device keys and `Bearer <jwt>` for Clerk JWTs only. The shipper/puller sent the `sk-…` device token as `Bearer`, so every ship/pull got **401**. Switched both to `ApiKey`.
- **sync: `create` events ship a content payload** (#86, closes #80 / memory#618) — the `create` memory_event carried `content_hash` but no `payload`, so `payload_json` shipped null and cloud replicas materialized with **empty, unsearchable** content. The create event now carries `text`/`type`/`scope`/`importance`/`confidence`/`repo`. Personal atoms never ship (scope filter); only team/org.

### Notes
- Requires the cloud `sync_events.content_hash` constraint relax (memory#619, released in memory v0.8.4) on prod, else `create` events still 500. Ship the memory release first or together.
- **`pair` default-`--url`** (#87, closes #85) is NOT in this release — its CI (`cross-repo-roundtrip`) is stuck on a native-binding runner flake. `pair` still requires an explicit `--url https://api.astramemory.com`. Ships in a follow-up once the flake clears.

---

## [0.7.2] — 2026-07-05

### Fixed
- **CI: npm publish on self-hosted runners** — dropped `--provenance` from `npm publish`. npm rejects sigstore provenance from self-hosted runners (`E422 Unsupported GitHub Actions runner environment: "self-hosted"`) and fleet policy is self-hosted only, so provenance and the publish were mutually exclusive. Completes the publish fix started in 0.7.1 (#58). No runtime change.

---

## [0.7.1] — 2026-07-05

### Fixed
- **CI: npm publish workflow** — `bun install` in the publish job now runs with `--ignore-scripts`, skipping `better-sqlite3`'s node-gyp native compile that crashed the fleet runner (`webidl.util.markAsUncloneable is not a function`; no prebuilt binary for the target). The publish only needs the TS `dist/` build; the native driver is compiled on the consumer's install. Fixes #58. No runtime changes.

---

## [0.7.0] — 2026-07-05

Project- and agent-scoped recall (FEAT-423, issue #56).

### Added

- **`project` and `agent` recall filters** — `POST /recall` (`filters.project`, `filters.agent`), `GET /search` (`&project=`, `&agent=`), and MCP `search_memory`/`recall_memory` now narrow results by `provenance.project` / `provenance.agent` (exact match, AND-composed). Both accept a single value (`col = ?`) or a comma-list / array (`col IN (...)`, OR-semantics; empty list = no constraint). `agent` is a hard filter; role-scoped soft-boost (FEAT-219) is deferred.
- **CLI `--project` / `--agent`** on `search`, `recall`, and `remember` (`astramem-local`). `remember` persists them via `metadata.project` / `metadata.agent`.
- **MCP parity**: `search_memory`/`recall_memory` gained the missing `entity` filter alongside `project`/`agent`.
- **Docs**: `docs/recall-filters.md` — end-to-end integration contract (wire shapes, CLI, precedence, tests). `/dashboard/api` route table updated.
- **Tests**: `tests/search/project-filter.test.ts`, `tests/cli/project-filter.test.ts`, and `tests/smoke/smoke.test.ts` filter battery (GET + POST + CLI over a real daemon).

### Fixed

- The recall `project` filter was inert end-to-end because the client never sent it under `filters` (issue #56). Server always supported it; the companion `astramem-plugin` client fix nests the filter correctly.

---

## [0.6.0] — 2026-07-02

Waves 3 + 4 of the migration map: the cloud bridge and the moat. The full local→cloud loop now works end to end: pair → capture → distill → ship → cloud ledger.

### Added — Wave 3: cloud bridge

- **Contracts package** (`contracts/`): versioned JSON Schemas for `atom@1`, `retrieval-query/result@1`, `sync-envelope@1`, `capture-envelope@1` with valid/invalid fixtures, an eval corpus + graded query set (ADR-005), and `contracts:validate` wired into lint CI.
- **Sync shipper** (ADR-003): one-way log shipping of team/org-scoped `memory_events` to the cloud ledger (`astramem-sync@1` envelopes, `acked_seq` cursor, exponential backoff). Personal-scoped atoms never ship (ADR-009). Off by default; requires pairing.
- **Erasure v1** (ADR-006): `DELETE /memory/:id` + MCP `erase_memory` — hard-delete with an `erase_request` tombstone event that ships to the cloud and blocks re-distillation from resurrecting the memory (stage-8 replay filter).
- **Device pairing**: `astramem-local pair <claim-code> --url <cloud-url>` redeems a FEAT-278 claim code; the device ApiKey goes to the OS credential store, `sync.json` persists url/workspace, and the daemon starts the shipper on next boot.
- Cloud side (astragenie/memory): `POST /sync/events` with dual dedup fences, ledger materialization (create/invalidate/supersede/erase), and per-device cursors.

### Added — Wave 4: the moat

- **Retrieval eval harness** (ADR-005): the shared corpus + query set runs in CI as a quality gate — mean recall@10 ≥ 0.90 / NDCG@10 ≥ 0.70 (deterministic baseline 0.929 / 0.748). `as_of` time-travel reported as a known engine gap, not silently dropped.
- **Usefulness feeds ranking** (ADR-010 v1.x): fusion gains an ε component (`search.epsilon`, default 0.1) over a Laplace-smoothed per-atom score — `recall_used` lifts, `memory_corrected` demotes, no signal stays neutral (0.5), so unsignaled corpora rank identically.
- **Consolidation stage 9** (ADR-004, migration 008): deterministic offline pass per `(repo, type)` group — cosine ≥ 0.95 auto-merges as supersede (originals kept, `derived_from` lineage), 0.85–0.95 lands in a propose-only queue requiring user confirm. REST `POST /consolidation/run`, proposal accept/reject; `consolidate` job kind.
- **Anthropic memory-tool adapter** (ADR-007): `POST /memory-tool` maps `view`/`create`/`str_replace`/`delete` onto memories — writes are redacted, edits supersede, deletes erase with tombstones.
- **Injection policy** (ADR-005 when-to-recall): `/recall` with a `prompt` gains a decide-before-inject gate (smalltalk/short-prompt suppression, memory-reference override, min-score filter, budget shrink for long prompts).
- **Codex CLI capture connector** (ADR-008): `astramem-local capture codex` ingests Codex sessions (open JSONL) through the normal redaction + distill path; content-stable idempotency keys make re-runs safe. Cursor postponed — proprietary chat store; Cursor users connect via MCP recall.

### Changed

- `SCHEMA_VERSION` 7 → 8 (migration 008 consolidation proposals).
- MCP server exposes 12 tools (+ `erase_memory`).
- Cloud embeddings default to self-hosted HuggingFace TEI (BGE-large, 1024-d); local embeddings remain Ollama `mxbai-embed-large` (1024-d).

---

## [0.5.0] — 2026-07-02

Waves 1 + 2 of the target-architecture migration map: the trust floor and the contract + flywheel.

### Added — Wave 1: trust floor (SEC-1..10)

- **Encryption at rest** (SEC-1/2/7/8): production driver is now `better-sqlite3-multiple-ciphers`; `memory.sqlite` is encrypted by default (`security.encryption.enabled`, default `true`). Key lives in the OS credential store (Windows Credential Manager / macOS Keychain / libsecret via `@napi-rs/keyring`) with a `0600` `db.key` file fallback. Pre-existing plaintext DBs auto-migrate on startup (`PRAGMA rekey` on a verified copy) keeping a `.pre-encryption.bak`; backups of encrypted DBs stay encrypted (`VACUUM INTO` fallback).
- **Stage-0 secret redaction** (SEC-3..6): pattern + entropy detectors (AWS/GitHub/Azure/GCP/Slack keys, generic credentials, JWTs, PEM blocks, connection strings, config custom patterns) run at the ingest choke point and on `/remember` before anything is persisted. Placeholders `[REDACTED:<type>:<hash8>]`; counts-only `redaction_log` (migration 005); surfaced via `doctor` and `/health`.
- **Bearer token → OS credential store** (SEC-10): `secrets.env` kept as read-only fallback; file-only bearers are promoted one-way into the store.
- **D-DEF1 fixed**: canonical JSON turns are flattened to `role: text` lines at pipeline entry — role attribution reaches extraction.
- **D-DEF2 fixed**: `ingest_idempotency.summary_memory_id` is backfilled with the first real memory id after distillation.
- **CLI un-stubbed**: `queue` (job state counts + recent failures), `rebuild` (enqueues reembed jobs), `providers` (config + live chat/embed probes).
- **Dashboard auth hardening**: bearer no longer lives in the URL — `?token=` is a one-time bootstrap exchanged for an HttpOnly SameSite=Strict cookie via 302; `Authorization` header also accepted; 401 logs strip the query string.

### Added — Wave 2: contract + flywheel

- **Atom v3** (ADR-001, migration 006): `memories` gains bitemporal validity (`valid_from`/`valid_to`), `superseded_by`, `derived_from` lineage, and `scope` (`personal`/`team`/`org`, default `personal`). Search and `/recall/pack` exclude invalidated memories; receipts (`why_memory`) still see them.
- **`memory_events` append-only log** (ADR-002, migration 007): `create`/`invalidate`/`supersede`/`promote_scope`/`erase_request`/`usefulness` events with synthetic hash-stable `create` backfill; state change + event append in one transaction. Lifecycle REST: `POST /memory/:id/{invalidate,supersede,promote}`, `GET /memory/:id/history`.
- **MCP lifecycle tools** (ADR-007): `invalidate_memory`, `supersede_memory`, `promote_memory`, `memory_history`; `why_memory` now returns the populated `history` chain. MCP server exposes 11 tools.
- **`events` capture kind** (ADR-008): `POST /ingest/transcript` accepts `kind: "events"` — pre-typed atom candidates (runner-plugin grades/lessons/verdicts) that are redacted, stored, and enter the pipeline at stage 6 (reduce → normalize → embed+index) via the new `distill-events` job. Public protocol doc: `docs/capture-protocol.md`.
- **Recall-usefulness metric** (ADR-010 v1): `recall_served` / `recall_used` / `memory_corrected` event families captured from day 1 (query text never stored — sha256/16 hash only). Explicit feedback via MCP `mark_memory_used` + `REST POST /memory/:id/used`. Rate surfaced on `/health`, `doctor`, and a dashboard section. Measure-only in v1.
- **init: memory-pack hook auto-install**: `astramem-local init` offers to install the KF-B SessionStart hook into `~/.claude/settings.json` (idempotent, platform-appropriate command, `--no-hook` to skip); flips `recallPack.enabled`.

### Changed

- `SCHEMA_VERSION` 4 → 7 (migrations 005 security, 006 atom v3, 007 memory events).
- `/health` gains `security: { encryption, redaction }` and `usefulness: { served_7d, used_7d, rate_7d }`.

---

## [0.4.0] — 2026-07-01

### Added

#### Read-only HTML dashboard at `GET /dashboard`
- **`GET /dashboard?token=<bearer>`** — single-file HTML metrics page auto-refreshing every 5 seconds via `<meta http-equiv="refresh" content="5">`. No JS, no CDN, no external assets. Dark mode by default (`#1a1a1a` bg, `#e0e0e0` text).
- **Metrics rendered** (one SQLite pass):
  - Memory counts by type — CSS bar chart driven by `SELECT type, COUNT(*) FROM memories GROUP BY type`.
  - Recent captures — last 25 memories with truncated text (120 chars), `HH:MM:SS` timestamp, type badge, importance, confidence, session prefix.
  - Job queue state — colored badges: `poison` red, `pending` yellow if >3, `completed` green, `running` blue.
  - Distill throughput last 24h — text-bar histogram by hour.
  - Provider state — table with health status and last-check timestamp.
  - Budget — today spend + MTD spend vs daily cap from config; delta color (green <50%, yellow 50-80%, red >80%).
  - Pending queue — file count + oldest age from `%APPDATA%\Astramem\pending\`; shows "0 pending" if dir absent or empty; wrapped in try/catch.
- **Auth**: same Bearer token as all other authenticated routes, supplied as `?token=`. Missing/wrong token → 401 plain text (not HTML). Dashboard is excluded from the `Authorization` header preHandler check; it enforces its own query-param auth.
- **New files**:
  - `src/server/routes/dashboard.ts` — Fastify route factory.
  - `src/server/routes/dashboard-html.ts` — `renderDashboard(data, config): string` server-side HTML renderer.
  - `src/server/queries/dashboard.ts` — extracted read queries (testable without route layer).
  - `tests/server/dashboard.test.ts` — 16 inject tests covering 401/200, content-type, all section headers, meta-refresh, no-script, cache-control, public-route preservation.
- **`AppOpts`** gains optional `config?: Config` field (defaults to `defaultConfig()`); used by dashboard for budget cap display.

### Changed
- `src/server/app.ts` preHandler skip-list extended to include `/dashboard` (dashboard handles own auth via `?token=`).

---

## [0.2.0] — 2026-06-30

### Added

#### Wire protocol alignment (SaaS-canonical envelope)
- **`POST /ingest/transcript` accepts SaaS-canonical envelope** — new shape: `{event, session_id, turns[], wire_version (required, regex `^v\d+\.\d+$`), captured_at, client_version, client_scrub_version, client_scrub_hits_by_label, project_id?, cwd?, agent_type?}`. Legacy `{session_id, source, content}` shape still accepted — both parse and ingest correctly, backward-compatible distiller dual-reads.
- **`GET /version` endpoint** — public endpoint (no Bearer required), returns `{name, version, wire_versions_supported: ['v0.0', 'v1.0'], schema_version: 2, ts: ISO-8601}`. Matches SaaS discovery contract.
- **`GET /health` wire metadata** — extended response to include `wire_versions_supported` and `schema_version` (was `ok` + `version` only).
- **Idempotency header support** — `Idempotency-Key` on `POST /ingest/transcript` deduplicates via SHA-256 body hash. New `ingest_idempotency` table (PK: `idempotency_key`, unique index: `(idempotency_key, request_hash)`). Same key + same body → 200 + original `transcript_id` (replay); same key + different body → 409 Conflict.

#### Schema extension (migration 002)
- **`transcripts` table gains 8 new nullable columns**:
  - `event: TEXT` — event type ('pre_compact', 'session_end', 'subagent_stop')
  - `turns: TEXT` — newline-joined `role: text` pairs from `turns[]` array
  - `captured_at: TIMESTAMP` — ISO-8601 event timestamp
  - `client_scrub_version: TEXT` — scrubber version from client
  - `client_scrub_hits_json: TEXT` — stringified `{label: count}` map
  - `client_version: TEXT` — client plugin version
  - `project_id: TEXT` — SaaS project identifier
  - `cwd: TEXT` — working directory context
- **`wire_version` column on `transcripts`** — TEXT NOT NULL DEFAULT `'v0.0'`. Existing v0.1.x rows automatically backfilled; new rows adopt the sent `wire_version` (or default 'v0.0' if omitted in legacy envelope).
- **`ingest_idempotency` table** — stores `(idempotency_key TEXT PRIMARY KEY, request_hash TEXT UNIQUE, transcript_id TEXT, created_at TIMESTAMP)`.

#### Testing
- **9 new E2E integration tests** covering dual-envelope parsing, idempotency replay/conflict, `/version` endpoint, `/health` metadata, wire_version backfill. Full integration test suite: 429 passing.

### Changed

- **No breaking changes** — legacy `{session_id, source, content}` envelope preserved and fully supported. Daemon recognizes both shapes; distiller dual-reads with fallback.
- **`POST /ingest/transcript` response shape** — now includes: `{summary_memory_id, extraction_job_id, extracted_count, failed_atom_count, scrub_hits: {client, server}, queued_extraction_types}`. Extraction fields stubbed (full job queue in v0.3.0+).
- **Service metadata** — daemon reports `schema_version: 2` on health and version endpoints.

### Commits

- `2a6d517` — Migration 002: wire-v1 columns + ingest_idempotency table
- `df4aef3` — Dual-envelope Zod schema (legacy + SaaS canonical)
- `c45d762` — Canonical insert + idempotency wired
- `70a0f2a` — /version endpoint + /health wire-support metadata
- `4d945ac` — E2E integration tests (9 cases)

### Known issues

- **KNOWN ISSUE: D-DEF1 — Distill pipeline turn-flattening** *(FIXED in 0.5.0)*: The distill pipeline currently consumes `transcripts.content` as a flat string. Canonical ingests write `JSON.stringify(turns)` into that column. Distillation quality silently degrades on canonical paths until the distill handler is updated to flatten turns to `role: text\n` pairs before pipeline entry.
- **KNOWN ISSUE: D-DEF2 — `summary_memory_id` semantic change** *(FIXED in 0.5.0)*: The `summary_memory_id` returned by `POST /ingest/transcript` is currently the transcript row UUID. Wave-3 distillation will produce a real summary memory with a different UUID. Clients MUST treat the value as opaque — in 0.5.0 the idempotency row is backfilled with the real memory id once distillation completes.

### Related specification

- [astramemory-plugin FEAT 4a](https://github.com/astragenie/astramemory-plugin/blob/main/docs/superpowers/specs/2026-06-29-hooks-provider-migration-4a.md) — end-to-end three-repo wire contract convergence (daemon, plugin, SaaS). Daemon v0.2.0 = Phase 2 implementation.

---

## [0.1.4] - 2026-06-28

### Fixed

#### Windows install hardening
- **Startup-folder fallback** when `schtasks /sc onlogon` returns "Access is denied"
  even with `/RU "%USERNAME%" /IT /RL LIMITED`. Adapter now drops a `.cmd` shim into
  `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` so the daemon launches
  at next logon without admin privileges.
- **Auto-read bearer from `secrets.env`** during `astramem-local install` so a
  freshly seeded secrets file is picked up without manual env var export.

### Changed
- `GET /health` and MCP daemon-version constant bumped `0.1.3` → `0.1.4`.

---

## [0.1.3] - 2026-06-27

### Added

#### MCP HTTP server (Wave 5)
- `POST /mcp` — MCP Streamable HTTP transport (JSON-RPC 2.0, stateless per-request).
  Auth enforced by existing Bearer preHandler; no new auth code.
- 4 MCP tools auto-discovered by Claude Code:
  - `search_memory` — hybrid FTS + vector search with filters (type, repo, project, since).
  - `recall_memory` — top-K semantic recall (alias of search_memory, default k=5).
  - `remember` — direct memory insert, bypasses distillation pipeline.
  - `get_health` — daemon health probe (`{ ok, version }`).
- Zod-validated input schemas on all 4 tools; structured text/JSON output.
- 7 integration tests in `tests/mcp/server.test.ts` covering tools/list, each tool/call, and auth gates.
- Uses `@modelcontextprotocol/sdk@^1.29.0` (`McpServer` + `StreamableHTTPServerTransport`).

### Changed

- Version bumped from `0.0.1` to `0.1.3`.
- `GET /health` now reports version `0.1.3`.

---

## [0.1.0] - 2026-06-27

First public release. Covers Milestones 1-5 of the v1 design spec: storage, pipeline,
distillation, hybrid search, and installer.

### Added

#### Storage (Wave 1)
- SQLite schema v1: `sessions`, `messages`, `transcripts`, `memories`, `jobs`, `artifacts`,
  `provider_state`, `budget_spend` tables.
- FTS5 virtual table `memories_fts` with auto-maintained triggers on insert, update, delete.
- sqlite-vec virtual table `memories_vec` — 1024-dim FLOAT vector index.
- `schema_version` migration runner — idempotent, append-only migration files under `migrations/`.
- WAL mode + `foreign_keys ON` + `synchronous = NORMAL` pragmas applied at DB open.
- `MemoryRepo` — insert with hash deduplication, FTS5 keyword search.
- `SqliteVecStore` — upsert and cosine-distance ANN search via sqlite-vec.

#### HTTP daemon (Wave 1)
- Fastify HTTP server bound to `127.0.0.1` (loopback only).
- `GET /health` — returns `{ok: true, version}`. No auth required.
- `POST /ingest/transcript` — wire-compatible with `memory-plugin` hooks. Writes session +
  transcript + queues a `distill` job atomically. Requires Bearer token.
- `POST /recall` — hybrid search with body `{query, k, filters}`.
- `POST /remember` — direct memory insert, bypasses distillation pipeline.
- `GET /search` — query-string hybrid search.
- `GET /memory/:id` — single memory lookup.
- Zod request validation on all endpoints. 400 on schema failure, 401 on missing/wrong token.

#### Pipeline and workers (Wave 2)
- Job table state machine: `pending -> running -> completed | failed | poison | paused`.
- In-process polling worker loop — configurable poll interval.
- Retry with exponential backoff; job transitions to `poison` after 3 failed attempts.
- Handler registry — `register(kind, handler)` map.
- `cleanup` handler — prunes sessions and artifacts older than 30 days.

#### Hybrid search (Wave 2)
- Score fusion: `alpha * norm(BM25) + beta * norm(cosine) + gamma * importance + delta * freshness`.
- Default weights: alpha=0.4, beta=0.4, gamma=0.1, delta=0.1 (config-overridable).
- Query filter parser: `type:decision`, `repo:astramemory-local`, `since:7d`.
- FTS-only fallback when no embeddings exist for a memory (beta=0 path).

#### Service install (Wave 2)
- `ServiceAdapter` interface with per-OS implementations: systemd (Linux), launchd (macOS),
  schtasks (Windows).
- User-scope install — no admin/UAC required on any platform.
- `astra-memory service install|status|start|stop|uninstall` CLI commands.
- Doctor checks contributed by each track owner via plugin architecture.

#### Providers (Wave 2)
- `LLMProvider` interface: `chat(messages, opts) -> {text, usage}` + `health()`.
- `EmbedProvider` interface: `embed(texts) -> Float32Array[]` + `health()`.
- Ollama LLM adapter — chat via `/api/chat`, health via `/api/tags`. Cost always `$0`.
- Ollama embed adapter — embed via `/api/embeddings`, validates 1024-dim output.
- Azure OpenAI LLM adapter — chat completions, cost computed from token usage + pricing table.
- Azure OpenAI embed adapter — `text-embedding-3-small` with `dimensions=1024` parameter.
- Contract test suite shared across all four provider implementations.

#### Distillation pipeline (Wave 3)
- 8-stage distillation pipeline: cleanup, normalize, chunk, compact, extract, reduce,
  memory-normalize, embed+index.
- Stage 1 (cleanup): regex deduplication, whitespace normalization, repeated tool output removal.
- Stage 2 (normalize): path canonicalization, timestamp normalization, agent name normalization.
- Stage 3 (chunk): token-aware chunking (~800 tokens), respects turn boundaries.
- Stage 4 (compact): LLM call per chunk to remove redundancy.
- Stage 5 (extract): LLM JSON-mode, emits typed atoms. Zod-validated. Retries once on parse
  failure with stricter prompt.
- Stage 6 (reduce): hash-merge duplicate atoms across chunks.
- Stage 7 (memory-normalize): canonical text, lowercase entity dictionary, final hash.
- Stage 8 (embed+index): embed via configured provider, write `memories` row + `memories_vec`
  row + FTS5 update.
- `ExtractionSchema` (Zod): `{type, text, importance, confidence, evidence}`.
- Memory types: `decision`, `fact`, `lesson`, `command`, `todo`.
- Idempotency: same `session_id + source_hash` short-circuits without re-processing.
- Budget tracker: pre-call cap check, `paused` job state on cap exceeded, per-day spend record.
- `astra-memory budget` CLI: show today + month spend. `--reset` override (logged).

#### Install wizard (Wave 4)
- `astra-memory init` — interactive wizard using `@inquirer/prompts`.
- Wizard flow: vector store, embedding provider, LLM provider, data directory, port, budget cap,
  service install.
- Conditional provider checks: Ollama reachability, model presence, Azure ping.
- Writes `config.yaml` + `secrets.env` (mode 0600) + generates 32-byte random Bearer token.
- Runs migrations and doctor on completion; prints next-steps block.
- `astra-memory token rotate` — generate new token, invalidate old, rewrite secrets.env.
- `astra-memory token print` — print current Bearer token.

#### Doctor (Wave 2-4)
- `astra-memory doctor` — prints check table; exits 0 if all green, 1 if any red.
- `--json` mode for CI/scripting.
- Checks: SQLite writable + WAL, FTS5 + sqlite-vec loadable, daemon reachable, LLM provider
  < 5s, embed provider 1024-dim, pipeline queue not stuck, disk free > 1GB, service unit
  present and active, budget within cap, embedding provider mismatch.

#### CI (Wave 4)
- GitHub Actions matrix: ubuntu-latest, macos-latest, windows-latest x node-20, node-22.
- sqlite-vec prebuilt verified on all three OS targets.

#### Documentation (Wave 4)
- Full README with architecture diagram, provider matrix, commands index.
- `docs/migration-from-saas.md` — step-by-step guide for switching from SaaS to local.
- `docs/configuration.md` — config.yaml reference with all fields and defaults.
- `docs/providers.md` — Ollama and Azure OpenAI setup instructions.
- `docs/troubleshooting.md` — common issues and fixes.
- `docs/contracts.md` — frozen type interfaces for contributors.

### Changed

- `README.md` replaced Wave 1 stub with full v1 documentation.

### Known limitations

- Distillation lag: memories are not searchable until the distillation worker processes the
  queue (~5-30s typical with Ollama running locally). Ingest is synchronous; distillation is
  async.
- Loopback only: daemon binds `127.0.0.1`. Remote access requires `--allow-network` flag (not
  recommended; no TLS in v0.1.0).
- Single embedding space: all memories must use the same embedding model. Changing the model
  requires `astra-memory rebuild --reembed`.
- No SaaS sync: local memories are not synchronized to the AstraMemory cloud.
- No knowledge graph: relationships between memories are not modeled. Entity graph is deferred
  to v1.1.

[0.1.0]: https://github.com/astragenie/astramemory-local/releases/tag/v0.1.0
