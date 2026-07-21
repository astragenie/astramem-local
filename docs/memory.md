# astramem-local — Memory (durable facts index)

Volatile, dated facts agents keep rediscovering. **Supersede entries by editing them in place**
(update the date + content) rather than appending forever — this file should stay a snapshot of
"what's true now," not a changelog. For history, see `.claude/artifacts/crew/{runs,handoffs}/`,
`CHANGELOG.md`, and git log.

`CLAUDE.md` should change rarely; this file is where the volatile state that used to be crammed
into it (dated corrections, incident narratives, current eval numbers) now lives, extracted during
the 2026-07-21 agentic-setup rebuild.

## Version / build status (verified 2026-07-21)

- **Current release: v0.20.0** (2026-07-20, `CHANGELOG.md` top entry) — 32 migrations, MCP tool
  count CI-enforced against `contracts/manifests/mcp-tools.v1.json`. `README.md` previously stated
  "v0.15.1" in two places (top badge line + Status section) — six releases stale; fixed this run.
  Re-verify against `CHANGELOG.md`'s top entry before quoting a version anywhere, it will drift
  again on the next release.
- **Local clone dir on this box is `C:\work\mega\astramem-local`** — folder renamed from the
  GitHub repo name `astramemory-local` (same rename pattern as `hero-crew`→`dev-team` elsewhere in
  the ecosystem). `CLAUDE.md`'s install snippet previously hardcoded `cd
  C:\work\mega\astramemory-local`, which doesn't exist on this machine; corrected this run to stop
  hardcoding a path.
- `SECURITY.md` previously said "Only the `0.10.x` line is currently supported" — ten minor
  releases stale (pre-1.0, no LTS branch exists); corrected this run to a policy statement instead
  of a version number.

## Publish-flow correction (2026-07-21)

`docs/runbooks/release-publish.md` step 6 told the reader to run `npm publish` manually after
pushing the release tag. `.github/workflows/publish.yml` triggers on any `v*` tag push and runs
`npm publish --access public --tag ...` in CI automatically — a manual publish after the tag push
collides with CI's own publish. This exact lesson was already learned once
(`.claude/crew/deployment.md`, 2026-07-12: *"The tag push IS the release — CI publishes
automatically. Do NOT run a manual `npm publish` afterward"*) but the runbook had drifted back to
the wrong instruction. Fixed in the runbook this run. **`kb/deployments/astramem-local-npm-publish.md`
mirrors the same stale instruction** — kb is out of this repo's edit scope, reported to the kb
owner instead of fixed here.

## LoCoMo / eval — current numbers (verified 2026-07-19, re-verify against the LEDGER — they drift)

Champion **0.6002** / service-day **0.5430** (conv-1, n=199); full-suite best **0.4840** (n=1986).
The 0.54→0.60 gap is **proven codex day-variance (±6 pts/day)**, not a missing lever — every config
A/B (chunk-size, sweeper-v1, temperature, maxTokens, compaction) is REJECTED. Canonical tracker:
`docs/eval-runs/README.md` — read it first; do not quote a number that isn't backed by a folder
under `docs/eval-runs/`. Do not re-run a rejected lever without new evidence (see the hypothesis
ledger: `docs/research/20260714-locomo-hypothesis-ledger.md`).

## Known open gaps (updated 2026-07-16, re-verify before quoting)

- **Doctor DOES run unattended** — a **frequent 15-min** pass runs every `tier: 'cheap'` check
  (DB-only, no LLM/embed provider); metered LLM/embed probes piggyback the **existing 24h cleanup
  tick** (`tier: 'full'`) rather than a new interval (a tight interval on a real LLM call would be
  a self-DoS / FEAT-482-class incident on a metered endpoint). Skipped under `:memory:`.
  - `extraction-yield.ts` is `tier: 'cheap'` (promoted 2026-07-16) — its window queries are bounded
    index-range searches (`idx_extraction_yield_created`, migration 042), genuinely safe on a
    15-min interval. Locked by a positive regression test in `tests/doctor/schedule.test.ts`.
  - `memory-health.ts` **MUST STAY `tier: 'full'`** — this exact promotion was tried and reverted
    in incident #226 (2026-07-13): its queries are unbounded full-active-memories scans with no
    date filter or LIMIT. Hard-locked by `FULL_TIER_ONLY_CHECK_NAMES` in
    `tests/doctor/schedule.test.ts`.
  - All doctor checks above only fire under a manual/scheduled run — there is no live dashboard
    push; "dormant-canary" caveat applies to every RESOLVED item below.
- `ContentPrompts`-equivalent product-copy decisions, EF-style re-baselines, etc.: none currently
  open for this repo (astramem-local has no equivalent copy-decision backlog as of this writing).

## Durable architecture facts (verified on the date shown — re-verify before trusting)

- **Service/upgrade architecture** (post-hardening, verified 2026-07-13): `schtasks` task
  `AstraMemoryD` points at a STABLE shim (`launch.cjs` → `current.json` pointer); upgrades rewrite
  only the pointer, `schtasks` is never re-touched. `reinstall` materializes an immutable release
  under `%LOCALAPPDATA%\Astramem\releases\<pkgversion>+<gitsha>\` before touching the running
  daemon (FEAT-438), prunes old releases (keeps newest 2). `reinstall --rollback` repoints at the
  previous release with no re-registration; `reinstall --dev` pins straight at the checkout's
  mutable `dist/` as an escape hatch (loud WARN every time; `doctor` flags it).
- **Unix service parity** (FEAT-443): systemd/launchd share the same install-flow + STABLE shim
  Windows always used. A separate recurring hang-watchdog probe (systemd `OnUnitActiveSec` /
  launchd `StartInterval`, installed automatically) hits `/health` every 3 min and, after 2
  consecutive failures (`DEFAULT_FAILURE_THRESHOLD`), kills whatever holds `daemon.lock` and
  restarts — closes the blind spot where `Restart=on-failure`/`KeepAlive` only fire on process
  *exit*, never on a wedged-but-alive process. **Windows parity** (issue #206, 2026-07-13): the
  same probe runs as a second scheduled task (`AstraMemoryDWatchdog`).
- **Package name history:** `astramem-local` on npmjs first published 2026-07-08 as v0.9.0
  (SQLCipher-capable). The old stale 0.4.0 lives under the scoped name
  `@astragenie/astramemory-local` on GitHub Packages — never install it (plain better-sqlite3,
  `SQLITE_NOTADB` on encrypted DBs). For dev work, prefer `node dist/cli/index.js <cmd>` from the
  repo over a global install — a stale global install can shadow dev expectations; `reinstall`
  asserts served version == build version to catch exactly that class of confusion.
- **Config reload** (FEAT-433, resolved): `config.yaml` is read exactly once per boot, no live
  reload. `writeConfig` writes atomically (tmp-file + rename) so the daemon's own writes can never
  be observed torn. A hand-edit's own save is NOT atomic — stop the service before hand-editing.
- **`num_ctx`/`temperature` provider bugs** (fixed in v0.16.0): `num_ctx` was never set anywhere
  pre-fix, so every call ran at Ollama's default 4096 — the v3 extraction prompt alone is ~3.8k
  tokens, so it silently overflowed and Ollama truncated rather than erroring (kept entity
  extraction ~87% broken for weeks behind a green doctor canary, issue #200). Separately, the
  provider spread `{ options: {...} }` twice — the second spread replaced the first, silently
  dropping `temperature` on every real extraction/compaction/entity call. Both are fixed; the
  standing rules this created live in `AGENTS.md`'s Never-do.
- **Temporal reasoning measurement** (corrected 2026-07-14): `AtomSchema` DOES have atom-level
  `valid_at`/`invalid_at` (issue #205 AC-1, PR #216); `InsertInput` DOES have `valid_to`; the embed
  stage maps them behind a validity guard. Measured on 2499 real atoms: `valid_to NOT NULL: 0`
  (invalid_at never emitted), `validity_guard_drops: 0` (guard never refused one either),
  `distinct valid_from: 423` (the valid_at half does work). The model never emits `invalid_at` at
  all — whether that's a bug or correct (conversations may genuinely never state an invalidation)
  is unmeasured; sample transcripts by hand before changing the extraction prompt. Text-surface
  date grounding shipped 2026-07-13 (PR #189 + timezone fix #191) — threads `capturedAtMs` into the
  extraction prompt so relative expressions resolve to absolute dates in the atom's own text.
- **Citation drift caution** (2026-07-13, self-expiring): `src/distill/**` and `src/search/**` were
  under active edit that day and several `file:line` citations drifted mid-session. **Anchor on the
  symbol name, not the line number** for anything more than a session old — see
  `docs/adr/ADR-015-loud-failure-invariant.md`'s citation policy for the same rule in full.

## Closed incidents (do not re-raise)

- **FEAT-482 (2026-07-13):** the contradiction-detection flip from `off` to `enabled` shipped
  without a call-count/wall-clock cap on the judge — fired ~245 sequential LLM calls against a
  metered endpoint (codex-subscription, billed to the operator's personal quota), wedging the
  daemon's sole worker lane for 10+ minutes. A dollar-cap guard was tried and reverted (commit
  `0b6b3f8`) because every shipped LLM provider hardcodes `usage.usd: 0` — a budget check can never
  trip. Live guards: `maxPerRun: 200` + `maxWallClockMs: 300_000` (`config.ts:623-635`). If these
  ever need tightening, that's the lever — never `mode`.
- **Image-name process kills (2026-07-10):** `taskkill /F /IM node.exe` killed a 40-min LongMemEval
  run + the prod daemon in one shot — this box runs prod + eval shards + Ollama + sibling agents.
  Standing rule now in `AGENTS.md`'s Never-do.
- **`git stash` in worktrees (2026-07-09):** a `stash pop` in one worktree ate a sibling agent's
  stash (the stash stack is repo-global across worktrees). Standing rule in `AGENTS.md`.
- **PR #229 rebase `--ours` incident:** resolving a rebase conflict with `git checkout --ours` kept
  *main's* version and discarded local fixes to six test files — the suite stayed green the entire
  time because the reverted literal happened to numerically equal the correct value at each point
  in the rebase (a test passing for the wrong reason). Fixed in PR #233; see ADR-016 §3 Instance 1.
  Standing rule in `AGENTS.md`.
- **Temporal-grounding month-arithmetic bug:** `addMonthsUtc`'s `setUTCMonth`/`setMonth` overflowed
  forward whenever the anchor's day-of-month didn't exist in the target month — shipped behind 307
  green tests because the suite anchored on the 15th, the one day that can never trigger it. Fixed
  same day; see `docs/research/20260713-temporal-grounding-regex-postmortem.md`. Standing rule in
  `AGENTS.md`.
- **Formerly-deferred items, all resolved (verified 2026-07-03):** turn flattening
  (`flattenTranscriptContent`, D-DEF1); `summary_memory_id` backfill (D-DEF2); the ADR-005 retrieval
  eval gate (runs in every vitest/CI pass); usefulness→ranking epsilon term (ADR-010, `src/search/fuse.ts`).

## Known debt (flagged, not blocking)

- **`docs/todo/v0.1.2.md`** — the sole file in `docs/todo/`, at a version 19+ releases behind
  current (`0.20.0`). Likely fully superseded; owner should confirm and delete.
- **`docs/HANDOFF.md`** — a 2026-07-02 point-in-time snapshot (v0.6.0 state, 859 tests, SCHEMA_VERSION
  8). Not referenced by any current instruction file. Kept for archival value; superseded going
  forward by this file for anything still relevant.
- **`.claude/crew/deployment.md`'s "Source Clues"** cites `.github/workflows/test-xplat.yml`, which
  no longer exists (CI moved to `test.yml` across commits `ad13e01`→`6134298`→`700a4e1`). This is a
  generated deployment-guidance artifact, not hand-edited prose — flagged for the deployer role to
  fix on its next regeneration rather than hand-patched here.
