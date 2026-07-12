---
id: FEAT-440
status: done
priority: P1
category: platform
target_release: null
created: 2026-07-07
updated: 2026-07-07
depends_on: [FEAT-438]
slices: []
derived_from: ops-incident-2026-07-07-stale-dist-outage
tags: [concern:observability, concern:reliability, surface:service, surface:doctor, stack:typescript]
pm_customer_impact: 0.85
pm_effort_estimate: 0.45
pm_strategic_alignment: 0.75
pm_technical_risk: 0.45
pm_dependency_depth: 0.35
pm_effort_points: 5
composite_score: 0.72
composite_priority: P1
autonomous_safe: false
pm_demand_evidence: "Direct incident evidence: 'the 2026-07-07 outage crash-looped every 5 min for 8h with ZERO trace — launch.cjs uses stdio:inherit so schtasks discards crash stderr... schtasks Last Result: 1 was the sole trace.' Verified src/service/shim.ts exists (98 lines) as the real file this FEAT targets."
pm_scope_notes: "depends_on: [FEAT-438] — explicit and NOT yet resolved (438 is in this same batch). Smallest deliverable if halved: exit-history + crash.log capture (the two mechanisms that would have actually shortened the 8h incident); defer the toast stretch AC and possibly the doctor RED integration to a fast-follow tied to FEAT-439's doctor work (both touch doctor.ts — see FEAT-439 coordination note)."
pm_risks:
  - "Pre-mortem (P1): most likely failure is the exit-history/crash-log write path itself throwing on a locked or read-only logs directory — despite the explicit 'must never throw' requirement, an unhandled exception there prevents the shim from spawning the daemon at all, turning an observability-only feature into a NEW outage vector: the worst possible regression for this specific ticket."
  - "Pre-mortem: rollback is revert-only — single shim file + doctor.ts read-path addition; git revert fully restores prior (silent) behavior. Low rollback cost is why technical_risk sits at 0.45 even though the correctness bar (never block the daemon spawn) is subtle."
  - "Pre-mortem: no existing test simulates a real OS-level crash-loop via the schtasks keepalive — a unit test of launch.cjs's append logic could pass while the real keepalive-driven rapid-respawn path races on ring-buffer truncation; the kill-test AC (config broken, 3+ real restarts) must run for real, not mocked."
  - "Same-file collision: FEAT-440 targets the same shim FEAT-438 rewrites, both unbuilt. Dispatching autonomously before 438 lands risks two independent diffs against the same file landing out of order — the specific reason autonomous_safe is overridden to false despite all mechanical thresholds passing."
reasoning: "P1 via formula: impact 0.85>=0.7 AND alignment 0.75>=0.6. technical_risk 0.45 (new pattern confined to one module + doctor read-path, no schema/data change, cheap revert). autonomous_safe is a PM override to false: mechanical thresholds (risk 0.45, effort 0.45, dependency 0.35) all pass, but the FEAT-body-stated same-file sequencing dependency on unbuilt FEAT-438 is a real one-owner-per-file hazard (Core Rule 1) the thresholds don't capture — safe once FEAT-438 lands or as a combined shim-rewrite pass, not independently right now."
triage_notes: "Third layer: the 2026-07-07 outage crash-looped every 5 min for 8h with ZERO trace — launch.cjs uses stdio:inherit so schtasks discards crash stderr, and nothing counts consecutive failures. Shim must persist exit history + crash output; doctor (and optionally a toast) must surface a crash loop. depends_on FEAT-438 because that ticket rewrites the same shim — land the new shim once."
---

# FEAT-440: crash-loop visibility — shim exit history + crash stderr capture + doctor alert

## Problem
When the daemon dies before its file logger opens (config/migration/boot errors),
the crash output goes to the schtasks void: `launch.cjs` spawns with
`stdio: 'inherit'` and records nothing. The keepalive re-runs it every 5 min
forever. 2026-07-07: 8h of exit-code-1 crash-loop, diagnosable only by manually
running serve in a foreground shell. `schtasks Last Result: 1` was the sole trace.

## Requested capability
1. **Exit history.** `launch.cjs` appends `{ts, exitCode, durationMs}` to
   `%LOCALAPPDATA%\Astramem\logs\exit-history.jsonl` after every daemon exit,
   ring-buffered to last ~50 entries (rewrite-on-append with truncation; must
   never throw — history writing can't take the shim down).
2. **Crash stderr capture.** Shim pipes child stderr to a small rolling
   `%LOCALAPPDATA%\Astramem\logs\crash.log` (last ~64KB) so pre-logger boot
   errors (like the schema-drift throw) persist verbatim. stdout stays inherited;
   healthy runs write ~nothing to stderr.
3. **Doctor alert.** `doctor` reads exit-history: >=3 consecutive non-zero exits
   in the recent window → RED "crash loop" finding that prints the exit codes,
   time span, and the tail of crash.log.
4. **Optional toast (stretch AC).** On crash-loop detection the shim (or a doctor
   --watch mode) fires one Windows toast per hour max ("AstraMemory daemon crash
   loop — run doctor"). De-duped; must degrade to no-op silently on non-Windows
   or when toast infra is unavailable.

## Acceptance criteria

(PM-tightened, 2026-07-07)

- AC-1: Given the daemon exits (any exit code), When `launch.cjs` observes the
  child process close, Then it appends `{ts, exitCode, durationMs}` as one line
  to `%LOCALAPPDATA%\Astramem\logs\exit-history.jsonl`, ring-buffered to the
  last 50 entries.
- AC-2: Given the daemon crashes before its file logger opens (e.g. the
  `src/storage/migrate.ts:100` schema-drift throw — the exact 2026-07-07 failure
  mode), When the shim's piped stderr receives that output, Then the verbatim
  error text is persisted to `%LOCALAPPDATA%\Astramem\logs\crash.log` (rolling,
  last ~64KB), readable after the process has already exited.
- AC-3 (edge case — reproduces the incident): Given exit-history shows >=3
  consecutive non-zero exits within the recent window, When `doctor` runs, Then
  it reports a RED 'crash loop' finding printing the exit codes, the time span,
  and the tail of `crash.log`; Given the config is then fixed and the daemon
  produces one zero-exit run, Then the consecutive-failure counter resets and the
  next `doctor` run is GREEN.
- AC-4 (failure-isolation / never-throw guarantee): Given the logs directory is
  locked or read-only, When history/crash-log writes fail, Then the write failure
  is swallowed (never throws) and the daemon spawn proceeds unaffected — verified
  by a test that makes the logs dir unwritable and asserts the daemon still starts.
- AC-5 (healthy fast-exit isolation): Given the instance lock causes a healthy
  no-op fast-exit (<100ms, exit 0), When this is recorded in exit-history, Then
  it does NOT count toward the crash-loop streak — exit 0 resets the
  consecutive-failure counter, distinguished from a real crash via the recorded
  `durationMs`.

## Refs
- Incident: 2026-07-07 — 8h invisible crash loop, `launch.cjs` stdio:inherit.
- depends_on: FEAT-438 rewrites the same shim (release-pinned entry) — implement
  the new shim once with both behaviors, or land 438 first.

## Closure note (2026-07-12)

Verified already implemented on main (commit 12a674b, same review as FEAT-439):
exit-history.jsonl ring buffer (last 50) + rolling crash.log (~64KB) in
launch.cjs, never-throw writes; doctor "Crash loop" check RED on >=3
consecutive non-zero exits with codes/span/crash-log tail; zero-exit resets
streak (instance-lock fast-exit never miscounted). The review's HIGH maxBuffer
finding was subsequently fixed (src/service/shim.ts:260-264 streaming capture;
pinned by tests/service/shim.test.ts:236-263 — 2MB stderr past the 1MB default,
real exit code preserved). depends_on FEAT-438 satisfied (shipped v0.9.x).
