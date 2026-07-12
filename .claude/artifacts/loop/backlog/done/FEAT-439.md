---
id: FEAT-439
status: done
priority: P1
category: platform
target_release: null
created: 2026-07-07
updated: 2026-07-07
depends_on: []
slices: []
derived_from: ops-incident-2026-07-07-stale-dist-outage
tags: [concern:reliability, surface:cli, surface:doctor, surface:loop, stack:typescript]
pm_customer_impact: 0.85
pm_effort_estimate: 0.55
pm_strategic_alignment: 0.80
pm_technical_risk: 0.55
pm_dependency_depth: 0.30
pm_effort_points: 5
composite_score: 0.71
composite_priority: P1
autonomous_safe: true
pm_demand_evidence: "Same incident as FEAT-438/440, second-layer framing: 'Merging a PR with a migrations/ file changes nothing about the running service: no rebuild, no reinstall, no warning... The drift is invisible until the next service restart fails (2026-07-07: 8h crash-loop).' Body explicitly notes the doctor-probe half is implementable independent of FEAT-438."
pm_scope_notes: "Soft/conceptual dependency on FEAT-438 only ('which release is served'); doctor probe + hook implementable against today's layout too. Default the 'candidate homes (architect picks)' choice to the FEAT's own safest option — BOTH the git post-merge hook AND the loop-ceremony check, hook as backstop — keeping the ticket builder-dispatchable. Coordination: this ticket and FEAT-440 both touch doctor.ts (439 adds schema-drift RED, 440 adds crash-loop RED) — sequence as two reviewed diffs, not parallel dispatch (Core Rule 1)."
pm_risks:
  - "Pre-mortem (P1): most likely failure is the 'non-blocking-safe' rebuild trigger silently swallowing its own failure (fire-and-forget rebuild, no surfaced badge) — the ticket would then claim the drift gap closed while a broken trigger reproduces the exact silent-failure shape of the original incident."
  - "Pre-mortem: rollback is revert-only if implemented as a repo-local git post-merge hook + loop-ceremony check; if the hook gets packaged into the astra/runner plugin template, rollback needs a version bump in that separate repo (same cross-repo hazard as FEAT-422) — scope repo-local first."
  - "Pre-mortem: no existing test exercises a real merge-to-main touching migrations/ triggering a real rebuild end-to-end — kill-test AC-1 (live or simulated merge) is the only thing that closes this gap."
reasoning: "P1 via formula: impact 0.85>=0.7 AND alignment 0.80>=0.6. technical_risk 0.55 (new repo pattern — build automation off git state — cross-module reach into doctor.ts + loop ceremony, but no schema/data change, clean revert). autonomous_safe true: risk 0.55 / effort 0.55 / dependency 0.30 all under 0.6, GWT ACs supplied — the 'architect picks' ambiguity has a safe builder-resolvable default named in the FEAT's own text."
triage_notes: "Second layer of the stale-dist fix: nothing in the merge path rebuilds/reinstalls the service, and nothing detects binary-vs-DB schema drift before boot fails. Add a post-merge trigger + a doctor drift probe. With FEAT-438 (pinned releases) the failure mode downgrades from outage to staleness — this ticket keeps the service CURRENT and makes drift visible."
---

# FEAT-439: migration-merge currency — post-merge build+reinstall trigger + doctor schema-drift probe

## Problem
Merging a PR with a `migrations/` file changes nothing about the running service:
no rebuild, no reinstall, no warning. Meanwhile worktree agents can migrate the
shared live DB ahead of the served binary. The drift is invisible until the next
service restart fails (2026-07-07: 8h crash-loop). Even after FEAT-438 pins
releases, the pinned release goes stale silently.

## Requested capability
Two independent mechanisms:

1. **Post-merge trigger.** When main advances with changes under `migrations/`
   or `src/storage/`, run `bun install && bun run build && reinstall`.
   Implement BOTH homes, hook as backstop (PM default per triage):
   - git `post-merge` hook in the main checkout (covers `git pull` + local merges);
   - loop rule: slice-complete / wave-merge ceremony checks the merged diff for
     `migrations/` and dispatches the rebuild.
   Must be non-blocking-safe: a failed rebuild must not eat the merge — it reports
   loudly (help_request badge / stderr) and leaves the old release serving.

2. **Doctor drift probe.** `doctor` compares schema versions and FAILs on
   mismatch with a copy-pasteable fix command:
   - `SCHEMA_VERSION` of the SERVED release (read from the release dir / dist);
   - `MAX(user_version)`/migration counter of the live DB;
   - `SCHEMA_VERSION` of the repo working tree (when doctor runs from repo).

## Acceptance criteria

(PM-tightened, 2026-07-07)

- AC-1: Given main advances with a commit touching `migrations/`, When the
  post-merge trigger fires, Then `bun install && bun run build && reinstall`
  completes and a subsequent `GET /version` on the daemon reports the new build's
  version within the trigger's completion window.
- AC-2: Given `doctor` runs, When the served release's `SCHEMA_VERSION` (from
  `src/server/lib/wire-meta.ts`, cross-checked against the guard at
  `src/storage/migrate.ts:100`) differs from the live DB's migration counter,
  Then `doctor` FAILs with a RED 'schema drift' finding printing both version
  numbers and a copy-pasteable `reinstall` fix command.
- AC-3 (failure path): Given the rebuild triggered by the post-merge hook fails
  (e.g. `bun run build` exits non-zero), When the trigger observes the failure,
  Then the merge itself is not blocked or reverted, the previously-served release
  keeps serving, and the failure is surfaced via a `help_request` badge or
  equivalent stderr/artifact — never silently swallowed.
- AC-4 (rebuild-storm edge case): Given N commits touching `migrations/` land on
  main within one `git pull`/merge batch, When the post-merge trigger evaluates
  the batch, Then exactly one rebuild runs, not N (de-duped).
- AC-5 (observability green path): Given the served schema version and the live
  DB's schema version match, When `doctor` runs, Then it reports GREEN for the
  schema-drift check, and running it again immediately afterward stays GREEN with
  no side effects.

## Refs
- Incident: 2026-07-07 stale-dist outage (drift guard migrate.ts:100).
- Depends conceptually on FEAT-438 for the "which release is served" question,
  but the doctor probe + hook are implementable against today's layout too.

## Closure note (2026-07-12)

Verified already implemented on main (commit 12a674b, reviewed
approved_with_notes 2026-07-08, 169/169 tests). All 5 ACs code-complete:
post-merge-rebuild.mjs (AC-1/3/4), checkSchemaDrift in doctor/checks.ts
(AC-2/5), fixture-repo + doctor tests. Residual found by 2026-07-12 verify
pass: the git hook was never ACTIVATED on any checkout (opt-in comment only).
Resolved for this machine: `git config core.hooksPath scripts/git-hooks` set
2026-07-12. Follow-up (small): wire hooksPath activation into init/reinstall
onboarding or package.json prepare so fresh checkouts get it — tracked in
session task list, candidate for a dev-lite dispatch.
