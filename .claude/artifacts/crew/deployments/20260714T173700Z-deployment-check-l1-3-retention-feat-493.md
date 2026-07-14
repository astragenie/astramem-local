---
task: L1-3 (wave merge, follows SYNC-1)
repo: astramemory-local
date: 2026-07-14
operator_approval: on record — merge review-PASS wave lanes, same bounds as SYNC-1
bounds: no force-push, no tags, stop on red
outcome: PASS — merged clean
related: .claude/artifacts/crew/deployments/20260714T165300Z-deployment-check-sync1-contracts-v2-3-0-publish.md
---

# Deployment check — L1-3 retention scaffolding (FEAT-493)

## PR

[#317](https://github.com/astragenie/astramem-local/pull/317) — "feat(retention): FEAT-493
scaffolding — mode enum, dry-run scan, doctor stat (deletion clamped off)". `wave/l1-3-retention`
→ `main`. 4 commits: 3 original (`7c2df6a`, `a05f668`, `7487617`) + 1 added per team-lead
instruction (`d578acb`, CLAUDE.md doc fix).

## Review on record

PASS — `.claude/artifacts/crew/reviews/20260714T172756Z-review-l1-3-retention-feat-493.md`. All
six claims verified directly against source: scope boundary respected vs. `archival.ts` (FEAT-404,
memory-row axis, untouched), deletion clamped off by construction (`applyRetentionGovernance`
downgrades `enabled` → `dry-run` unconditionally, loud log), directory-based zero-DB scan,
FEAT-461 config round-trip guard extended, doctor row informational-only semantics, deliberately
empty `heavyArtifact.types` pending FEAT-489/L1-1. 46/46 tests, CI-parity `tsc -p
tsconfig.tests.json` clean.

## Doc-fix commit (added before opening PR, per team-lead)

`CLAUDE.md`'s "Known open gaps" section claimed the `artifacts` SQL table was a live zero-writer
table. Wrong — `migrations/040-drop-dead-tables.sql` dropped `messages`, `artifacts`, and
`provider_state` irreversibly (confirmed by reading the migration's own DROP TABLE statements and
header comment). This lane's builder targeted the dropped table on a first design pass and failed
at runtime — the exact stale-doc-read-as-authoritative failure class this repo documents
elsewhere. Corrected the bullet to state the drop and point at where disk artifacts actually live
(`<dataDir>/artifacts/<kind>/`, governed by this FEAT). Only `evidence_guard_drops` (migration
030) remains an actual zero-writer, in-flight table — the old bullet's "four tables" claim is now
also corrected to reflect that.

## Merge — branch had diverged, one real problem found and fixed

Branch was cut from `main` slightly stale (missing 1 commit: `db3f267` "feat(proxy): experimental
hard-gate", PR #302). Fetched and merged `origin/main` locally — **no conflicts**, `ort` strategy
auto-merged cleanly (`src/doctor/checks/index.ts` included; confirmed `checkRetention`,
`checkEmbedCacheHitRate`, `checkMemorySentinel`, and `checkProxyCapture` all still registered
post-merge).

**Problem found, self-resolved:** after the merge, `npx vitest run tests/doctor/ tests/proxy/
tests/config/` showed 2 failures — both `tests/proxy/experimental-gate.test.ts` cases timing out
at 15s. Root-caused before assuming a real regression: that test spawns the *built*
`dist/cli/index.js`, not source, and this worktree's `dist/` predated the just-merged proxy-gate
commit, so the spawned CLI lacked the new gate check and hung waiting to bind a real listener
instead of refusing immediately. Verified this was a local stale-build artifact, not a repo
regression, by reproducing the pass (3/3, clean) on a disposable fresh worktree off `origin/main`
before touching anything. Fixed with `bun run build` in the working worktree; re-ran
`tests/proxy/` (31/31) then the full `tests/doctor/ tests/proxy/ tests/config/` sweep
(**450/450**, 55 files) before pushing.

## CI

All 5 checks green on first push (Test self-hosted Bun 1.3, TypeScript type-check, audit,
cross-repo-roundtrip, auto-merge). No red this time.

## Merge

Auto-merge fired automatically. Merge commit `4d4ed8c6f125534866a528720894b1e7b7958932`.

## Anything red

No CI red. One local-only false alarm (stale `dist/`, see above), diagnosed and confirmed
non-regression via a disposable clean-worktree comparison before rebuilding, not papered over.

## Final state

- `main` HEAD now `4d4ed8c6` (PR #317's merge commit), on top of the full L0 set
  (`#312`→`#313`→`#314`→`#315`→`#316`) plus the intervening `#302`/`#295` commits this branch's
  base had missed.
- `src/doctor/checks/index.ts` on `main` registers `checkRetention` alongside all four prior L0
  additions — no clobbering.
- `CLAUDE.md`'s dropped-tables claim is now accurate.

## Heads-up carried forward from team-lead

`wave/l1-4-hardening` is still building and may also touch `src/doctor/checks/index.ts` — if its
PR lands with a same-anchor conflict, same resolution pattern as L0-3/L1-3: keep all registrations,
no reordering of existing entries.
