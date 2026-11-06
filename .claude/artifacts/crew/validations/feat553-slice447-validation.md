---
decision: pass
---
# Validation Result: FEAT-553 SLICE-447 — operator-gated prod backfill apply

- Created: 2026-11-06T02:58:00Z
- Validator: lead session (operator present; approval recorded via AskUserQuestion:
  "Apply pass 1 + pass 2")
- Environment: main checkout `C:\work\mega\astramem-local` @ `0b96eb9e`, prod daemon
  release `0.22.1+0b96eb9e` (pid 32172), datadir `%LOCALAPPDATA%\Astramem`, schema 64 on
  both checkout and installed release (migration parity verified before any CLI touched the
  datadir).
- Decision: pass
- Scenario: AC-4 (never-guess preserved on prod), AC-6 (preview default + idempotent
  counts), AC-8 (remaining rows == unresolved; dashboard clean; doctor green).

## Preconditions

1. SLICE-444 + SLICE-445 merged (`c9bc8537`, `983a496f`); released via `reinstall` →
   `0.22.1+0b96eb9e`, `verify-health: chunk 1 healthy after 5s`; doctor "Served version
   matches this build" ✓.
2. `ls migrations | tail -1` = `064-cost-ledger.sql` on both checkout and release.
3. Queue drained before the restart (114 completed, 0 pending).

## Backup

`node dist/cli/index.js backup --json` → `memory-20261105T204726.sqlite`, 1,161,551,872
bytes, `verified: true`, 9.3s.

## Preview (dry-run, default) — AC-6

`repo-identity-backfill --column all --sessions --json`, run twice:

| column | scanned | would re-stamp | unresolved | sessions | run 2 |
|---|---|---|---|---|---|
| repo | 5,924 | 4,841 | 1,083 (9 no-session, 1,074 unresolved) | 7 | identical |
| project | 14,210 | 10,683 | 3,527 (115 no-cwd, 3,412 unresolved) | 12 | identical |

Sources (project): 8,371 `git-common-dir`, 2,312 `string-heuristic`, unresolved `null`.
No absolute path / home dir string in any candidate (checked all 20,134 candidates).
Targeted preview `--column project --sessions --pattern '^agent-l3-4$'`: 7,398 rows →
`prism`, all `string-heuristic` (worktree deleted), 0 unresolved, 2 sessions.

## Go/no-go

Operator reviewed the counts, the 7 branch-named worktree labels caught by the default
pattern (`memoized-jumping-elephant`→astramemory-local 1,050, `transient-dancing-wren`→dev-team
44, `b-rungraph-ts`→prism 24, `deploy-health-fix`→memory 22, `pr-open-design`,
`fix-canonical-content-hash`, `feat-entity-kinds-unify`) and the agent-l3-4 pass; approved
"Apply pass 1 + pass 2".

## Apply

1. `repo-identity-backfill --column all --sessions --yes --json` → repo applied 4,841
   (unresolved 1,083, sessions 7); project applied 10,717 (unresolved 3,493, sessions 12).
2. `repo-identity-backfill --column project --sessions --pattern '^agent-l3-4$' --yes --json`
   → applied 7,398 (unresolved 0, sessions 1).

## Verify — AC-8 / AC-4

Read-only census (DB opened `readonly: true`, no migrate):

| table.column | `agent-*` rows before | after | distinct after |
|---|---|---|---|
| memories.project | 17,877 | 969 | 23 |
| memories.repo | 4,849 | 854 | 7 |
| sessions.project | 11 | 2 | 2 |
| sessions.repo | 5 | 1 | 1 |

All remaining rows match the bad-shape pattern and are in the reported-unresolved set
(no session / no cwd / untrusted shape) — AC-4's never-guess guard held; AC-8's
"remaining == unresolved, no higher" holds (969 + 854 ≤ 1,083 + 3,493).
Post-apply dry-run: repo `applied: 0 / unresolved 1,083`, project `applied: 0 / unresolved 3,493`.
`/dashboard` project `<select>`: 372 → 102 options; 23 `agent-*` entries remain (the unresolved
set). Doctor after apply: handler run-log ✓ (distill success), served version ✓, instance lock
✓ (63 passed / 5 chronic failures unchanged). `/health` ok; one 55s event-loop stall was
recorded during the ~18k-row UPDATE pass and self-recovered — noted in docs/memory.md
("run in a quiet window").

## Write-back

`docs/memory.md` provenance entry superseded with the outcome and numbers;
`docs/runbooks/provenance-backfill.md` written (SLICE-447 deliverable).
