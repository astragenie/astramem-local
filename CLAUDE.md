# astramemory-local — session guidance

Local-first memory daemon. TypeScript + Node 20 + Fastify + better-sqlite3 + sqlite-vec.
Wire-compatible with astramem-plugin (v0.5.2+) and memory SaaS backend (FEAT-4a Phase 1).

## Architecture verdict (2026-07-13) — do not re-litigate this per session

A 6-agent adversarial teardown investigation concluded **H2 — sound core, accumulated
debt; zero of five redesign gates cleared. Default to salvage, not rewrite.** Full
findings: `docs/research/20260713-teardown-and-reinvent.md`. The remediation plan
derived from it (tracks, slices, acceptance criteria): `docs/specs/20260713-teardown-remediation-plan.md`.
This is the answer to "should we redesign X" — read those two docs before proposing a
rewrite of the daemon, the storage layer, or the MCP transport; don't re-derive the
question from scratch.

## Install / onboarding

The wizard IS the installer. Do NOT hand-craft config.

```powershell
cd C:\work\mega\astramemory-local
bun install
bun run build
node dist/cli/index.js init
```

`init` writes `%APPDATA%\Astramem\config.yaml` + `secrets.env`, runs migrations, provisions the OS service (schtasks / systemd / launchd), runs doctor, prints next steps.

Prereqs the wizard checks: Node 20+, Ollama running with `mxbai-embed-large` (1024-dim, matches schema — do NOT use `nomic-embed-text-v2-moe` which is 768-dim; hotfix v0.2.1 swapped the default).

## Service / upgrade (post-hardening, feat/install-daemon-hardening)

One command fixes/installs/repairs everything — idempotent, non-elevated OK:
```powershell
node dist/cli/index.js reinstall     # materialize release → stop → shim → XML task → start → verify version
```
Upgrade flow: `git pull && bun install && bun run build && node dist/cli/index.js reinstall`.
Both `init` and `reinstall` also idempotently run `git config core.hooksPath scripts/git-hooks`
when invoked from a git checkout of this repo (`src/service/git-hooks-activate.ts`, FEAT-439
residual) — activates the migration-merge-currency post-merge hook with no separate manual
step; silent no-op for npm-installed users, who have no `.git` at their install location.

Architecture: schtasks task `AstraMemoryD` points at a STABLE shim
(`%LOCALAPPDATA%\Astramem\bin\astramemd.cmd` → `launch.cjs` → `current.json` pointer).
Upgrades rewrite the pointer only; schtasks is never re-touched. Task registered via
XML: no 72h ExecutionTimeLimit, logon trigger + PT5M repetition = keepalive watchdog
(dead daemon restarts ≤5min; healthy re-runs exit <100ms via `daemon.lock` instance lock).

`reinstall` materializes an immutable release under `%LOCALAPPDATA%\Astramem\releases\<pkgversion>+<gitsha>\`
before ever touching the running daemon (FEAT-438) and repoints `current.json` at it —
the mutable checkout's `dist/` is never served directly, closing the 2026-07-07
stale-dist outage class. Every successful `reinstall` also prunes old releases,
keeping the newest 2 (the just-verified one is always protected, even if older).

`reinstall --rollback` repoints at the previous release with no new
materialization and no schtasks re-registration (task registration happens
exactly once, at first install) — fails loudly with a non-zero exit and
leaves `current.json` untouched if there is no older release on disk.

`reinstall --dev` is the escape hatch back to pre-FEAT-438 behavior: pins the
service straight at the checkout's own `dist/cli/index.js` (mutable — dev
churn can restrand the daemon again) and prints a loud warning every time.
`doctor` flags a dev-pinned install with a WARN row; run plain `reinstall`
(no `--dev`) to return to a pinned release.

### Unix service parity (FEAT-443)

`service install` / `init` / `reinstall` share ONE install path
(`install-flow.ts`) on all three platforms now: systemd units and launchd
plists point at the same STABLE shim architecture Windows always used
(`<dataDir>/bin/astramemd.sh` → `launch.cjs` → `current.json` pointer, see
`shim.ts`) — upgrades repoint `current.json` only, the unit/plist is
registered exactly once at first install, and `reinstall --rollback` works
on linux/darwin exactly like it does on win32 (SLICE-1).

`Restart=on-failure` (systemd) and `KeepAlive` (launchd) only fire when the
daemon process actually exits — a daemon that's alive but wedged (blocked
event loop, deadlocked native call) keeps holding `daemon.lock` and answering
nothing, and neither mechanism ever notices (same blind spot Windows' PT5M
keepalive has always had — a healthy-looking re-run only checks that the
lock is HELD, not that the holder is responsive, so it restarts a *dead*
daemon but can never restart a *hung* one). SLICE-2 closes this for
linux/darwin with a separate recurring hang-watchdog probe (systemd
`OnUnitActiveSec` timer / launchd `StartInterval` agent, installed
automatically alongside the main service — not opt-in) that hits `/health`
every 3 minutes and, after 2 consecutive failures (not one flaky probe —
see `DEFAULT_FAILURE_THRESHOLD` in `src/service/watchdog-probe.ts`), kills
whatever actually holds `daemon.lock` and restarts via the adapter — see
that file for why this shells out to a probe+kill cycle instead of genuine
`sd_notify`/`WatchdogSec` (Node has no built-in Unix datagram socket
support). Invoke by hand with `astramem-local service watchdog-probe`;
remove with `service uninstall`.
**Windows parity (issue #206, 2026-07-13):** the same probe now also runs
on win32 as a second scheduled task (`AstraMemoryDWatchdog`, `schtasks.ts`'s
`installWatchdogTimer`) registered automatically by `install-flow.ts`
alongside the main `AstraMemoryD` task — closing the exact gap that bit in
production: a wedged-but-lock-holding daemon that the PT5M keepalive alone
could never recover, only a human noticing and killing the PID by hand.

**Package name: `astramem-local` on npmjs** — first published 2026-07-08 as v0.9.0
(this repo, SQLCipher-capable). The OLD stale 0.4.0 lives under the scoped name
`@astragenie/astramemory-local` on GitHub Packages (scope-mapped in ~/.npmrc) —
never install that one (plain better-sqlite3, `SQLITE_NOTADB` on encrypted DBs).
For dev work still prefer `node dist/cli/index.js <cmd>` from the repo; a stale
GLOBAL install can shadow dev expectations, and `reinstall` asserts served
version == build version to catch exactly that.

Boot is degraded-start: port binds immediately, embed probe retries in background
(`/health.status`: starting|ok|degraded). `--strict-preflight` restores fail-fast.

Foreground dev (no service): `node dist/cli/index.js serve --port 7777`
Diagnose: `node dist/cli/index.js doctor` (now reads config.yaml same as serve)

## Config paths (Windows)
- Config: `%APPDATA%\Astramem\config.yaml`
- Secrets: `%APPDATA%\Astramem\secrets.env` (contains `MEMORY_BEARER=<64-hex>`)
- Ingest log: `%APPDATA%\Astramem\ingest.log` (rotated at 10MB)
- SQLite: `%LOCALAPPDATA%\AstraMemory\memory.sqlite`

Non-Windows: `~/.config/astramem/` and `~/.local/share/astra-memory/`.

## MCP transport: two modes, not one

The daemon isn't the only way to run MCP. `node dist/cli/index.js mcp-stdio` (`src/cli/mcp-stdio.ts`)
is a **spawn-per-session MCP server over stdio** — same tool set, same db/embed wiring as
the HTTP daemon (`buildMcpServer()`, `src/mcp/server.ts`), just connected to a
`StdioServerTransport` instead of a Fastify route. Its own doc comment states the design
intent verbatim: *"No daemon lifecycle (no instance lock, no worker, no shipper, no
timers): this process is meant to be spawned per-client-session by an MCP host and to
exit when that host closes stdin."* Meant to be launched directly by an MCP host (Claude
Desktop, etc.), one process per session.

Consequence worth knowing: in `mcp-stdio` mode the PID-reuse kill hazard around
`daemon.lock` (see the instance-lock footgun, if documented elsewhere) **cannot fire** —
there's no lock file and no watchdog to mis-signal. But this mode is **not a daemon
replacement**. The long-lived HTTP daemon remains **mandatory** for: the LLM-proxy/capture
path (`src/proxy/server.ts:349` binds a real HTTP listener — a MITM proxy structurally
cannot be spawn-per-session, something must already be listening when the client
connects), background jobs (consolidate/cleanup/spool-drain), and sync. Pure MCP
consumers with no need for capture/proxy/sync can use `mcp-stdio` and skip the install
layer (service registration, shim, watchdog) entirely.

MCP tool surface: count not tracked here — a manually maintained number in this
file is exactly the ADR-016 Junction pattern (declare instead of derive) and
drifts the moment a tool is added. The count is enforced by
`tests/mcp/server.test.ts` and `tests/contracts/mcp-tool-manifest-parity.test.ts`,
both of which compare the live `tools/list` wire response against
`contracts/manifests/mcp-tools.v1.json` (the cross-repo tool-name SoT) — read
the manifest or run those tests for the current count, don't grep for
`registerTool`. Both transports (HTTP daemon, `mcp-stdio`) expose the same set.

## Wire contract (FEAT-4a Phase 2)

Daemon speaks BOTH envelopes on `POST /ingest/transcript`:
- **Canonical (v1.0)**: `{event, session_id, turns[], wire_version, client_scrub_*, ...}` — SaaS-aligned
- **Legacy (v0.0)**: `{session_id, source, content}` — backward-compat

`wire_version` regex: `^v(?:0|[1-9][0-9]*)\.[0-9]+$` — mirrors SaaS `IngestTranscriptRequest.cs:65` and plugin `wire.ts:106` (v0.2.1 tightened; prior versions accepted `v01.0`).

`GET /health` and `GET /version` are public (no Bearer). Everything else requires `Authorization: Bearer <token>` matching `MEMORY_BEARER`.

Idempotency via `Idempotency-Key` header: SHA-256 (stable-stringify) body hash. Same key + same body → 200 replay with `idempotent: true`. Same key + different body → 409.

## Entity relations (FEAT-481)

`entity_relations` table (migration 027) holds entity-to-entity relation triples, extracted
alongside each atom's `entities[]` list (engineering extraction profile only — see
src/distill/prompts/extract.ts). Two MCP tools read it: `get_entity_related` (bitemporal
`as_of` aware) and `get_entity_timeline`. `doctor`'s "Entity relations extraction" row is the
built-wired-never-invoked canary for this pipeline — WARN means real distill activity produced
zero rows; `relation_guard_drops` (migration 029) tells apart "model never emits a relation"
from "model emits relations but the guard drops every one."

## Contradiction detection ships `enabled` — Do NOT re-fix this as "off by default"

`defaultConfig()` sets `contradictionDetection: { mode: 'enabled', ... }` (`src/config/config.ts:623`).
It is **on**. The `DEFAULT_CONTRADICTION_DETECTION` constant (`config.ts:782-783`, `mode: 'off'`)
is a **governance-fallback** used only by `applyContradictionDetectionGovernance` when a
config override is missing or has an invalid `mode` — it is not the shipped default and
was never meant to describe the default. A prior session read that constant, concluded
contradiction detection ships off, and nearly re-shipped the fix that had already caused
an incident hours earlier.

**FEAT-482 incident (2026-07-13):** the flip from `off` to `enabled` shipped without a
call-count or wall-clock cap on the judge. It fired ~245 sequential LLM calls against a
metered endpoint (codex-subscription, billed to the operator's personal quota) and wedged
the daemon's sole worker lane for 10+ minutes. A **dollar-cap guard was tried and reverted**
(commit `0b6b3f8`) because every shipped LLM provider hardcodes `usage.usd: 0` — a budget
check can never trip. The live guards are `maxPerRun: 200` + `maxWallClockMs: 300_000`
(`config.ts:623-635`), both now in place. Full incident + retraction record:
`docs/specs/20260713-teardown-remediation-plan.md` §2.5.

If you're touching this again: don't flip the default, don't re-add a dollar cap. If
`maxPerRun`/`maxWallClockMs` ever need tightening, that's the lever — not `mode`.

## Citation drift caution

`src/distill/**` and `src/search/**` are under active edit as of 2026-07-13 — several
`file:line` citations across the docs written this session have already drifted (e.g.
`validityFilterClause` moved from `search.ts:264-278` to `search.ts:272-291` mid-session).
**Anchor on the symbol name, not the line number** — the line is a hint, the symbol is the
claim. See `docs/adr/ADR-015-loud-failure-invariant.md`'s citation policy for the same rule
stated in full. Every `config.ts`/`checks.ts`/etc. line cited below was re-verified against
this worktree's live source at write time, but re-verify before trusting a line number that's
more than a session old.

## Temporal reasoning — the schema is NOT at fault

Bitemporal storage (`migrations/006-atom-v3.sql`) and `as_of`-aware retrieval
(`validityFilterClause`, `src/search/search.ts:272-291`) are **both correct**. The LoCoMo temporal category score
(12.4) was an **extraction** gap, not a data-model gap — a full architecture investigation
concluded this; do not let any doc imply the schema needs replacing.

**Shipped 2026-07-13:** text-surface date grounding (PR #189 + timezone fix #191). Threads
`capturedAtMs` into the extraction prompt so relative expressions ("yesterday", "last
year") resolve to absolute dates inside the atom's own text — the part the retrieval
harness actually reads. This also helps live production ingest, not just the benchmark:
both `buildClaudeEnvelope` and `buildProxyEnvelope` already carry a per-session
`captured_at` anchor. Only legacy v0.0 envelopes and direct `/remember` calls lack one.

**Still open:** `AtomSchema` (`src/distill/prompts/extract.ts`) has no atom-level
`valid_at`/`invalid_at` field — only entities and relations get one. `InsertInput`
(`src/storage/memories.ts`) has no `valid_to` param at all, so nothing populates the
correct bitemporal columns for atoms. A fact that was "true Jan–Mar, false now" still
returns as eternally true. This earns zero LoCoMo points (the harness never sets `as_of`)
but is a real product gap. See `docs/specs/20260713-teardown-remediation-plan.md` §2.3
before building it — there's a migration hazard (legacy rows have `valid_to = NULL`,
which `as_of` filtering treats as "valid forever"; mixing in atoms with a real `valid_to`
makes that mixed state permanent unless the semantics are decided deliberately first).

## Known open gaps (2026-07-13) — this is a working doc, not a clean bill of health

- **Doctor never runs unattended.** `serve.ts` never calls `runChecks` — all three callers
  (`cli/doctor.ts`, `cli/init.ts`, `cli/providers.ts`) are manual. (`serve.ts` DOES import
  `doctor/probes/embed-probe.js` directly for the boot-time dim preflight — that's a
  different, narrower check than the full doctor suite.)
- **`checkMemoryHealth` (`src/doctor/checks.ts:680-694`) has exactly one return path:
  `{ok: true}`.** A 100% distill-poison rate still reports "memory health: OK."
- **`llmChatProbe` (`src/doctor/probes/llm-chat-probe.ts:19-22`) never passes `json:true`**,
  so it never exercises `format:json` — the exact request shape that broke qwen3 (empty
  response under thinking mode). A green probe is not evidence extraction works.
- **A well-formed `{"atoms":[]}` extraction completes successfully.** A broken model and a
  genuinely empty transcript are indistinguishable at every layer — not the Zod gate, not
  the job queue, not the poison counter (which only increments on failure, and a zero-atom
  success never fails). This is the headline finding of the teardown; see ADR-015.
- **Four tables have zero writers:** day-one `messages`, `artifacts`, `provider_state`
  (never written in this repo's history), plus in-flight `evidence_guard_drops`.
  `provider_state` is the worst — nothing writes it, but `src/server/queries/dashboard.ts:245`
  reads it, so it's an always-empty dashboard widget shipping to users, not just dead code.
- **LLM-proxy transcripts spool to disk plaintext, unredacted** (redaction happens at the
  daemon's stage-0 ingest, not at proxy capture). Files that fail JSON-parse or
  schema-validate quarantine to `.quarantine/` **before** ever reaching redaction — no TTL,
  no doctor canary. Malformed content disproportionately correlates with secrets/control
  characters, so the quarantine is a plausible place for a credential to sit indefinitely.
- **The qwen3 `think:false` guard is a name regex** (`/^qwen3/i`, `src/providers/llm/ollama.ts:95`),
  not capability detection. The config field's own doc comment (`ollama.ts:31`) names
  `deepseek-r1` as equally affected by the same thinking-mode/`format:json` conflict — it
  is not handled. A user picking `deepseek-r1` reproduces the "fixed" incident exactly.

## Bump discipline

`package.json.version` MUST match the git tag. `.github/workflows/version-tag-parity.yml` gates this on tag pushes. Bump package.json + tag same PR when cutting a release.

**Publish runbook: `docs/runbooks/release-publish.md`** (kb mirror: `kb/deployments/astramem-local-npm-publish.md`). `npm publish` auth = an npm **Automation** token in `~/.npmrc` (`//registry.npmjs.org/:_authToken=npm_...`) — Automation-type bypasses 2FA, so publish needs no OTP; a Publish/Granular token fails with `EOTP`. Package `astramem-local` on npmjs, owner account `heroboec`; regenerate token at npmjs.com → settings/heroboec/tokens → Classic → Automation. Token value lives ONLY in `~/.npmrc` (never committed).

## Recent (2026-07-01)

- v0.2.1 hotfix: swap embed default to `mxbai-embed-large` + boot-time dim preflight; regex tighten; version parity CI. See PR #4.
- Marketplace `astramem` entry tracks the PLUGIN version, not the daemon.

## Sensible defaults for testing
Local dev: `serve --port 7777` foreground, `ASTRA_MEMORY_DATADIR=:memory:` for throwaway state. Kill with Ctrl+C. Production-ish: `init` + `service install` + `service start`, real SQLite at default datadir.

## Formerly-deferred items — RESOLVED (verified 2026-07-03, do not re-fix)
- Turn flattening: DONE — `flattenTranscriptContent` (src/distill/flatten-turns.ts) wired at distill.ts:72 (D-DEF1, commit 55ac082). Canonical `JSON.stringify(turns)` flattens to `role: text` lines before the pipeline.
- `summary_memory_id`: DONE-as-designed — D-DEF2 backfill (same commit): first-response returns transcript UUID (distill is async — inherent), then `ingest_idempotency.summary_memory_id` is backfilled with the first real memory id post-distill; idempotent replays return it. Clients treat it as opaque.
- Retrieval eval gate: ADR-005 harness (tests/eval/retrieval-eval.test.ts) runs in every vitest/CI pass — recall@10 ≥ 0.9, NDCG@10 ≥ 0.7 regression floors, deterministic fake embedder.
- Usefulness → ranking: ADR-010 v1.x epsilon component live in src/search/fuse.ts (`epsilon: 0.1` default; Laplace-smoothed used/corrected per atom).

## Config reload (FEAT-433, resolved)
config.yaml is read exactly once per process at boot (`resolveRuntimeConfig` →
`loadConfigFromDisk`) — there is no live reload, so hand-editing it while the
service is running has no effect on the running process either way; the
change is picked up on the next restart. `writeConfig` (`init`,
`reembed-dim`, `pair`) now writes atomically via tmp-file + rename, so the
DAEMON's own writes (including the schtasks keepalive racing a restart) can
never be observed torn — that's the footgun this warning used to be about,
and it's fully closed.
Guarantee, precisely: a fully-empty boot-time read is retried then WARNs +
falls back to defaults; a non-empty read that parses to zero keys (cut off
before any complete line) also WARNs + falls back. A hand-edit's own save is
NOT atomic, though — if a restart lands mid-save AFTER at least one complete
key: value line was written, the loader applies that partial content with no
warning (indistinguishable from an intentionally minimal config). Stop the
service before hand-editing config.yaml to avoid that narrow window; don't
rely on the loader alone to catch it.

## LLM sampling: `num_ctx` and `temperature` (v0.16.0 — both were silently broken for months)

Two provider-level bugs made extraction quietly worse for months. Neither ever
errored; both just produced thinner, lower-quality output — the exact
success-and-silent-failure-look-identical class ADR-015 exists to kill.

### `num_ctx` — sized dynamically, never hardcode it

`src/providers/llm/ollama.ts` sizes the context window **per call**:

```
num_ctx = clamp(inputChars/4 + maxTokens + 512, 4096, 16384)
```

- **floor 4096** — Ollama's observed per-model default; never shrink below it.
- **cap 16384** (`NUM_CTX_CAP`) — VRAM guard. Native context on these models goes
  to 32K, but an unbounded `num_ctx` lets a *background daemon* claim more memory
  than it should. Raise this only with a VRAM measurement, not a hunch.
- `inputChars/4` = `CHARS_PER_TOKEN` heuristic; `+512` slack for chat-template overhead.

**The bug (fixed):** `num_ctx` was never set *anywhere*, so every call ran at
Ollama's default **4096**. The v3 engineering extraction prompt alone is
**~3.8k tokens** — add a transcript chunk and an output budget and it overflowed.
**Ollama silently truncates on overflow rather than erroring**, so the only
observable was "the model returned less" (3 atoms collapsed to 1). This is what
kept entity extraction ~87% broken for weeks with a green doctor canary (#200).

### `temperature` — set per stage, never globally

| Stage | temp | where |
|---|---|---|
| 04-compact | `0.1` | `src/distill/stages/04-compact.ts:80` |
| 05-extract | `0.1` | `EXTRACT_TEMPERATURE`, override with `ASTRA_EXTRACT_TEMP` (`0` = fully deterministic JSON; an a/b lever for stochastic parse failures) |
| entity extraction | `0.1` | `src/entity/extract-entities.ts:76` |
| contradiction judge | `0` | `src/consolidate/contradiction-judge.ts:89` |

**The bug (fixed):** the provider spread `{ options: {...} }` **twice** — once for
`temperature`, once for `num_predict`. **A second top-level spread of the same key
REPLACES the first rather than merging**, so `temperature` was silently dropped on
every call that also passed `maxTokens` — i.e. **every real extraction, compaction,
and entity call in production**, since all three always pass both.

**Rule: build ONE `options` object.** Never spread `options` more than once into an
Ollama request body. Any quality baseline measured before v0.16.0 ran with no
temperature control and a truncated context — treat those numbers as invalid.

## Do NOT
- Do NOT commit `secrets.env` or the SQLite file — both in `.gitignore`.
- Do NOT spread `options` twice into an Ollama request body (see above) — the
  second spread silently replaces the first, dropping `temperature`/`num_predict`.
- Do NOT hardcode `num_ctx`. It is sized per call; a fixed value that happens to fit
  today's prompt silently truncates tomorrow's.
- Do NOT kill processes machine-wide by image name (`taskkill /F /IM node.exe`, `/IM bun.exe`, `Stop-Process -Name node`). This box runs the production daemon, eval shard daemons, Ollama, and sibling agents' processes — an image-name kill murders all of them (2026-07-10: killed a 40-min LongMemEval run + prod daemon). Kill only PIDs you spawned (track them; use process-tree kill on your own root PID). If stray vitest daemons pile up, find YOUR strays via their listen ports / datadir paths and kill those PIDs.
- Do NOT `git stash` in worktrees — the stash stack is repo-global across all worktrees; a `stash pop` in one worktree can eat a sibling agent's stash (caused a 2026-07-09 work-loss race). Use `git diff > x.patch` + `git checkout` + `git apply` instead.
- Do NOT hand-edit `memories_vec FLOAT[N]` in a migration file directly. Since FEAT-409 (merged) the dim is single-sourced from `DEFAULT_EMBED_DIM` (`src/contracts/embed.ts`) — config default, embed providers, `SqliteVecStore`, mock providers, the `__EMBED_DIM__` migration placeholder, and the boot-time preflight (`src/doctor/probes/embed-probe.ts`) all derive from it or from `getVecSchemaDim()`. Changing the *default* is a one-constant edit for fresh DBs; migrating an *existing* DB's live vectors to a new dim requires `astramem-local reembed-dim` (migration 011, `docs/embed-dim-migration.md`) — there is no ALTER for a sqlite-vec vec0 table. FEAT-436 (2026-07-05) re-audited this and confirmed it is resolved, not an open coordinated-change hazard.
- Do NOT construct a month-arithmetic `Date` via `setUTCMonth`/`setMonth` on a `Date`
  still carrying the anchor's own day-of-month. It silently overflows forward whenever
  that day doesn't exist in the target month (`2023-07-31` + 1 month lands on the
  nonexistent Aug 31, which JS normalizes into September instead of throwing) — bit
  `src/distill/temporal-grounding.ts`'s `addMonthsUtc` and shipped behind 307 green tests
  because the whole suite anchored on the 15th, the one day-of-month that can never
  trigger it (fixed same day; see `docs/research/20260713-temporal-grounding-regex-postmortem.md`).
  When only month/year granularity is needed, construct fresh via
  `new Date(Date.UTC(year, month, 1))` instead — no day value left to overflow. Any
  future month-arithmetic helper needs an explicit month-end-anchor test (29th/30th/31st),
  not just mid-month ones.
- During a `git rebase`, `--ours` is the UPSTREAM side, not your commits — the inverse of a normal merge. Resolving a rebase conflict with `git checkout --ours` therefore keeps *main's* version and **discards your work**. Read the conflict markers; never pick a side by name. This already bit the repo once: PR #229's rebase resolved six test-file conflicts with `--ours`, silently reverting them back to their pre-fix hardcoded-literal state — and the suite stayed **green the entire time**, because the reverted literal happened to numerically equal the correctly-derived value at each point in the rebase (a test passing for the wrong reason). It took a human re-deriving the claim against `origin/main` to notice. Fixed in PR #233. See ADR-016 §3 Instance 1 and §5 rule 6.

<!-- crew:start -->
<!-- Crew framework memory. Run /crew:install after plugin updates that change framework memory. -->
@.claude/crew/constitution.md
<!-- crew:end -->

<!-- runner:start -->
<!-- Installed by /runner:install. Edit .claude/loop.json to change stack-specific commands; re-run /runner:install to regenerate this block. The full HARD RULES live at .claude/loop/rules.md so this block stays small in per-session context. -->

## Autonomous Loop — HARD RULES (summary)

This repo runs the Wiggin Loop autonomously. Full rules: `.claude/loop/rules.md`.

- **Run until PASS.** Do not stop for confirmation. Stop only when every acceptance criterion is PASS with evidence, or the work is externally blocked.
- **Auto mode (default — `loop.marathonMode: true`).** Loop walks the entire backlog. Stops only on backlog exhaustion, crew `escalated_to_human`, warn-severity pattern alerts, or high-severity cost alerts. Iteration cap and soft `blocked` badge are advisory in this mode — set `loop.marathonMode: false` in `.claude/loop.json` to restore the legacy five-condition gating.
- **Slice start ceremony.** Every slice MUST open via `/runner:slice start --id SLICE-NN` (rotates `currentRun` so cost auto-emit attributes the work correctly + refreshes `.claude/state/crew/slice-progress.md`).
- **Dispatch discipline.** The loop is an orchestrator, not an implementer. Hand the `slice start` return's `dispatchInstruction` to a crew builder subagent — `crew:fullstack-dev` (or the stack-specific `crew:backend-dev` / `crew:frontend-dev`), or generic `claude` (implementation only; there is no agent literally named `crew:builder`); after it returns, dispatch `crew:reviewer`, then `crew:validator` if behavior changed; pivot to `/crew:fix` on any needs_fix or fail. Inline implementation is reserved for trivial single-line fixups.
- **Slice close ceremony.** Every slice MUST close via `/runner:slice complete --id SLICE-NN` (writes handoff + final-synthesis + cost-report + cost-advise) followed by `/runner:slice grade*`. Manual file moves + a `docs(slice): mark ... complete` commit are NOT a substitute.
- **Build entry points.** `/crew:build` is the interactive single-slice path (lighter — no run-brief required). Autonomous loop is the unattended multi-slice path (full ceremony). Never run both against the same branch — they race on workflow-state.
- **Auto-continue.** After the ceremony, scan `.claude/artifacts/loop/specs/` → `.claude/artifacts/loop/backlog/pending/` → `.claude/artifacts/loop/backlog/triaged/` and promote the next item without asking.
- **Phase gate.** When the last slice in a phase completes, run `/runner:phase-gate` before starting the next phase.
- **Worktree parallelism.** Run parallel features in sibling git worktrees — each has its own `.claude/state/`. Cost attribution is auto-scoped per worktree. Use `crew fleet --repo "$PWD"` for a one-glance view. Never check out the same branch twice; never push from inside the loop.

First action when starting the runner: read `.claude/loop/rules.md` → `.claude/artifacts/loop/ai-loop/00-entry/MASTER_PROMPT.md` → `.claude/artifacts/loop/ai-loop/backlog/approved-slices.md`.

<!-- runner:end -->
