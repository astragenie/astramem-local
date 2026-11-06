# astramem-local — Memory (durable facts index)

Volatile, dated facts agents keep rediscovering. **Supersede entries by editing them in place**
(update the date + content) rather than appending forever — this file should stay a snapshot of
"what's true now," not a changelog. For history, see `.claude/artifacts/crew/{runs,handoffs}/`,
`CHANGELOG.md`, and git log.

`CLAUDE.md` should change rarely; this file is where the volatile state that used to be crammed
into it (dated corrections, incident narratives, current eval numbers) now lives, extracted during
the 2026-07-21 agentic-setup rebuild.

## Version / build status (verified 2026-11-05)

- **Current tagged release: v0.22.1** (2026-08-06, `56e7f4c0`) — 63 migrations. Main tip is `be1a47b9`
  (2026-08-19), 5 commits past the tag, and carries unreleased migration `064-cost-ledger.sql`
  (FEAT-476 Phase 0, PR #491) — so main = schema 64 while v0.22.1 = schema 63. **Local prod daemon on
  this box runs release `0.22.1+be1a47b9` (main tip, package version still 0.22.1, schema 64)** since
  the 2026-11-05 recovery below; no commits landed between 2026-08-19 and 2026-11-05. npm `latest`
  dist-tag not re-checked this session. Next release cut should bump the version (064 is a schema
  change) — do not publish a second `0.22.1`.
  Re-verify against `CHANGELOG.md`'s top entry before quoting a version anywhere, it will drift
  again on the next release.
- **README/providers.md truth pass** (PR #461, merged 2026-08-02): corrected the remaining
  `qwen3:8b`-as-default references to `qwen2.5:7b` (~4.7GB), fixed the provider matrix to show
  `codex-subscription` as the default LLM + ONNX as the default embed provider, and documented
  `MEMORY_API_URL` as the **daemon's** env var (distinct from `MEMORY_MCP_URL`, which is
  plugin-side).
- **GitHub repo name is `astragenie/astramem-local`** (verified 2026-08-06: `gh repo view
  astragenie/astramemory-local` → not found, no rename redirect; raw URLs under the old name 404).
  An earlier note here claimed the GitHub name was still `astramemory-local` and only the local
  folder had been renamed — that was stale; README/package.json URLs pointing at the old name were
  dead and were fixed 2026-08-06. Local clone dir on this box is `C:\work\mega\astramem-local`.
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

## Daemon stability — event-loop stalls & watchdog restarts (verified 2026-08-02)

- **Event-loop stall root cause found, partially fixed.** `MemoryEventRepo.isErasedHash()` was an
  unindexed full-table scan of the ever-growing `memory_events` log, called per-atom from distill
  stage `08-embed-index` — measured 6-21s synchronous stalls per distill batch, the driver behind
  weeks of watchdog hang-kills. Fixed by a partial index in migration 061 (PR #465, merged,
  `358ad6d8`). **CAVEAT — do not record this stall class as closed:** stalls >5s are still observed
  post-fix (`el_max` hit 9s within minutes of boot on 0.21.0+`056f2aeb`), so a second blocker
  exists and is under active investigation.
- **"Crash loop" decoded — not spontaneous crashes.** Every recorded daemon exit this past week (10
  restarts through 2026-08-02) was a watchdog SIGTERM after `/health` missed 2 consecutive 180s
  probes (hang-kill-restart), not an unhandled exception. **Exception, still open:** one unexplained
  silent `exit=1` at 2026-08-02T15:49Z with no stack trace and no watchdog record — not yet
  root-caused.

## LoCoMo / eval — current numbers (verified 2026-07-19, re-verify against the LEDGER — they drift)

Champion **0.6002** / service-day **0.5430** (conv-1, n=199); full-suite best **0.4840** (n=1986).
The 0.54→0.60 gap is **proven codex day-variance (±6 pts/day)**, not a missing lever — every *retrieval/
extraction* config A/B (chunk-size, sweeper-v1, temperature, maxTokens, compaction, rerank, decompose,
fusion-norm) is REJECTED. Canonical tracker: `docs/eval-runs/README.md` — read it first; do not quote a
number that isn't backed by a folder under `docs/eval-runs/`. Do not re-run a rejected lever without new
evidence (see the hypothesis ledger: `docs/research/20260714-locomo-hypothesis-ledger.md`).

- **THE lever is the ANSWER PROMPT, not retrieval (updated 2026-07-24).** After a year of rejected
  retrieval/extraction levers, the Mem0/Zep harness replication proved the gap is the answer prompt:
  our prompt abstained on 35% of Qs even with PERFECT gold evidence; Mem0's commit-to-answer prompt
  lifted the SAME evidence/model/judge by +0.204 (0.592→0.796). Fix landed as **answer-prompt-v2**
  (`buildAnswerPrompt` + `canonical.mts`, commit c66b8133): evidence-sufficiency-aware — answer when notes
  state OR reasonably imply, abstain only when they truly don't, never fabricate. Same-store: gold-turns
  0.592→0.803, retrieved-atoms 0.586→**0.678** (> Mem0's published 0.66). **End-to-end confirmed
  2026-07-24** (fresh full pipeline, `20260724-v2fix-n1-codex`): Mem0 lenient cat1-4 **0.671 = Mem0 parity**,
  beating champion-old-prompt 0.658 even with weaker (default-prompt) extraction. **TRADEOFF (real):** the
  fix reduces abstention → HURTS cat5 (adversarial, where abstaining is correct): token-F1 adversarial
  0.872→0.702, so on the cat5-inclusive token-F1 the fix nets −0.055 (0.588→0.533) even as it wins cat1-4.
  **The metric picks the winner** — cat1-4-lenient (fix wins, ~0.67) vs cat5-inclusive-token-F1 (fix loses).
  Full-suite (n=1986) NOT yet run — operator banked at n=1 (codex quota fragility, see [[codex-cli-infra]]-class
  notes). **Zep's 0.947 is unreproducible marketing** (not in arXiv; their own OSS harness = 0.803). Full
  detail: LEDGER rows 2026-07-23/24 (★) + `docs/research/20260723-mem0-zep-locomo-harness-extraction.md`.

## Eval archive now survives worktree deletion (P0-3, fixed 2026-08-04)

`scripts/eval/locomo/archive-run.mts` used to resolve its `docs/eval-runs/` destination relative to
`process.cwd()`. Eval sandboxes routinely run inside a throwaway git worktree, so a run archived
from one wrote into *that worktree's own* uncommitted `docs/eval-runs/` copy — real bytes on disk
that vanished the moment the worktree was deleted. This is exactly how this repo lost its two
headline LoCoMo numbers: the **0.5549** dual-pass full-suite result cited in
`src/config/config.ts:1780-1789`/`:1043` as the justification for shipping `extractionPasses: 2`
by default, and the **0.6002** conv-1 champion (`docs/eval-runs/README.md` records it as "run dir
deleted"). Both are permanently unreproducible-as-run; this fix stops a third one happening.

Fixed by resolving the archive root via `git rev-parse --path-format=absolute --git-common-dir`
(shared across every worktree of one repo — its parent dir is always the PRIMARY checkout, whether
called from the primary checkout itself or any linked worktree, no special-casing needed) instead
of cwd. The script now also prints the resolved score next to the absolute archive path on every
run, and refuses to archive anything (exit 1, loud error) if that resolution fails, rather than
silently reporting success for a path that might not survive — same fail-loud convention as
ADR-015's rate canary and the `auto-merge.yml` preflight. Regression test:
`scripts/eval/locomo/archive-run.test.ts` (builds an isolated throwaway git repo + linked worktree,
archives from the worktree, deletes the worktree, asserts the archive survives under the primary
checkout — fails on the pre-fix code).

## Known open gaps (updated 2026-11-05, re-verify before quoting)

- **Provenance leak: Claude Code agent-worktree dir names stored as `project` (and sometimes `repo`)
  — FIXED 2026-11-05/06, FEAT-553 complete (outcome at the end of this entry; the DEC-017 caveat below is
  superseded: `.claude/artifacts/loop/decisions/DEC-017.md` exists since SLICE-443 landed).** 17,877 of 119,950 memories (15%)
  carry `project` like `agent-a0112287d8dd8d401` — 270 distinct bogus "projects" polluting the
  dashboard project filter (`SELECT DISTINCT project FROM memories`,
  `src/server/queries/dashboard.ts:276`). Cause: Claude Code runs isolated agents in
  `<repo>/.claude/worktrees/agent-<id>/`; every astramem-plugin hook (`session-end-summary.sh`,
  `subagent-stop-capture.sh`, `pre-compact-capture.sh`) sets `PROJECT_ID="$(basename "$CWD")"`, and
  `POST /ingest/transcript` stores `project_id` verbatim (`sessions` upsert, `routes/ingest.ts`).
  The daemon's own `deriveWorktreeSafeBasename()` (`src/pipeline/cwd-basename.ts`) only knows the
  `<name>-worktrees/<x>` layout, not `.claude/worktrees/<x>`, and is only a fallback when the client
  sent no project. `repo` leaks the same way for ~5/11 affected sessions (git toplevel of a worktree
  = the worktree dir). **Filed as FEAT-553 (P1, 6 proposed slices, 2026-11-05).** PM triage found
  this is the unfinished half of CLOSED FEAT-484: `src/tag-hygiene/derive-repo.ts` +
  `src/tag-hygiene/repo-identity-backfill.ts` (CLI exists, `DEFAULT_BAD_REPO_PATTERN` at :59)
  already re-stamp the `repo` column from `sessions.cwd` — the `project` column and the `sessions`
  table were never covered, and `ingest.ts:468` still stores the client `project_id` verbatim.
  Extend that backfill rather than writing a new one. PM triage corrections to the FEAT text
  (2026-11-05): FEAT-484 resolves `repo` via `git rev-parse --git-common-dir`
  (`src/tag-hygiene/repo-identity.ts` documents the gap) — git-based, so a string heuristic for
  `repo` is NOT the fix; the two unfixed legs are (1) `project` never passes through derivation at
  all when the client sends one (`derive-project.ts` returns the explicit value first), and (2) git
  cannot answer for worktrees already deleted, which is why extending `deriveWorktreeSafeBasename`
  to `.claude/worktrees/<x>` is the keystone. FEAT-484's backfill was never run against production
  (per its merge commit) — that is why a closed incident still shows 15% corruption. "Zero
  `agent-*` rows after backfill" is unachievable by design (the backfill refuses to guess when the
  worktree is gone and reports `unresolved`); the honest AC is remaining == reported unresolved.
  **Cross-repo issue filed 2026-11-05 (SLICE-446): `astragenie/astramem-plugin#68`** — hook-side fix
  is `git -C "$CWD" rev-parse --git-common-dir` with a string-strip fallback
  (`/.claude/worktrees/<x>` or `/<name>-worktrees/<x>`) for the three capture hooks; the FEAT text's
  `## Cross-repo` section carries the same reference. **DEC-017 (not yet written — verified
  2026-11-05, do not quote as decided):** sibling SLICE-443 is scoped (frontmatter `status:
  pending`) to add `.claude/artifacts/loop/decisions/DEC-017.md` — the trust-policy decision for
  string-derived project/repo identity when git can't answer because the worktree is already
  deleted. `find .claude/artifacts/loop/decisions/` shows only DEC-001..016; that file does not
  exist in this worktree yet, so this entry carries no DEC-017 citation until SLICE-443 actually
  lands — re-check `.claude/artifacts/loop/decisions/DEC-017.md` exists and supersede this bullet
  with the real citation at that point, per this repo's own session protocol (CLAUDE.md:
  re-verify a dated fact against its source before quoting it in a decision). Remaining slices
  (SLICE-442/444/445/447) implement the daemon-side heuristic, ingest override, and backfill
  extension against whatever DEC-017 decides once it exists; SLICE-446 itself is
  documentation/cross-repo scope only — no source change in this repo.
  **Outcome (2026-11-06, all 6 slices merged + released as `0.22.1+0b96eb9e`):** `deriveWorktreeSafeBasename`
  recognises `<repo>/.claude/worktrees/<x>` (SLICE-442); DEC-017 trust policy (SLICE-443); ingest overrides a
  hook-stamped `project_id` only when it equals `basename(cwd)` and logs `{original, derived, source}` with
  basenames only (SLICE-444); `repo-identity-backfill --column repo|project|all --sessions` with `cwdBasename`
  + `source` fields, preview default, `--yes` to mutate (SLICE-445); runbook
  `docs/runbooks/provenance-backfill.md` (SLICE-447). Prod backfill applied with backup
  `memory-20261105T204726.sqlite`: repo 4,841 re-stamped (1,083 unresolved), project 10,717 (3,493
  unresolved) + a targeted `--pattern '^agent-l3-4$'` pass of 7,398 rows → `prism` (string-heuristic, worktree
  deleted), sessions 20. Remaining `agent-*` rows: memories.project 969 (23 distinct, all unresolvable by
  design: no session / no cwd / untrusted shape), memories.repo 854, sessions 3; post-apply dry-run proposes 0.
  Dashboard project dropdown 372 → 102 options. Notes: the default bad-shape pattern excludes `agent-l3-4` (no
  hex) and includes branch-named worktree labels (`memoized-jumping-elephant`, `transient-dancing-wren`,
  `deploy-health-fix`, …) — those were re-stamped to their repos on purpose. The backfill ran against the live
  daemon; `/health` showed a 55s event-loop stall during the ~18k-row UPDATE pass (self-recovered) — prefer a
  quiet window next time. Plugin-side hook fix still open: `astragenie/astramem-plugin#68`.
- **Agent provenance IS captured but the dashboard never exposes it.** `memories.agent` is populated
  from the SubagentStop payload's `agent_type` (98.7% coverage; 450 distinct values: `claude-code`
  105k main-session rows, then `crew:reviewer` 1180, `crew:fullstack-dev` 1158, `general-purpose` 613,
  `crew:researcher` 604, `runner:pm` 248, `caveman:cavecrew-investigator` 63, `devcrew:*` …; plugin
  is the `<prefix>:` of the value). Recall/search already filter on it (`--agent`, `filters.agent`,
  FEAT-423/424, index from migration 019) — only the dashboard lacks an agent dropdown (it has
  project + profile only). Ad-hoc `Agent(name=…)` labels (`reviewer-420`, `arch-454`) land in the
  same column, so a dropdown should group by plugin prefix or cap to top-N. **DONE 2026-11-05 (FEAT-554 /
  SLICE-448, released in `0.22.1+0b96eb9e`):** `/dashboard` has an `agent` select grouped by plugin prefix
  (top-N by count + free-text fallback), an Agent column, deep link `?agent=crew:reviewer`; the form posts a
  second empty `agent` param from the text box, so `parseMemoryFilterParam` takes the last NON-blank value.
  Still a 25-row activity window (LIMIT 25) — paging the full filtered history is **FEAT-555 (P2, filed
  2026-11-06, not autonomous-safe)**: no index on `memories` leads with `created_at` (verified by PM triage
  across every `CREATE INDEX … ON memories` in `migrations/`), so offset paging + a filtered COUNT are
  120k-row scans and the profile filter's correlated `transcripts` subquery runs per row — the perf AC must
  be feed-query-scoped with query-plan evidence; the existing pagination tests hand in-memory fixtures to
  the renderer and exercise no SQL.

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
- **Sync shipping has been dead since ~2026-07-29** (confirmed 2026-08-02): the sync token to
  `api.astramemory.com` expired, producing HTTP 401 `invalid_expired_credentials` ×160 and backing
  up 2131 consolidation proposals. Awaiting the operator to run a claim-code re-pair — not a code
  bug, don't debug the sync client for this.

## Known bugs — fixes in flight (verified 2026-08-02, re-verify before assuming these are still open)

- **Distill pipeline was DEAD 2026-09-14 → 2026-11-05 (codex model retired); FIXED locally 2026-11-05,
  code default still stale.** Every distill job failed deterministically with `HTTP 400 — {"detail":"The
  'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."}` — OpenAI dropped
  `gpt-5.4-mini` from the ChatGPT-account Codex catalog between 2026-08-04 and 2026-09-14. 41 jobs poisoned,
  0 memories created in ~90 days (store 117,538 active). Fix applied on this box: Codex CLI `npm i -g
  @openai/codex@latest` (0.146.0 → 0.166.0, refreshes `~/.codex/models_cache.json` on first run);
  `config.yaml` `llm.compaction.model` + `llm.extraction.model` → **`gpt-6-luna`** ("Fast and affordable
  model for easier tasks" — the only cheap-tier slug left; catalog 2026-11-05: `gpt-6.1-sol` (codex
  default), `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-sol`, `gpt-reserve`(hidden), `gpt-6-luna`,
  `gpt-5.6-{sol,terra,luna}`, `codex-auto-review`; backup `config.yaml.bak-20261105-pre-gpt6`); the 33
  poisoned distill jobs were moved poison→pending via `JobRepo.requeueForRetry` (no CLI exists for this —
  `queue purge --poison` only deletes) and re-ran clean: 36/36 `gpt-6-luna` calls OK, p50 5.9s, max 23s,
  atoms created again. The other 8 poison jobs (distill, 2026-08-20/21, transient `fetch failed` ×3 attempts) were also requeued for one more attempt (attempts=3 → a single failure re-poisons them); check `queue`. Side effect of the day's restart churn: doctor's **watchdog circuit breaker is OPEN** (3 kills in 6h: 20:25Z, 21:11Z, 21:14Z) — the watchdog will NOT hang-kill/restart the daemon until the 6h window clears.
  **STILL OPEN (code):** `DEFAULT_MODEL = 'gpt-5.4-mini'` in `src/providers/llm/codex-subscription.ts`,
  the `gpt-5.4-mini` defaults in `src/config/config.ts` (~L1098/1575/1606), and
  `pickCheapestCodexModel()`'s `-mini` heuristic (no `-mini` slug exists anymore → it now "suggests"
  `catalog[0]`) are all stale — a fresh `init` breaks out of the box until these move to `gpt-6-luna`
  (or better: a catalog-driven default). Also the validator only warns at construction; a stale default
  should probably fail `doctor` loudly.
- **Checkout-CLI-migrates-prod footgun hit 2026-11-05 (issue #306 class).** Running `doctor`/`queue`/
  `memory health` from the checkout's `dist/` (any `openRuntimeDb()` caller runs `migrate()`) applied the
  unreleased `064-cost-ledger.sql` to the prod datadir; the pinned release `0.22.1+56e7f4c0` (schema 63)
  then refused to boot after a config-change restart: `This datadir was migrated by a NEWER astramem-local
  (DB schema 64) than the one now running (daemon schema 63)` (3 exits in 5 min). Recovery that worked:
  `bun run build` (checkout `dist/` was stale from 2026-07-23!) → `reinstall` → release
  `0.22.1+be1a47b9` (main tip, schema 64) now serves prod. Compare `ls migrations | tail -1` against the
  installed release before pointing checkout CLI at the live datadir.
- **`reinstall` prune-releases keeps the WRONG releases (found 2026-11-05).** With 4 releases present it
  logged `kept 2 (0.22.1+be1a47b9, 0.15.1+nogit), pruned 2 (0.22.1+56e7f4c0, 0.22.0+fe23ee77)` — i.e. it
  kept the oldest `+nogit` dir and deleted the two most recent prior releases, so `reinstall --rollback`
  would now land on 0.15.1. Keep-order is not "newest 2" as documented; probably a lexical/mtime sort
  quirk on the `+nogit` suffix. Unfixed. (Second data point 2026-11-06: with `0.15.1+nogit`,
  `0.22.1+be1a47b9`, `0.22.1+0b96eb9e` present it pruned `0.15.1+nogit` correctly — the bad keep happened when a
  `0.22.0+…` dir was also present; smells like version-sort confusion rather than `+nogit` per se.)
- **`reinstall` re-activates the FEAT-439 post-merge hook** (`core.hooksPath=scripts/git-hooks`) — it was
  unset before 2026-11-05 and is set again now; it auto-reinstalls prod on any migrations/storage merge,
  including local branch merges.
- **Daemon restarts 2026-08-12 → 2026-09-15 were watchdog hang-kills, not crashes** (exit-history:
  9 exits, codes `1`×8 then `1073807364`; watchdog-kills.jsonl has matching stamps 08-18, 09-11,
  09-13, 09-14, plus one on 2026-11-05T20:25Z). Event-loop stall class still open: 31.9s max stall and
  a 30s `vec search timed out` observed 2026-11-05 within 20 min of boot on v0.22.1.

- **`auto-merge.yml` is silently broken.** The `enablePullRequestAutoMerge` GraphQL call fails to
  arm on every PR — the failure is caught as a warning so the workflow job still PASSes,
  `autoMergeRequest` stays `null`, and nothing actually auto-merges. **Root cause (CI run
  `30754930112`, PR #465's auto-merge job): `"##[warning]enable auto-merge failed: Bad
  credentials"`** — the `AUTOMERGE_PAT` secret is expired/revoked. (Not a branch-protection/ruleset
  issue — `allow_auto_merge=true` on the repo, ruleset unrelated.) Fix: operator rotates
  `AUTOMERGE_PAT`; PR #467 (in flight) makes the failure loud instead of a silently-swallowed
  warning. 5 PRs merged today (2026-08-02) — #461, #462, #463, #464, #465 — were all hand-merged
  because of this.
- **`reinstall` stale-lock false-fail, reproduced 2×.** `reinstall`'s stop step leaves
  `daemon.lock` behind holding the dead PID; the fresh daemon refuses to reclaim it and exits
  instead of starting, which fails the health gate and triggers an automatic rollback. Remedy until
  fixed: verify the PID is actually dead, delete the stale lock file, rerun `reinstall`. Fix in
  flight.
- **`cross-repo-roundtrip` CI flake root-caused.** 3 CI failures on 2026-08-02 traced to the GitHub
  releases CDN returning 503 on the SQLCipher prebuilt binary fetch — `curl --retry` alone does not
  cover 503 without `--retry-all-errors`. Fix in flight.

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
- **Thinking-mode guard superseded (verified 2026-08-02).** `src/providers/llm/ollama.ts` no
  longer name-matches a `KNOWN_THINKING_MODEL_PREFIXES` list to decide thinking mode — verified
  against live source and git history, that prefix-list approach is gone. It now sets
  `think = config.think ?? false` unconditionally for every model. Supersede any entry describing
  the prefix-list as the current mechanism.
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
  **Residual item 2/3 shipped 2026-08-02** (PR #463, `8c55d8fc`): a running consolidate job now
  self-preempts at its existing yield checkpoints when a higher-priority job pends
  (`JobRepo.hasPendingAbovePriority`), and the resume cursor persists on ANY early abort (not just
  ceiling hits) — so the no-ceiling default config now makes monotonic progress instead of
  restarting from scratch. New telemetry: `summary.resumeCursorUpdated`.
- **Distill poison-rate metric was lying (closed 2026-08-02, PR #462, `a1368240`).** The alarmed
  47.6% poison rate was lifetime-unwindowed residue of a single codex quota-exhaustion burst
  (2026-07-31: HTTP 429 `usage_limit_reached` ×322, 55 jobs poisoned) — current extraction is
  healthy. Fix: the rate is now a rolling 7-day window (migration 060 partial index), and poisoned
  jobs age out at 90 days (`POISON_JOB_RETENTION_DAYS`, previously never purged; completed jobs
  still age out at 30 days).
- **Issues #396/#398 (boot-to-listen race), closed 2026-08-02 as already-shipped.** Verified the
  fix landed earlier: PR #420 (early port-bind, 2026-07-17) + PR #397 (`StillBootingError`,
  2026-07-19). Evidence is in the issues' own closing comments — no new code needed.
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
- **Temporal-grounding month-arithmetic bug (historical) + current ground-dates risk:** the former
  `addMonthsUtc`'s `setUTCMonth`/`setMonth` overflowed forward whenever the anchor's day-of-month
  didn't exist in the target month — shipped behind 307 green tests because the suite anchored on the
  15th, the one day that can never trigger it (fixed same day; see
  `docs/research/20260713-temporal-grounding-regex-postmortem.md`). **CORRECTED 2026-07-23: that file
  (`src/distill/temporal-grounding.ts`) and `addMonthsUtc` no longer exist — 0 matches for
  `setUTCMonth`/`setMonth`/`addMonths` in `src/`.** Date resolution moved to `src/distill/ground-dates.ts`,
  which routes ALL month/week/year arithmetic through an **LLM call with no code-side correctness
  check** (schema only asserts `resolved_text` non-empty). The month-overflow class is gone, replaced
  by: (a) hallucinated dates the schema can't catch; (b) `groundAtomDates` has a `maxCalls` count cap
  but **no `maxWallClockMs`** — the FEAT-482 count-cap-alone gap; (c) `hasUnresolvedRelativeDate` is
  100% past-anchored, so **future-relative dates ("in two weeks") silently never become grounding
  candidates** — a plausible slice of the temporal-category F1 gap (FEAT-486). Standing rule (still
  valid for any NEW code-side month arithmetic): construct via `new Date(Date.UTC(y, m, 1))`, and add
  an explicit month-end-anchor test (29th/30th/31st). Standing rule in `AGENTS.md`.
- **ground-dates.ts LLM resolution is NON-DETERMINISTIC at temperature 0 (discovered 2026-07-23, live gate).**
  The Wave-5 `w5/extract-fix` branch closed gap (c) above — added `in N units` / `within N units` /
  `N units from now` future-relative detection + symmetric resolution templates (built + code-reviewed
  PASS, 663 distill tests green, 0 fabrications on all 13 adversarial re-anchoring cases). BUT the
  **live** adversarial-determinism gate (`scripts/eval/date-grounding-retry-adversarial.mts`, real
  codex-subscription, temp already pinned `0` at ground-dates.ts:373) came back RED on the *genuinely
  session-relative must-resolve* cases: **3/5 non-deterministic across 3 identical runs** and **2/5
  collapsed week-granularity to a bare invented day**. Load-bearing detail: the non-determinism hits a
  **past-tense** case too — `"I saw her last week."` resolved to `"the week before 15 July 2023"` twice
  and **declined entirely** on the third run — so this is a **pre-existing property of the LLM-grounding
  architecture, not introduced by the future extension** (the extension only widens the surface: more
  atoms fire → more non-deterministic resolves; resolve-rate of fired ≈ 33%, the other ~2/3 safely
  decline). Consequence: **`w5/extract-fix` DEFERRED — not merged to `feat/retrieval-overhaul`, kept
  on-branch.** Rationale: near-zero LoCoMo upside (temporal already GAINS from extraction per the
  2026-07-23 fixed-answerer oracle recompute; future-relative dates are rare), so no urgency to ship a
  known-non-deterministic widening that also hurts ingest reproducibility. Real fix needs a determinism
  story for the whole module (e.g. move the offset arithmetic code-side once the LLM has only *classified*
  attach-vs-reanchor, so the DATE is computed deterministically and the LLM never picks the day) — a
  separate investigation, out of this release's scope. Mocked unit tests pass because canned responses
  can't exhibit the live non-determinism — the live gate is the only thing that catches it.
- **Formerly-deferred items, all resolved (verified 2026-07-03):** turn flattening
  (`flattenTranscriptContent`, D-DEF1); `summary_memory_id` backfill (D-DEF2); the ADR-005 retrieval
  eval gate (runs in every vitest/CI pass); usefulness→ranking epsilon term (ADR-010, `src/search/fuse.ts`).

## Known debt (flagged, not blocking)

- **`ASTRA_SKIP_CONSOLIDATE=1` is set in the operator's persistent shell environment on this box
  (found 2026-11-05).** It silently short-circuits `runConsolidation()`, so a plain `bun run test`
  loses the whole consolidation suite — 95 failures across 14 files on the first wave-1 full run,
  down to 3 environmental `tests/service/shim.test.ts` timeouts once unset. Run the gate as
  `env -u ASTRA_SKIP_CONSOLIDATE bun run test` (or remove the var from the user environment); the
  FEAT-548 handoff already lists "must be unset" as a precondition.
- **Two environmental test failures on this box (classified 2026-11-05, both reproduce on the pre-wave
  base commit `02cf8ede`, so they are NOT regressions):** (1) `tests/service/shim.test.ts` "watchdog probe
  output capture" cases time out at 5000ms only under full-parallel suite load — 43/43 when the file runs
  alone; (2) `scripts/eval/shared/detach.test.ts` "manifest-scoped kill stops it" fails deterministically
  (`expected [] to deeply equal [<pid>]`) even in isolation — the detached-child PID enumeration does not
  find the child on this Windows box. Treat a 4–5 failure tail confined to these two files as green; anything
  else is real.

- **`docs/todo/v0.1.2.md`** — the sole file in `docs/todo/`, at a version 20+ releases behind
  current (`0.21.0`). Likely fully superseded; owner should confirm and delete.
- **`docs/HANDOFF.md`** — a 2026-07-02 point-in-time snapshot (v0.6.0 state, 859 tests, SCHEMA_VERSION
  8). Not referenced by any current instruction file. Kept for archival value; superseded going
  forward by this file for anything still relevant.
- **`.claude/crew/deployment.md`'s "Source Clues"** cites `.github/workflows/test-xplat.yml`, which
  no longer exists (CI moved to `test.yml` across commits `ad13e01`→`6134298`→`700a4e1`). This is a
  generated deployment-guidance artifact, not hand-edited prose — flagged for the deployer role to
  fix on its next regeneration rather than hand-patched here.
