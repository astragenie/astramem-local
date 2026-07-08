# 7-Day Release Sprint — astramem-local (+ plugin support, SaaS in parallel)
*2026-07-08 → release 2026-07-15 · companion to `2026-07-08-astramem-ecosystem-report.md`*
*Rev 2: recalibrated to 7 calendar days, 2 Claude subscriptions, LongMemEval REQUIRED before release, astramem-local as THE product. SaaS = parallel adoption track, non-blocking.*

## Capacity honesty: what "1 week" means here

Two Claude subscriptions running the marathon loop ≈ two parallel lanes, each doing what a small team does in a day per calendar day. Under that model:

- **All packaging/docs/publish work from the audit ≈ 1.5–2 calendar days of lane time.** It's mechanical, evidence is already gathered, most of it is find/replace + file creation + one npm publish.
- **LongMemEval is the long pole: 3–4 calendar days**, and unlike the packaging it is not purely agent-parallelizable — it burns wall-clock on ingestion/embedding of haystack sessions, LLM answer generation, judging, and (the real risk) *iteration if the first number is bad*.
- **The two human-gated items** that agents cannot compress: npm publish credentials/ownership check, and a macOS smoke pass if no Mac hardware is available (decision below).

So: 7 days is realistic **if LongMemEval starts Day 1 in its own lane** and the Day-4 decision gate below is respected. The failure mode is starting eval on Day 4.

## Shared-logic note (plugins-common)

`C:\work\mega\plugins-common` (bun monorepo: `@astragenie/astramem-client` 0.1.0, `@astragenie/gepa-core`, `@astragenie/plugin-kernel`) is the home for shared *client-side* logic. Division of labor, settled:

- **Wire contracts SoT stays `@astragenie/astramem-contracts`** (astramem-local `contracts/` — schemas, generated TS+Zod, publish CI, plugin already consumes it). Move the wire-version constants/regex + MCP tool manifest into it (post-release, not this week).
- **`plugins-common/astramem-client`** is where plugin provider/wire-probe/HTTP-client logic migrates over time — it depends on contracts, never the reverse.
- **memory repo's `@memoryservice/plugin-contracts` + `plugin-sdk`** are duplicates to retire onto the above (SaaS track, opportunistic).
- **Nothing shared-package-related blocks the release.** Only the daemon-side `wire_version` regex fix ships this week.

---

## The 7 days — two lanes

**Lane A = product/packaging. Lane B = LongMemEval.** Both lanes run the loop; you arbitrate at day boundaries.

### Day 1 (Tue 07-08)
- **A1**: LICENSE (MIT) + SECURITY.md + CONTRIBUTING.md. Verify npm ownership of the published `astramem-local` name (30-min check that decides A3's shape).
- **A2**: Docs truth pass — `astra-memory`→`astramem-local` (README 33x + 5 docs files), v0.1/v0.2 fossils out, embed model → `mxbai-embed-large` 1024-dim everywhere, build steps + ~5.4 GB pull warning in quickstart, dead cross-repo link, package.json repository/homepage/bugs, "16→15 tools".
- **B1**: LongMemEval harness scaffold: fetch dataset (LongMemEval_S first — the small variant), design the adapter: haystack sessions → `/ingest/transcript` (canonical envelope) → distill → question phase = `/recall` top-k → answer LLM → LongMemEval's own judge scripts. Decide answer/judge models + budget (judge quality matters more than answerer; keep answerer fixed and cheap so the number measures MEMORY, not the model).
- **B2**: Ingest throughput check — time 50 haystack sessions through the pipeline; if distillation is the bottleneck, batch/parallelize now.

### Day 2 (Wed)
- **A3**: npm publish 0.8.x (or scoped rename if Day-1 ownership check failed) + verify clean-machine `bun add -g` → `init` works; kill the SQLITE_NOTADB shadow.
- **A4**: `wire_version` minor-regex tighten (`ingest.ts:90`) + test. Init UX rework — **Ollama on-demand only**: init never hard-requires Ollama; wizard offers (a) install Ollama + pull models now (with explicit ~5.4 GB size + time notice), (b) point at existing Ollama/Azure, or (c) skip — daemon starts degraded (`/health: degraded`), doctor + first `remember` prompt the install when actually needed. Demo mode (A12) must work with zero Ollama.
- **A4b**: Extraction-model picker in init wizard [S] — today the model is hardcoded (`init.ts:293`: azure→`gpt-4.1`, ollama→`qwen2.5-coder:7b`); add a tier prompt: (1) default `qwen2.5-coder:7b` ~5 GB, (2) low-spec `phi4-mini`/`llama3.2:3b` ~2.5 GB, (3) quality `qwen3:14b` ~9 GB, (4) BYO cloud — each with size + RAM guidance; config.yaml `compaction.model`/`extraction.model` already support it, wizard just never asks.
- **A4c**: Generic `openai-compatible` LLM provider [S–M] — daemon has only ollama (`/api/chat` native) + azure-openai today; add base_url+key+model provider (standard `/v1/chat/completions`) so extraction can point at ANY endpoint: user's own vLLM box, a rented GPU VM, Groq, or a future hosted-extraction service. This is the no-Ollama story for remote-agent users (Telegram/OpenClaw/Hermes → daemon `/remember`+`/ingest`). Unlocks fixed-cost hosted extraction later without SaaS-ifying the daemon.
- **A4d** (week 2, after A4c): `codex-subscription` provider, EXPERIMENTAL — reuse the user's existing Codex CLI "Sign in with ChatGPT" login (`~/.codex/auth.json` token + refresh) so extraction runs on their ChatGPT Plus/Pro subscription quota instead of an API key (the OpenClaw/Hermes pattern; Supermemory ecosystem validates demand). Wizard: detect auth.json → offer with explicit warning (ToS gray zone — ban risk on user's account; private endpoint may break; extraction transits OpenAI). Graceful fallback to configured provider on failure. [M]
- **B3**: First LongMemEval_S run end-to-end on a subset (~50 questions). Debug adapter, not scores. Full-set run overnight.

### Day 3 (Thu)
- **A5**: Plugin pass (all S/S–M): README Quick Start fix (`astramem-connect` claim-code path), env-var table regenerated from env-specs.ts, `MEMORY_API_URL` MCP docs fix (or `connect` writes it), `bin/astramem --version` bump, dead `/register` probe removed, marketplace description = 15 tools, `.env.local`/`.env.azuredev` → genericized example.
- **A11** (packaging parity, from supermemory matrix): `astramem-local mcp install --client claude|cursor|windsurf|vscode` — writes the client's MCP config with URL + bearer automatically. [S–M]
- **B4**: First full LongMemEval_S number. Failure-mode analysis by question type (temporal reasoning, multi-session, knowledge-update — where memory systems die). Cheap wins first: k, recall filters, `--as-of` for temporal questions, session_digest context.
- **A6** (background): Ubuntu clean-VM smoke (`init→reinstall→ingest→recall`).

### Day 3–4 (packaging parity track, continues alongside)
- **A12**: `astramem-local demo` — 30-second trial: `ASTRA_MEMORY_DATADIR=:memory:`, foreground serve, seeded example memories, **no Ollama required** (deterministic hash-embed fallback or degraded mode), prints recall demo + next-steps. Counters `npx supermemory local`. [S–M]
- **A13**: `install.ps1` + `install.sh` one-liners — node check → `npm i -g` (post-A3 publish) → `astramem-local init`. Hosted via repo raw URL; README quickstart becomes one line. [M]

### Lane B reality update (2026-07-08 evening, from live adapter measurements)
Measured extraction throughput on the dev machine: **45–60s/session** (qwen2.5-coder:7b local) — full 500-question ingest ≈ **14 days single-threaded**; even the 50-question smoke ≈ 34h. Consequences:
- **Rent GPU for the eval week** (user-approved direction: fixed-cost VM ~$400/mo class, 4090/A10): run Ollama with `qwen2.5-coder:7b` remotely, point sharded daemons' extraction at it via the ollama provider's existing `baseUrl` config (`src/providers/llm/ollama.ts:62` — works today, no new code). Expected 5–10× → smoke in hours, full run 1.5–3 days. LongMemEval publishes on the 1.5–2-week track (user-accepted), not day 4; the Day-4 gate below becomes "publish ADR-005 floors at release, LongMemEval number follows in week 2 announcement update."
- **Three daemon bugs found by the eval work — promote to Week-1 fixes, priority order**: (1) **`as_of` keyed on ingest wall-clock, not `captured_at`** — bisected empirically: hits cut over exactly at real ingest date; `valid_from` never consumes the envelope's `captured_at`. Breaks the advertised bitemporal feature for any backfilled content and deterministically zeroes 42% of LongMemEval (temporal + knowledge-update). Fix: plumb `captured_at` → `valid_from` at index time [S–M + migration thought for existing rows]; (2) `buildSessionDigest` reports `ready` when a distill job went `poison` (provenance.ts:102-107) — silent memory under-count, affects plugin digest too [S]; (3) daemon spawn isolation — `resolveRuntimeConfig` merges real `sync.json` even under `ASTRA_MEMORY_DATADIR` override; eval nearly shipped synthetic data to the prod tenant. Isolation env or documented full-env sandbox [S]. Evidence for all three: `scripts/eval/longmemeval/README.md`.

### Day 4 (Fri) — **DECISION GATE**
- **B5**: Iteration 2 with tuned retrieval. By end of day the number is what it is.
  - **≥ competitive floor (~60%+, i.e. Zep-class or better)** → publish score + full methodology. Proceed.
  - **Below floor** → ship anyway on schedule, README publishes the ADR-005 CI-gated floors as the headline eval + LongMemEval as "run honestly, number and methodology here, improving in the open." Per the report: the field's credibility crisis makes an honest mid-pack number with reproducible methodology worth more than silence — and infinitely more than a tuned-to-the-test number. **Do not slip the date for the score.**
- **A7**: macOS smoke — if Mac hardware exists, run it; if not, mark macOS "community-tested" honestly in README (launchd code is unit-tested only; saying so beats claiming support). Windows already battle-tested.
- **A8**: README eval section drafted both ways, pending B5.

### Day 5 (Sat)
- **A9**: Demo assets: asciinema/gif — Claude Code session → memories form → new session recalls → `why_memory` receipt. Announcement draft (angle: local-first, encrypted, provenance-receipted, honest evals; contrast Supermemory cloud-MCP + Mem0 junk-audit).
- **B6**: Eval write-up: methodology doc in `docs/eval/` (dataset, models, exact commands, per-category breakdown, what we didn't tune). Reproducibility = the credibility play.
- **A10**: File GitHub issues for everything deferred (Month-1 list) so the repo looks alive on day one.

### Day 6 (Sun) — freeze
- Full regression: vitest (incl. ADR-005 gate) + smoke + plugin roundtrip CI green. Fresh clean-machine install following ONLY the new README, on Windows + Ubuntu. Fix nothing but breakage. CHANGELOG entry. Release checklist walk (secrets audit already clean per security pass).

### Day 7 (Mon 07-15) — ship
- Tag (version-tag parity CI gates), npm publish final, marketplace sync, announcement out (HN/X/Reddit r/ClaudeAI). Monitor first-install reports; hotfix lane on standby.

**Cut from the week** (unchanged from report): CI runners for Win/macOS, SDK work, sync completion, contracts 1.2.0 publish, plugin-as-installer funnel, anything on the Kill List. All filed as issues Day 5.

---

## Parallel adoption track — SaaS (non-blocking, runs whenever)

Not on the critical path; sequence when convenient:
1. `v0.8.4` tag → deploys merged `content_hash {32,64}` relax (memory#621; scope-confirm — tag releases all of main).
2. `Sync__Enabled=true` + tenant allowlist (memory#667). Then verify daemon pair→promote→`push_seq`.
3. Redeem `apiUrl`: prod `Auth__PublicApiUrl` + fix code fallback (`ClaimsController.cs:92-94`).
4. Contracts parity CI (validate C# literals vs `@astragenie/astramem-contracts` fixtures); adopt the fixed regex.
5. Later: retire `@memoryservice/plugin-contracts` onto the shared SoT; grow SDK past 4 methods before any `sdk-v*` tag; pgvector-vs-Qdrant decision; JWT audience validation (T8).

## New feature tracks (added 2026-07-08 evening, user-prioritized)

**Agent self-improvement / profile (HIGH-VALUE differentiator — Month 1 start).** Substrate exists: `memories.agent` column + hard filter (FEAT-423) + η soft-boost (FEAT-426), `lesson` typed atoms, ADR-010 usefulness signals, consolidation. Missing synthesis layer:
1. `GET /agents/:name/profile` + `agent_profile` MCP tool — usefulness-weighted top lessons, recent decisions, corrected-atom warnings [M]
2. Profile maintenance via the existing consolidation pass (living per-agent profile, event-sourced → provenance-receipted profile, unique in market) [M]
3. Plugin SessionStart injects agent profile block alongside project recall (Supermemory pattern: profile inject every N turns) [S, plugin side]
Positioning: Supermemory has profiles (opaque, cloud); ours are auditable (`why_memory` on profile entries) and feedback-driven.

**Agent-platform integrations for Supermemory parity (Month 1–2).** Their mechanism (verified): per-platform PLUGINS using each framework's hook system — OpenClaw: `openclaw plugins install @supermemory/openclaw-supermemory`, auto-capture after every turn + auto-recall inject before every turn + profile every 50 turns + /remember //recall //forget commands; cloud-only, requires paid Pro; they even expose SUPERMEMORY_BASE_URL. Our path: same hook architecture we already ship for Claude Code — thin plugins per platform (OpenClaw first [M], then Hermes [M], NanoClaw [S–M]) hitting the local daemon REST, client logic from plugins-common `astramem-client`. Lead: local, free, encrypted vs their paid cloud.

## Post-release Month 1 (already filed as issues Day 5)
Win/macOS CI runners + real service lifecycle test + init e2e; LongMemEval_M / LoCoMo runs; contracts 1.2.0 publish → plugin bump → wire constants into package; plugin-as-installer funnel; daemon #81 + shipper error bodies; LanceDB option removal.

## Risks

| Risk | Mitigation |
|---|---|
| LongMemEval number embarrassing | Day-4 gate: ship with honest number + methodology; date never slips for score |
| Eval iteration eats Lane B past Day 5 | LongMemEval_S only this week; _M is Month 1 |
| npm name not owned / publish friction | Day-1 30-min check; fallback = scoped `@astragenie/astramem-local`, README consistent either way |
| No Mac hardware | "community-tested" honesty in README; CI runner Month 1 |
| API rate limits (hit today) | Loop retries + Sonnet for bulk eval agents; keep Fable for judgment-heavy work |
| Marathon loop + hand-edits collide | Keep lanes in separate worktrees per loop rules; docs pass and eval never touch the same files |
