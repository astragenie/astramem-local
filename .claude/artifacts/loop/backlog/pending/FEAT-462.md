---
id: FEAT-462
status: pending
priority: null
category: infra
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
slices: []
derived_from: 2026-07-10 eval-death post-mortems (3 failed LongMemEval runs)
cross_product: [astramem-local]
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
