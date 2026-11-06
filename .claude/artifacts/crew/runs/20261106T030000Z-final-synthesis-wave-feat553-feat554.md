# Final synthesis — FEAT-553 provenance leak + FEAT-554 dashboard agent filter (3-wave run)

- Run: 2026-11-05T22:40Z → 2026-11-06T03:00Z, lead session "mem-local" (428de2a2), ultracode harness
- Plan: `.claude/artifacts/loop/plans/20261105T224000Z-wave-plan-provenance-553-agent-filter-554.md`
- Outcome: both FEATs shipped; prod daemon on release `0.22.1+0b96eb9e`; prod backfill applied

## What landed on `main`

| Slice | Merge | What |
|---|---|---|
| SLICE-442 | `d8ddad1f` | `deriveWorktreeSafeBasename` recognises `<repo>/.claude/worktrees/<x>` (string-only, 6 new tests) |
| SLICE-443 | `63904c64` | DEC-017: trust policy for string-derived project/repo identity when git cannot answer |
| SLICE-446 | `6a532b69` | `astragenie/astramem-plugin#68` (hook-side fix) + memory.md write-back |
| SLICE-448 | `379b4fa9` | FEAT-554: `/dashboard` agent filter (optgroups by plugin, top-N + free text, Agent column, deep link) |
| SLICE-444 | `c9bc8537` | ingest overrides hook-stamped `project_id` only when it equals `basename(cwd)`; structured override log with `source` |
| SLICE-445 | `983a496f` | `repo-identity-backfill --column repo\|project\|all --sessions`, `cwdBasename` + `source`, preview default |
| SLICE-447 | (docs) | `docs/runbooks/provenance-backfill.md` + the operator-gated prod apply below |

## Prod effect

- Backup `memory-20261105T204726.sqlite` (1.16 GB, verified) before any mutation.
- Backfill pass 1 (`--column all --sessions --yes`): repo 4,841 re-stamped / 1,083 unresolved; project
  10,717 / 3,493; sessions 19. Pass 2 (`--pattern '^agent-l3-4$'`): 7,398 → `prism`, 1 session.
- `agent-*` rows: memories.project 17,877 → 969 (23 distinct, unresolvable by design), memories.repo
  4,849 → 854, sessions 11 → 3. Post-apply dry-run proposes 0. Dashboard project dropdown 372 → 102.
- Doctor: handler run-log green; served version = build; 5 chronic failures unchanged.

## Gates

- Every slice: independent 3-lens adversarial verification (tests+build, AC evidence, scope+safety);
  2 slices needed a second fix round (448 twice: duplicate `agent` param + AC-4 test + scope amendment;
  445: `--json` absolute-path leak + `source` field). Verifiers that EXECUTED the artifact (form submit,
  compiled CLI) found the real defects; unit tests alone did not.
- Post-merge full suite after each wave: green except the two documented environmental failures
  (`shim.test.ts` under load, `scripts/eval/shared/detach.test.ts` — both reproduce on the base commit).
- Operator approval recorded before the prod apply (AskUserQuestion: "Apply pass 1 + pass 2").

## Open / follow-ups

- Plugin-side hook fix: `astragenie/astramem-plugin#68` (until it lands, ingest override + DEC-017
  cover new sessions).
- Dashboard activity feed is still a 25-row window; paging the full filtered history is a small FEAT.
- `reinstall` prune keep-order anomaly (seen once with a `0.22.0+…` dir present) — unfixed.
- Stale code defaults from the morning's outage: `DEFAULT_MODEL = 'gpt-5.4-mini'` in
  `src/providers/llm/codex-subscription.ts` + `config.ts` defaults (fresh installs break) — not in this run.
- `ASTRA_SKIP_CONSOLIDATE=1` in the box's persistent environment silently drops the consolidation suite.
- Slice grades written by a follow-up agent; `/runner:close`-style lessons live there.
