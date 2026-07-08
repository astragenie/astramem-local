---
id: FEAT-438
status: done
priority: P0
category: platform
target_release: null
created: 2026-07-07
updated: 2026-07-08
depends_on: []
slices: [SLICE-416, SLICE-417, SLICE-418]
derived_from: ops-incident-2026-07-07-stale-dist-outage
tags: ["concern:reliability", "surface:cli", "surface:service", "stack:typescript"]
pm_customer_impact: 0.9
pm_effort_estimate: 0.65
pm_strategic_alignment: 0.85
pm_technical_risk: 0.8
pm_dependency_depth: 0.15
pm_effort_points: 8
composite_score: 0.7
composite_priority: P0
autonomous_safe: false
pm_demand_evidence: "Direct, dated production-incident evidence: 'Root fix for the 2026-07-07 8h outage: the OS service points current.json at the dev checkout's dist/, so every merge/worktree-agent mutation can strand the running service (schema drift guard fired: dist said 15, DB said 16).' Verified in source: src/storage/migrate.ts:100 contains exactly the cited guard."
pm_scope_notes: "Independent — root of the 438/440 chain (FEAT-440 depends on it). Smallest deliverable if forced to halve scope: release-materialization + pointer-repoint + served-version assert (closes the actual incident mechanism); defer retention/pruning + rollback to a fast-follow — but AC-3/AC-4 are cheap relative to the core and should stay per proposed_slices."
pm_risks: ["\"Pre-mortem (P0", "risk>=0.6): most likely failure is native-module packaging breaking inside the materialized release dir — better-sqlite3/SQLCipher and sqlite-vec are unbundleable", "needing a real node_modules via bun install --production or a prod-subset copy; a bun/Node ABI or platform mismatch there would make the 'immutable' release itself fail to boot", recreating the silent-degradation class this FEAT fixes, "one layer deeper.\"", "\"Pre-mortem: rollback is NOT a simple git revert once merged and misbehaving — reinstall --rollback needs a previous release dir to exist (none will", "on first rollout); recovery falls back to --dev escape hatch or manual current.json edit. Real operational rollback complexity — why technical_risk is banded at 0.80.\"", "\"Pre-mortem: no existing test exercises the real schtasks task + shim + genuine native-module resolution end-to-end — unit tests of the directory/pointer logic could pass green while the live task never restarts cleanly; the kill-test AC must run for real on a live Windows install", "not mocked.\""]
proposed_slices:
  - id_suffix: -SLICE-1
    title: Release dir materialization (dist + prod node_modules) + AC-5 failure guard
    points: 5
  - id_suffix: -SLICE-2
    title: "Pointer repoint + served-version assert against release manifest (AC-1, AC-2)"
    points: 3
  - id_suffix: -SLICE-3
    title: "Retention/prune + --rollback + --dev escape hatch + doctor/CLAUDE.md updates (AC-3, AC-4)"
    points: 5
reasoning: "P0 via formula: impact 0.90>=0.8 AND technical_risk 0.80>=0.8 (alternate P0 condition; category is 'feature' not 'bugfix'). technical_risk at the 0.6-0.8 ceiling: cross-module reach (install/CLI/service/doctor/docs) plus an unresolved architect design decision (install-into-release vs copy) — kept at 0.80 not 0.9+ because the pointer-repoint mechanism reuses the already-proven atomic tmp-file+rename pattern (FEAT-433). autonomous_safe false mechanically on BOTH effort (0.65>0.6) and risk (0.80>0.6). pm_effort_points=8 trips the FEAT-168 decomposition gate — satisfied via proposed_slices (3 slices, 13 pts)."
triage_notes: "Root fix for the 2026-07-07 8h outage: the OS service points current.json at the dev checkout's dist/, so every merge/worktree-agent mutation can strand the running service (schema drift guard fired: dist said 15, DB said 16). Pin the served artifact to an immutable versioned copy; dev tree churn stops affecting the service."
started_at: 2026-07-07
---
# FEAT-438: release-pinned install — service runs an immutable versioned copy, not the dev tree

## Problem
`current.json.entryJs` points at `C:/work/mega/astramemory-local/dist/cli/index.js`
— the live dev checkout. The autonomous loop merges PRs and worktree agents run
newer code against the shared live DB, so the served binary silently goes stale
relative to the DB. 2026-07-07: migration 016 landed + a worktree agent migrated
the DB while main's dist was still schema-15 → boot drift-guard refused start →
8h silent outage (crash-loop every 5 min via keepalive).

## Requested capability
`reinstall` materializes an immutable release directory and points the shim there:

- Layout: `%LOCALAPPDATA%\Astramem\releases\<pkgversion>+<gitsha>\` containing
  `dist/`, `package.json`, and production runtime deps (native modules —
  better-sqlite3/cipher, sqlite-vec — cannot be bundled; the release dir needs a
  real `node_modules`, e.g. `bun install --production` into it, or a copy of the
  checkout's prod subset. Design decision for architect: install-into-release vs
  copy; disk cost vs cold-install network dependency).
- `current.json.entryJs` → release dir entry. Upgrades = build → materialize new
  release → repoint pointer (already atomic) → restart. schtasks never re-touched
  (existing invariant preserved).
- Retention: keep last 2 releases, prune older on reinstall. Rollback =
  `reinstall --rollback` repoints to previous release.
- `reinstall --dev` escape hatch keeps the current behavior (point at repo dist)
  for daemon-development sessions, printed with a loud warning.
- Existing served-version-equals-build-version assert stays and now compares
  against the release manifest.

## Acceptance criteria

(PM-tightened, 2026-07-07)

- AC-1: Given `reinstall` runs, When it materializes
  `%LOCALAPPDATA%\Astramem\releases\<pkgversion>+<gitsha>\` containing `dist/`
  and a production `node_modules` (via `bun install --production` or an
  equivalent prod-subset copy), Then `current.json.entryJs` is repointed to that
  release's `dist/cli/index.js`, the shim restarts the daemon, and `GET /version`
  reports the release's `pkgversion`+`gitsha` matching the
  served-version-equals-build-version assert compared against the release manifest.
- AC-2: Given the service points at a versioned release directory, When the repo
  checkout's own `dist/` is deleted or rebuilt (e.g. a worktree agent running
  `bun run build` against a newer migration, as happened 2026-07-07), Then the
  running daemon is unaffected until an explicit `reinstall` runs again —
  `GET /health` stays `ok` and the served schema version does not change.
- AC-3: Given two consecutive `reinstall` runs have each materialized a new
  release directory, When a third `reinstall` completes, Then exactly 2 release
  directories remain (oldest pruned); Given `reinstall --rollback` is then run,
  Then `current.json` repoints to the immediately-previous release and
  `GET /version` reports that release's version after restart.
- AC-4 (edge case): Given an operator runs `reinstall --dev`, When the shim
  starts the daemon, Then `current.json.entryJs` points at the repo checkout's
  `dist/cli/index.js` (today's behavior, unchanged) and `doctor` reports a loud,
  unambiguous 'dev-pinned' warning distinguishing this state from a
  release-pinned install.
- AC-5 (failure/native-module edge case): Given `bun install --production` into
  the release directory fails (e.g. a native module fails to build), When
  `reinstall` detects the failure, Then it aborts BEFORE repointing
  `current.json`, the previously-served release keeps running unaffected, and the
  failure is surfaced loudly (non-zero exit + message) rather than leaving a
  half-materialized release directory as the new pointer target.

## Refs
- Incident: 2026-07-07 session — drift guard `src/storage/migrate.ts:100`,
  shim `%LOCALAPPDATA%\Astramem\bin\launch.cjs`, pointer `current.json`.
- Related: FEAT-440 (crash-loop alert) rewrites the same shim — sequence after this.
