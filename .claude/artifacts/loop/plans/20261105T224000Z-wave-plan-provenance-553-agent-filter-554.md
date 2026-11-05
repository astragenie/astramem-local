---
title: Wave plan — FEAT-553 provenance leak fix + FEAT-554 dashboard agent filter
created: 2026-11-05T22:40:00Z
author: lead session "mem-local" (428de2a2)
supersedes: 20260710T180000Z-wave-plan-drain-triaged-post-v014.md
status: active
goal: land both FEATs in three waves — 4 parallel worktrees, then 2, then one operator-gated prod step — one owner per file, deps enforced by parking not-yet-eligible slices outside slices/pending
---

# Wave plan — FEAT-553 (P1) + FEAT-554 (P2), 2026-11-05

**Baseline:** `main` @ `be1a47b9` (2026-08-19). Prod daemon on this box runs release
`0.22.1+be1a47b9` (= main tip, schema 64) since the 2026-11-05 recovery. Working tree
carries uncommitted intake artifacts (FEAT-553/554 files, pm-reviews, slice files, this plan,
`docs/memory.md`) — commit them as `docs(backlog): intake FEAT-553/554 + wave plan` before
cutting worktrees so every worktree branches from a tree that contains the slice files.

**Slices (materialized from the PM decomposition, `slice from-feature`):**

| Slice | FEAT | Wave | Pts | Depends on | Owns (touches_files) |
|---|---|---|---|---|---|
| SLICE-442 | 553 | 1 | 2 | — | `src/pipeline/cwd-basename.ts`, `tests/pipeline/cwd-basename.test.ts` |
| SLICE-443 | 553 | 1 | 2 | — | `.claude/artifacts/loop/decisions/DEC-017.md`, `…/decisions/README.md` |
| SLICE-446 | 553 | 1 | 1 | — | `docs/memory.md` (+ GitHub issue in `astragenie/astramem-plugin`) |
| SLICE-448 | 554 | 1 | 3 | — | `src/server/queries/dashboard.ts`, `src/server/routes/dashboard-html.ts`, `tests/server/dashboard-html.test.ts`, `tests/server/queries/dashboard-queries.test.ts` |
| SLICE-444 | 553 | 2 | 2 | 442, 443 | `src/pipeline/derive-project.ts`, `src/server/routes/ingest.ts`, `tests/pipeline/derive-project.test.ts`, `tests/tag-hygiene/worktree-ingest-canary.test.ts`, `tests/server/ingest.test.ts` |
| SLICE-445 | 553 | 2 | 2 | 442, 443 | `src/tag-hygiene/repo-identity-backfill.ts`, `src/cli/repo-identity-backfill.ts`, `src/cli/index.ts`, `tests/tag-hygiene/repo-identity-backfill.test.ts` |
| SLICE-447 | 553 | 3 | 1 | 444, 445 + daemon release | `docs/runbooks/provenance-backfill.md` + the prod datadir (operator present) |

Per-slice scope, AC ownership and design notes live in each slice file under
`.claude/artifacts/loop/ai-loop/slices/{pending,blocked}/SLICE_44N_*.md` (In scope / Out of
scope / Acceptance criteria were written per slice; the FEAT-553 ACs are split 442:{2,3}
444:{1,5,7,9} 445:{4,6,8,9} 447:{4,6,8}; 443/446 carry a slice-local AC).

## Principle

- **One owner per file.** The table above is the conflict map; no two slices in the same wave
  share a path. `src/cli/index.ts` is touched only by 445; `docs/memory.md` only by 446.
- **Dependencies by parking, not by hope.** The runner's wave planner
  (`loop.mts wave plan`) packs by `touches_files` conflict only and ignores `depends_on`/`wave`
  (verified 2026-11-05: with all 7 slices in `pending/` it packed 442+443+444+445 together).
  So slices whose deps have not merged live in `slices/blocked/` and are moved back into
  `slices/pending/` only when their wave opens. The planner only reads `pending/`.
- **Planner needs block-form YAML.** `touches_files` must be written as `key:` + `  - item`
  lines; the inline `[a, b]` form is silently ignored and the planner falls back to inferring
  paths from body text (which produced bogus conflicts on the first trial). Already fixed on all
  7 slice files.
- **Release between wave 2 and wave 3.** The backfill must run against a daemon that already
  carries SLICE-444's ingest override, otherwise the hook keeps re-creating `agent-*` rows until
  the plugin fix (cross-repo, SLICE-446's issue) lands.
- **No migrations anywhere in this plan.** Schema stays 64; the FEAT-439 post-merge hook
  (re-armed by the 2026-11-05 `reinstall`) only fires on migrations/storage merges, so wave
  merges will not auto-redeploy prod. The redeploy is an explicit step (Wave 2 → 3).

## Wave 0 — prep (lead, serial, ~10 min)

1. Commit the intake artifacts on `main` (see Baseline).
2. Sanity: `bun run build && bun run test` green on `main` before branching.
3. Confirm planner output = exactly the wave-1 set:
   ```bash
   bun "C:/Users/serge/.claude/plugins/cache/astra/runner/0.78.0/src/scripts/loop.mts" wave plan --repo "$PWD" --size 4 --json
   # expect items: SLICE-442, SLICE-443, SLICE-446, SLICE-448; rejected: none
   ```
   (Stale pre-existing `pending/` slices from done FEATs are pre-flight-dropped by the planner;
   `SLICE_423_IMPLEMENT-FEAT-457` is the one live stray — if it ever shows up in a plan, park it
   in `blocked/` too.)
4. `.claude/loop.json` has no `loop.wave` block → defaults (size 3, `/crew:orchestrate-slice`,
   post-merge test `bun test …`). Pass `--size 4` explicitly for wave 1, `--size 2` for wave 2.

## Wave 1 — 4 parallel worktrees (~45–60 min wall-clock)

  442 (string heuristic) ∥ 443 (DEC-017) ∥ 446 (plugin issue + memory.md) ∥ 448 (dashboard agent filter)

```bash
bun "C:/Users/serge/.claude/plugins/cache/astra/runner/0.78.0/src/scripts/loop.mts" wave run --repo "$PWD" --size 4
```

- Each slice runs the full ceremony in its own worktree (`wave/<waveId>/<SLICE-ID>` branch):
  `/crew:orchestrate-slice --id SLICE-NNN` → builder → `crew:reviewer` → `crew:verifier`
  (requires_validation: true on all code slices) → slice close + grade.
- Merge order on PASS: **442 → 443 → 446 → 448** (442 first so wave-2 branches see the heuristic
  on the merged tip). Finalize runs the post-merge test command; a red post-merge run blocks
  wave 2 (`exit 2 post_merge_red`).
- FAIL handling: the runner marks `pending_fix: true`, keeps the worktree, and re-dispatches
  with `/crew:fix` at the head of the next wave (max 2 attempts, then `needs-review`).
- 446 needs `gh` auth for the cross-repo issue; if unavailable it records the issue text in
  `docs/memory.md` and closes as `blocked: gh auth` — that is a PASS for the slice, the issue
  gets filed by the operator later.

Exit criteria: 4 branches merged, `bun run test` green on `main`, `/dashboard` shows the agent
dropdown locally (`node dist/cli/index.js demo` is enough to eyeball it — do NOT restart the
prod daemon yet).

## Wave 2 — 2 parallel worktrees, off the wave-1 merged tip (~45 min)

  444 (ingest override + log event) ∥ 445 (backfill → project column + sessions, dry-run default)

```bash
P=.claude/artifacts/loop/ai-loop/slices
mv $P/blocked/SLICE_444_* $P/blocked/SLICE_445_* $P/pending/
bun "C:/Users/serge/.claude/plugins/cache/astra/runner/0.78.0/src/scripts/loop.mts" wave plan --repo "$PWD" --size 2 --json   # expect exactly 444 + 445
bun "C:/Users/serge/.claude/plugins/cache/astra/runner/0.78.0/src/scripts/loop.mts" wave run  --repo "$PWD" --size 2
```

- Both consume SLICE-442's heuristic and DEC-017; neither edits `cwd-basename.ts`.
- 444 must extend the FEAT-484 canary (`tests/tag-hygiene/worktree-ingest-canary.test.ts`) to
  assert `sessions.project`, not just `sessions.repo` — that is the AC-1 proof.
- 445 keeps FEAT-484 behaviour byte-identical when `--column repo` (default) and must show two
  consecutive dry-runs with identical counts (AC-6).
- Merge order: **444 → 445**. Post-merge `bun run test` green.

**Release step (lead, serial, ~15 min, needs operator awareness — restarts the prod daemon):**
```bash
bun run build
node dist/cli/index.js reinstall        # materializes 0.22.1+<sha>, repoints shim, restarts, health-gates
node dist/cli/index.js doctor | grep -E 'Served version|handler run-log|Instance lock'
```
Known `reinstall` quirks (docs/memory.md 2026-11-05): prune keeps the wrong two releases
(`--rollback` would land on 0.15.1 — do not rely on it; keep the backup from Wave 3 step 1
instead), and `reinstall` re-arms the FEAT-439 post-merge hook. Version stays 0.22.1 unless a
release is cut; cutting one must bump (064 is a schema change).

## Wave 3 — operator-gated prod apply (1 slice, serial, operator present)

  447 — runbook + execution

```bash
P=.claude/artifacts/loop/ai-loop/slices
mv $P/blocked/SLICE_447_* $P/pending/
# NOT via wave run (autonomous_safe=false on FEAT-553 and this slice mutates 17,877 live rows):
/runner:start --id SLICE-447     # then follow docs/runbooks/provenance-backfill.md with the operator
```

Runbook skeleton (the slice writes the real file):
1. Preconditions: wave 2 merged + released (`doctor` says served version = build with the
   override); `ls migrations | tail -1` == the installed release's last migration (checkout-CLI
   migrates prod footgun).
2. `node dist/cli/index.js backup` → note snapshot path.
3. Preview: `node dist/cli/index.js repo-identity-backfill --column all --sessions --json > preview.json`;
   record scanned / would-re-stamp / unresolved; expect unresolved > 0 (deleted worktrees with
   no recoverable shape stay as-is by design — DEC-017 rule 1).
4. Operator confirms the preview; run again with `--yes`.
5. Verify: `memories WHERE project GLOB 'agent-*'` and the same on `sessions` both == reported
   unresolved (AC-8); `/dashboard` project dropdown no longer lists resolvable `agent-*` names;
   `doctor` green on handler run-log.
6. Write the final numbers into `docs/memory.md` (supersede the 2026-11-05 gap entry) and close
   FEAT-553.
Rollback: `node dist/cli/index.js restore <snapshot>`.

## Guardrails (house rules)

- Never kill node processes machine-wide; the prod daemon, eval shards and sibling agents share
  this box (AGENTS.md Never-do).
- No `git stash` inside worktrees (repo-global stash). `git diff > x.patch` instead.
- Checkout `dist/` CLI (`doctor`, `queue`, `memory health`, the backfill) runs `migrate()` on the
  prod datadir: compare `ls migrations | tail -1` against the installed release before pointing
  any checkout CLI at the live datadir. Right now they match (064 both sides).
- Do not run `/devcrew:build` or `/runner:auto` against `main` while a wave is in flight — they
  race on workflow-state.
- Every slice closes through the ceremony (`slice complete` + grade), never by hand-moving files.
- Commit discipline: wave merges are local commits on `main`; no tag push, no `npm publish`, no
  force-push. A release tag is a separate, explicit decision.

## Timeline / cost estimate

| Wave | Wall-clock | Agents | Notes |
|---|---|---|---|
| 0 prep | ~10 min | 0 | commit + build + test + plan check |
| 1 | ~45–60 min | 4 builders + 4 reviewers + 3 verifiers | 448 is the longest (dashboard + 2 test suites) |
| 2 | ~45 min | 2 + 2 + 2 | 444's canary test spins real git worktrees |
| release | ~15 min | 0 | restarts prod daemon; watch `/health` |
| 3 | ~20 min + operator | 1 | dry-run → confirm → apply → verify |

Total ≈ 2.5–3 h wall-clock, ~9 slice ceremonies. FEAT-554 is fully done after wave 1;
FEAT-553 after wave 3.

## Verification of the whole plan (definition of done)

- `bun run test` green on `main` after each wave; `node contracts/validate.mjs` green (no wire
  change expected — if it goes red, a slice overstepped `contracts/`).
- `/dashboard?agent=crew:reviewer` filters and paginates; `/dashboard` project dropdown has no
  resolvable `agent-*` entries after wave 3.
- `doctor`: handler run-log green, served version = build.
- `docs/memory.md` gap entries superseded with final numbers; FEAT-553 and FEAT-554 in `done/`.
- Cross-repo issue `astragenie/astramem-plugin#N` referenced from FEAT-553.
