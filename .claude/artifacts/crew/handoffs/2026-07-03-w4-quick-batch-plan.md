# Handoff — Wave 4 quick batch (W4.5 + W4.1 + W4.3), next session

**Date:** 2026-07-03 (end of hardening day)
**Repo:** C:\work\mega\astramemory-local
**Decision made by user:** implement the quick batch — W4.5 → W4.1 → W4.3 (≈1 day) — so W4.2 entity search later lands on clean foundations.

## Session-start checklist (do FIRST)

1. `git checkout main && git pull --ff-only` — expect `main @ 2a30ced` or later (**PR #36 merged 2026-07-03 end of session; 8 PRs total that day, #29–#36; no open PRs, no stray branches**).
2. `bun install && bun run build && node dist/cli/index.js reinstall` → daemon healthy on latest main.
3. Read `docs/hardening-roadmap.md` — Wave 4 table W4.1–W4.9 is the authoritative spec.

## Current state (verified end of 2026-07-03)

- **7 PRs merged today** (#29–#35): full install/service hardening (stable shim + XML task + PT5M keepalive), `reinstall` one-command upgrade, degraded-start, instance lock, crash handlers, verified backups + `restore`, npm publish workflow, consolidation scheduler (boot + 6h) + `consolidate` CLI, key-blind CLI fixes, type-drift fix.
- Daemon: v0.6.0+main, encrypted DB (~390 memories), doctor 20 checks green, `AstraMemoryD` (Running) + `AstraMemoryDBackup` (03:00 nightly, verified backups) tasks registered.
- `/health` additive fields: status, uptime_s, embed, worker, queue, disk_free_bytes, **pending_proposals (~60 awaiting user review — NOT a bug, user's queue: `consolidate proposals` → `accept`)**.

## The batch — specs

### 1. W4.5 `queue purge --poison` (1–2h, trivial)
- `src/cli/queue.ts`: add `purge --poison [--json]` subpath (queue currently takes flags only — add subcommand parse). Before delete: print/dump each poison row (id, kind, attempts, last_error) — forensics-then-delete.
- Reuse `JobRepo.purgeOld` pattern but unconditional on age for state='poison' (new `purgePoison()` on JobRepo).
- CLI opens via `openRuntimeDb()` (src/cli/open-runtime-db.ts) — NEVER raw openDb (key-blind bug class, fixed in #33).
- Tests: seed poison rows → purge → gone; completed/pending untouched.

### 2. W4.1 `as_of` temporal search (3–5h, low)
- Schema already bitemporal: memories.valid_from/valid_to + append-only memory_events. Search filters `valid_to IS NULL` today.
- Add optional `as_of` (epoch ms or ISO) to: `SearchOpts` (src/search/search.ts), candidate SQL in FTS + vec paths → `valid_from <= :asOf AND (valid_to IS NULL OR valid_to > :asOf)` replacing the valid_to-IS-NULL clause when as_of present; `/search` + `/recall` route schemas (additive, wire-safe); CLI `search --as-of <date>` / `recall --as-of`.
- **Acceptance: unskip eval q6** — tests/eval/retrieval-eval.test.ts asserts `report.skipped === 1` for as_of; harness (src/eval/harness.ts:122-130) explicitly skips as_of queries. Implement → harness runs q6 → update the skipped assertion to 0. That was the designed definition-of-done.
- Watch: recall-pack route (src/server/routes/recall.ts) caches by `repo|project|branch` key — as_of results must NOT poison that cache (either exclude as_of from pack path or add to cache key).

### 3. W4.3 repo/project tag hygiene (4–6h, low-med)
- Problem observed live: untagged legacy memories pollute cross-project recall ("SQLite over Postgres" decisions surfacing in a Postgres project's session).
- Tag flow (verified): ingest stores repo/project on `sessions` (ingest.ts:117,176); distill inherits session → memory (distill.ts:98-99); untagged = old ingests + bare `remember` without --repo.
- Implement `rebuild --retag [--dry-run] [--json]` in src/cli/rebuild.ts (command already queues reembed jobs — add retag mode):
  - Pass 1 (deterministic): memories with NULL repo + non-NULL session_id → copy repo/project/branch from their session row. Bulk UPDATE, report count.
  - Pass 2 (report-only in this slice): remaining NULL-repo memories → list count + sample; do NOT guess via LLM (defer).
- Tests: seed session-linked untagged memories → retag → tags copied; sessionless stay NULL and are counted.

## Ship ceremony (same as all 7 PRs today)

Branch per item or one `feat/wave4-quick-batch` branch with 3 commits (user precedent: batched waves in one PR is fine). Full suite `bunx vitest run tests/` (bare run is clean since worktree removal — expect ~902+ passed, verify COUNTS EXPLICITLY, don't trust tail). Live acceptance on Windows: reinstall + exercise each feature against the real daemon. PR → CI → **ETXTBSY flake expected** (devops#64, 11 hits yesterday: self-hosted jobs die in 6-8s at setup-bun with `spawn ETXTBSY` / `Text file busy` — ALWAYS `gh run rerun <id> --failed`, never treat as real until log-checked). Merge-if-green with `gh pr merge N --admin --squash` (user's standing pattern), sync main, rebuild, reinstall, delete branches.

## Gotchas that bit us yesterday (do not relearn)

- **Never bare `astramem-local`** — stale global v0.3.4. Always `node dist/cli/index.js`.
- vitest `--exclude` unnecessary now (stale worktree removed) but VERIFY pass/fail counts explicitly.
- openRuntimeDb sniffs plaintext header — key only applied to actually-encrypted files (don't regress; queue.test.ts seeds plaintext fixtures).
- CLI type lists: derive from contracts (MEMORY_TYPES pattern from #34), never hand-copy.
- `main` is push-protected — everything via PR.
- Bearer for live probes: `grep -o '[0-9a-f]\{64\}' $APPDATA/Roaming/Astramem/secrets.env`.

## After the batch

W4.2 entity search is next (16–24h, 2 slices) — full design in roadmap. Do NOT start it before W4.3 lands (tag hygiene first: garbage tags in = garbage entities out).

## Outstanding (not code)

- `NPM_TOKEN` repo secret — user must set before next `v*` tag (publish.yml fails loudly without it).
- devops#64 — runner fix is their court; expect 1 rerun per PR until fixed.
- User's review queue: ~60 consolidation proposals (`consolidate proposals` / `accept --all`).
