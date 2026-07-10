---
id: FEAT-462
status: in-progress
priority: P1
category: infra
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: [SLICE-422]
derived_from: 2026-07-10 eval-death post-mortems (3 failed LongMemEval runs)
cross_product: [astramem-local]
pm_user_value: 0.55
pm_strategic_fit: 0.6
pm_effort_inverse: 0.6
pm_risk_inverse: 0.6
pm_confidence: 0.65
composite_score: 0.6
composite_priority: P1
autonomous_safe: true
triaged_at: 2026-07-10
started_at: 2026-07-10
---
## Description

**Eval-harness durability: resume support + detached execution** — the
LongMemEval harness (and the incoming LoCoMo harness, FEAT-457) currently runs
as a session-child process with zero resume capability. Three runs died in two
days without producing a number: (1) session limit killed the parent →
shard daemons died mid-distill; (2) resource contention; (3) a sibling
agent's machine-wide `taskkill /F /IM node.exe|bun.exe` killed harness +
shard daemons 40 minutes in. Every death restarts a multi-hour distill from
zero because each launch creates a fresh run dir.

### Scope

1. **`--resume <run-dir>`** for run-smoke.mts (and the LoCoMo run.mts once
   merged): re-attach to an existing run dir — shard datadirs (SQLite) already
   hold all distill progress; ingest is already idempotent (Idempotency-Key).
   Resume = respawn shard daemons on the existing datadirs, skip ingest for
   sessions already recorded in ingest-manifest.json, resume the distill-wait
   poll. Any death becomes a pause.
2. **Detached execution mode** — `--detach` (or a small wrapper script) that
   launches the run under a Windows scheduled task / `Start-Process`-detached
   process group (same survival pattern as the `AstraMemoryD` schtasks
   keepalive), so session end / terminal close cannot kill an overnight eval.
   Writes progress + a PID/status file into the run dir so a later session can
   check on it and re-attach with --resume.
3. **Shard-daemon PID manifest** — write spawned daemon PIDs + ports into the
   run dir so scoped cleanup ("kill MY strays") is trivial and image-name
   shotgun kills are never needed.
4. Harness README section documenting the resume/detach workflow.

### Non-goals
Cross-machine resume; resuming the Azure answer/judge phase mid-stream (those
are minutes, not hours — re-run is fine); changing eval semantics/scoring.

### Approximate ETA
**~1-1.5 days.**

## Intake notes
Filed 2026-07-10 after third eval death. Directly unblocks the top
product-credibility item (publish an honest LongMemEval number — see
docs/research/2026-07-09-packaging-audit.md product item 1). Pairs with the
new CLAUDE.md process-hygiene rules (no image-name kills, scoped PID cleanup).
Unscored; run `/runner:triage`.

## Acceptance criteria (Given-When-Then)

- **AC-1:** Given an existing run dir from a prior `run-smoke.mts` or `run.mts` invocation whose per-shard `ingest-manifest.json` is only written once, at end-of-phase, after `ingestQuestions`/`ingestConversations` returns (`scripts/eval/longmemeval/run-smoke.mts:135`, `scripts/eval/locomo/run.mts:115`) — so a mid-ingest crash today leaves no record distinguishing "never attempted" from "in flight" — When the harness is re-launched with `--resume <run-dir>`, Then it respawns each shard daemon pointed at its existing `datadir` (already durable SQLite; daemon distill state is read live via `GET /sessions/:id/digest`, `scripts/eval/shared/daemon-client.ts:75`, so in-flight distill work resumes automatically on respawn with no extra logic), reads a crash-safe append-only ledger to skip re-POSTing every session already recorded ok, and resumes `waitForQuestionsDistilled`/`waitForSamplesDistilled` against the merged old+new manifest.
- **AC-2:** Given the harness is launched with `--detach` on Windows, When the invoking terminal or Claude Code session that spawned it ends, Then the orchestrator process and its child shard daemons continue running under a detached mechanism equivalent to the `AstraMemoryD` schtasks keepalive pattern (CLAUDE.md "Service / upgrade" section), and a status file in the run dir is updated with machine-readable state (running/completed/failed) and progress counts that a later `--resume` or a plain status-check can read without the original process's stdout.
- **AC-3:** Given shard daemons are spawned for a run (`spawnEvalDaemon` calls at `run-smoke.mts:122` / `run.mts:102`), When each daemon starts, Then its PID (the `ChildProcess.pid` — not currently captured anywhere on `DaemonHandle`, `scripts/eval/shared/spawn-daemon.ts:95-103`) and bound port are written to a manifest file in the run dir, so a cleanup script can target only those PIDs — satisfying CLAUDE.md's "Do NOT kill processes machine-wide by image name" rule this FEAT exists to support.
- **AC-4:** Given a shard daemon process is SIGKILLed mid-distill (simulating the 2026-07-10 taskkill incident CLAUDE.md's Do-NOT section records), When the harness is re-launched with `--resume <run-dir>`, Then the merged `ingest-manifest.json` shows every session ingested exactly once — verified by counting manifest entries directly, not merely inferred from `Idempotency-Key` replay behavior (`scripts/eval/longmemeval/ingest.mts:1-6` notes ingest is "resume-safe" via the session-id idempotency key alone, which this AC treats as a safety net, not the resume mechanism) — and the run reaches a final `hypotheses.jsonl`/`run-manifest.json` with no question's session count double-counted in the totals.
- **AC-5:** Given a fake/stub daemon or provider (no live LLM, no live Ollama) wired into a unit/integration test, When the test kills the stubbed shard process mid-distill and re-invokes the resume path, Then the test deterministically asserts resume correctness in CI — this exercise does not exist anywhere in the harness today (no test kills a daemon mid-distill and asserts on the aftermath).
- **AC-6:** Given `scripts/eval/locomo/run.mts` already exists as a complete, merged implementation (commit `480d870`, "feat(eval): add LoCoMo benchmark harness alongside LongMemEval (FEAT-457)") mirroring `run-smoke.mts`'s shard/ingest/distill-wait shape line for line, When `--resume`, `--detach`, and the PID/port manifest are implemented, Then the implementation lives in `scripts/eval/shared/` (new module alongside `spawn-daemon.ts`/`shard.ts`/`concurrency.ts`) and both `run-smoke.mts` and `run.mts` consume it identically in the same slice — this corrects the PM triage's "defer LoCoMo wiring until FEAT-457 merges" recommendation below, which rests on `FEAT-457.md`'s stale `status: triaged` frontmatter even though the code has already landed on `main`.
- **AC-7:** Given no `--resume` or `--detach` flag is passed, When `run-smoke.mts` or `run.mts` is invoked exactly as today, Then run-dir naming, the shape of `ingest-manifest.json`/`distill-wait-result.json`/`run-manifest.json`/`hypotheses.jsonl`, exit-code semantics, and the existing `--dry-run-throughput` mode are all unchanged.

## PM triage (2026-07-10)

### Demand assessment
**Who wants this?** The team/agents running LongMemEval evaluations (direct),
and indirectly any prospective OSS adopter who would judge this project by a
published retrieval-quality number. **Evidence, quoted:**
`docs/research/2026-07-09-packaging-audit.md:52` — "running and publishing one
honest LongMemEval/LoCoMo number (even mid-pack) is the single
highest-leverage move identified in the prior report's Deliverable 4 (Month 1
plan) ... This is now the top deferred item since every week-1 packaging
blocker is otherwise resolved or near-resolved." One of the three cited
failures is independently corroborated in this repo's own `CLAUDE.md` Do-NOT
section: "(2026-07-10: killed a 40-min LongMemEval run + prod daemon)" —
matches this FEAT's cited failure #3 exactly.
**Workaround today:** none — every death restarts a multi-hour distill from
zero; the only current mitigation is "don't get killed," which already failed
three times in two days per the FEAT body.
**Frequency:** every overnight/long eval run is at risk; three deaths in two
days is a real, recorded rate, not hypothetical.

### Scope challenge
**Smallest deliverable:** `--resume` + PID manifest for `run-smoke.mts`
(LongMemEval) alone — this is buildable today. **Real dependency not captured
in frontmatter:** the FEAT's own scope item 1 says "(and the LoCoMo run.mts
once merged)" — LoCoMo is FEAT-457, confirmed still `status: triaged`
(`.claude/artifacts/loop/backlog/triaged/FEAT-457.md`, `pm_autonomous_safe:
false`), i.e. not yet built. `depends_on: []` is technically accurate (the
LongMemEval half has no dependency) but understates that half the stated
scope is blocked. **What to cut if halved:** ship LongMemEval `--resume` +
PID manifest first; defer `run.mts` (LoCoMo) wiring until FEAT-457 merges —
recommend splitting this at slice time rather than blocking the whole FEAT on
FEAT-457.
**Overlap:** none — no other pending/triaged FEAT touches
`scripts/eval/shared/spawn-daemon.ts` or the harness resume/detach surface.
**AC clarity:** original scope is concrete and well-bounded (4 numbered
items, explicit non-goals) — ACs below sharpen it into Given-When-Then form
per P1 gating.

### Risk radar
**Technical unknowns:** detached execution reuses an existing repo pattern
(the FEAT names it directly: "same survival pattern as the AstraMemoryD
schtasks keepalive," documented in this repo's own `CLAUDE.md` under "Service
/ upgrade"), lowering novelty, but applying it to eval tooling (not the
production daemon) is a new context.
**Dependency chain:** confirmed above — LoCoMo half depends on FEAT-457
(still triaged, not merged); LongMemEval half is independent.
**Blast radius:** multiple files but all confined to `scripts/eval/` (harness
scripts + `shared/spawn-daemon.ts`) — never touches the production daemon or
`src/`.
**Failure modes:** resource exhaustion (orphaned detached processes if
cleanup is skipped), external dependency (shared Ollama singleton — this
repo's own grade lessons at `20260704T142054Z-feat421-slice415-grade.md` note
"The org's '5 runners' are 5 job slots on ONE EC2 host — anything shared
(Ollama daemon, docker images, caches) must be treated as a host singleton"),
timeout (mid-distill kill/resume race).
**technical_risk band:** 0.3–0.5 (new pattern *in this specific eval-tooling
context*, though the detach/keepalive pattern itself is repo-precedented; no
schema/contract change; clean rollback — eval tooling, not production
runtime). Scored `pm_risk_inverse: 0.6` (≈0.4 direct risk).

**Pre-mortem (mandatory: P1):**
1. *Two weeks later, review/validation failure — most likely cause:*
   `--resume`'s "skip already-ingested sessions" check relies on
   `ingest-manifest.json`, but a daemon killed truly mid-write could leave
   that manifest in a torn state; if validation only exercises a clean-pause
   resume (not a forced-kill-mid-ingest resume) the dupe-ingest edge case
   ships un-verified, papered over only by the Idempotency-Key as an
   accidental safety net rather than a resume-specific verified path.
2. *If this merged and broke the loop — rollback:* revert-only for the
   harness scripts (eval tooling, not production runtime; no migration, no
   cross-plugin coordination) — but an already-`--detach`'d orphaned process
   (Windows scheduled task / detached process group) is NOT killed by a code
   revert; cleanup requires manually killing the PIDs from the FEAT's own
   scope-item-3 manifest, a separate action from the revert.
3. *Existing test that would NOT catch a regression:* there is no existing
   automated test that kills a shard daemon mid-distill and asserts resume
   correctness — the harness has never been exercised under injected
   failure; this FEAT's AC-4 below must supply that evidence directly.

### Grade feedback
Weak dimensions per last 5 grades: `architecture_quality` (0.51),
`observability` (0.654), `production_readiness` (0.504), `security` (0.51),
`product_completeness` (0.504) — all below 0.80. Observability is already
substantially addressed by the FEAT's own scope item 3 (PID/port manifest) and
item 2 (status file) — AC-3 below makes this explicit and ties it to the
CLAUDE.md process-hygiene rule it's meant to support.

### Effort calibration
No exact single-project cost analog for eval-harness durability work.
Closest bounded single-project slice: FEAT-449
(`20260709T144324Z-cost-report-slice-feat449-slice419.md`: $72.34, 56 min,
"medium" shape) built a comparable filesystem-durability concept (spool +
resume-safe drain) in the production daemon. FEAT-462 touches more files
(harness scripts + shared spawn-daemon.ts across two eval suites) but stays
in test/tooling code, not production `src/` — scored `pm_effort_inverse: 0.6`
(≈0.4 direct effort), a bit higher than FEAT-449's actual effort given the
broader file touch-count, consistent with the FEAT's own ~1-1.5 day ETA.
Noted: "no exact cost analog; calibrated against FEAT-449 as the closest
durability-shaped single-project slice."

### Decomposition gate
Effort maps below the 8-point threshold — no `proposed_slices` needed, though
scopeNotes above recommend phasing (LongMemEval first, LoCoMo integration
deferred to post-FEAT-457) as an execution-order choice, not a formal slice
split.

```json
{
  "featureId": "FEAT-462",
  "scores": {
    "customer_impact": 0.55,
    "effort_estimate": 0.4,
    "strategic_alignment": 0.6,
    "technical_risk": 0.4,
    "dependency_depth": 0.35
  },
  "compositePriority": "P1",
  "autonomousSafe": true,
  "demandEvidence": "docs/research/2026-07-09-packaging-audit.md:52 — publishing an honest LongMemEval number is 'the single highest-leverage move' and 'the top deferred item'; one of the FEAT's three cited failures (taskkill killing a 40-min LongMemEval run) is independently corroborated in this repo's own CLAUDE.md Do-NOT section.",
  "scopeNotes": "Smallest deliverable is LongMemEval-only --resume + PID manifest; the FEAT's own scope item 1 depends on FEAT-457 (LoCoMo harness, confirmed still triaged/not merged) for its second half — recommend phasing rather than blocking the whole FEAT. Weak grade dimension observability (0.654 avg) already substantially addressed by the FEAT's own PID-manifest/status-file scope items.",
  "risks": [
    "Pre-mortem 1: --resume's ingest-manifest-based skip check may only be validated against a clean-pause resume, leaving a forced-kill-mid-ingest dupe-ingest edge case unverified.",
    "Pre-mortem 2: a code revert does not kill an already-detached orphaned process; PID-manifest-based manual cleanup is a separate required action.",
    "Pre-mortem 3: no existing test kills a shard daemon mid-distill and asserts resume correctness — this FEAT's AC must supply that evidence directly, it doesn't exist today."
  ],
  "reasoning": "P1: directly unblocks the packaging audit's top product-credibility item, with one of its three cited failures independently corroborated in CLAUDE.md; bounded to eval-tooling (never touches production src/), but carries a real, currently-unbuilt dependency (FEAT-457) for half its stated scope.",
  "acs": [
    "AC-1: Given an existing run dir from a prior bun scripts/eval/longmemeval/run-smoke.mts invocation with a partially-populated ingest-manifest.json (some sessions already ingested, distill still in progress), When the harness is re-launched with --resume <run-dir>, Then it respawns shard daemons on the existing datadirs, skips ingest for every session already present in ingest-manifest.json, and resumes the waitForQuestionsDistilled poll without re-ingesting any completed session.",
    "AC-2: Given the harness is launched with --detach, When the invoking terminal or Claude Code session ends, Then the shard daemon processes and the harness's orchestrator process continue running under the detached process group / Windows scheduled task, and a PID/status file in the run dir reflects 'running' state that a later session can poll.",
    "AC-3: Given shard daemons are spawned for a run, When each daemon starts, Then its PID and listening port are written to a manifest file in the run dir, so a cleanup script can kill only those PIDs without a machine-wide taskkill/Stop-Process sweep (per CLAUDE.md's 'Do NOT kill processes machine-wide by image name' rule).",
    "AC-4: Given a shard daemon is killed mid-distill (simulating the 2026-07-10 taskkill incident referenced in this repo's CLAUDE.md), When the harness is re-launched with --resume <run-dir>, Then no already-ingested session is re-ingested (verified directly against ingest-manifest.json, not merely inferred from Idempotency-Key behavior), and the run completes to a final hypotheses.jsonl without manual intervention."
  ]
}
```
