---
type: handoff
created: 2026-07-12T23:00:00Z
author: lead (memory-repo session 05e92741, validated by crew:architect + crew:architect-reviewer)
objective: Execute FEAT-458 (LLM proxy auto-capture) via the 4-wave parallel plan
owner: the NEXT orchestrator session picking this up cold — one orchestrator, N dispatched builders
status: ready-for-pickup
depends_on:
  - 20260712T220000Z-feat458-proxy-parallel-session-plan.md   # the WHAT (corrected + validated)
  - 20260712T224500Z-feat458-parallel-execution-plan.md        # the HOW-FAST (wave/track detail)
---

# FEAT-458 waves — orchestrator handoff

## Objective

Implement FEAT-458 end-to-end (S1 backfill → S2 finish → S3 capture fork → S4
hardening) using the 4-wave parallel plan. Definition of done: proxy capture
behind a **default-OFF** flag, p50 <10ms proven with capture live, canary test
proving headers never reach the spool, byte-transparency proven, disable→purge
e2e on real `capture_source: 'proxy'` records, S3 interim review checkpoint
passed. **Production enablement is explicitly NOT in scope** — bake gate +
operator call.

## Owner

You, the orchestrator session. You dispatch builders per track; you do NOT
implement inline (trivial one-line fixups excepted). One owner per track, one
merger at a time at wave joins.

## Read order (cold start, ~10 min)

1. This file.
2. `20260712T224500Z-feat458-parallel-execution-plan.md` — wave/track table,
   dependency graph, per-track file ownership. Your dispatch script.
3. `20260712T220000Z-feat458-proxy-parallel-session-plan.md` — full context:
   hard constraints (§2), gate resolution (§3), slice detail + builder notes
   (§4), the security thing that will bite (§5), ceremony + AC-parser gotcha
   (§6), key-files table (§7).
4. `docs/adr/ADR-013-llm-proxy-auto-capture.md` — before dispatching Wave 3.
5. `.claude/artifacts/loop/decisions/DEC-014.md` — corrected rationale: this is
   an explicit operator OVERRIDE of ADR-013's build gate (single-user local
   daemon, default-OFF protects npm consumers). Do not re-open; do not hide.

## State as of 2026-07-12T23:00Z (verify before trusting — main is moving)

- Worktree `C:\work\mega\astramemory-local-worktrees\w458s2`, branch
  `feat/feat-458-s2-proxy-core`: relay core done (`src/proxy/server.ts`,
  `src/cli/proxy.ts`, 3 test files, 40/40 pass per S2 review), **~25-26 commits
  behind main and growing**, two suspicious duplicate merge commits on tip
  (`0b19681`, `f59698e`) — investigate before rebasing.
- `scripts/eval/proxy-bench/` does NOT exist — S1-AC-3, gates S2 close.
- FEAT-467 purge primitive: **done on main**, `'proxy'` scoping already tested
  (`tests/server/capture-purge.test.ts:92-107`). Only `proxy disable` CLI
  subcommand remains.
- Migration 024 `capture_source`: plain TEXT, **no CHECK constraint**. Sweep
  list for `'proxy'`: `src/contracts/memory.ts:108`, `src/storage/memories.ts:56`,
  `src/cli/capture.ts`; leave `src/doctor/checks.ts:1118`, write new
  `checkProxyCapture`.
- S2 review verdict `incomplete_wip` — superseded on the gate question only
  (DEC-014); its substantive findings (missing bench harness → S2-AC-4
  unmeasurable) stand and are exactly what Wave 1/2 close.

## Allowed scope

- New worktrees under `C:\work\mega\astramemory-local-worktrees\` with fresh
  names; existing `w458s2`.
- Files per track ownership table in the execution plan — exclusive, no sharing.
- Local commits on feature branches (`dev.stable: true`). Merges to main only
  at wave joins, one merger, review artifact ON DISK first (FEAT-471 rule).

## Forbidden scope

- **No push, no tags, no prod enablement, no default-ON capture flag anywhere.**
- No image-name process kills (`pkill node`, `Stop-Process -Name node`) — PIDs
  you spawned only. Production daemon + sibling agents + possible multi-hour
  eval share this box.
- No `git stash` — repo-global across worktrees.
- No heavy Ollama/GPU load — bench harness uses a synthetic upstream stub.
- Worktrees `w474`, `w475`: taken by another session. Main checkout: another
  session commits there — read freely, never edit.
- Do not edit ADR-013 or DEC-014.

## Dispatch sequence (compressed — full detail in execution plan)

1. **Wave 1** — dispatch 3 in parallel:
   builder A → bench harness (`feat/feat-458-s1-proxy-bench`, new worktree);
   builder B → w458s2: dup-merge investigation, rebase, doctor WARN row;
   doc-writer → S1-AC-4 closure artifact.
   Each: `/runner:start` → build → reviewer artifact → `/runner:close`.
2. **Wave 2** — single owner: harness vs w458s2 → p50 <10ms evidence → fresh
   full review → merge S2 + bench branches.
3. **Wave 3** — dispatch 2 in parallel (worktrees, disjoint files):
   builder C → `capture_source` enum sweep; builder D → tee (`onBody` callback
   in server.ts ONLY) + capture module + canary test + `setImmediate` spool
   deferral. **Exit gate: interim review checkpoint (ADR-013 R5), artifact on
   disk — S4 does not open without it.**
4. **Wave 4** — dispatch 2 in parallel (D → upstream timeout + failure matrix;
   C → doctor WARN capture-enabled + purge e2e), then serial tail: capture-live
   latency bench, p50 <10ms.

## Deliverables

- All wave branches merged to main (locally), full suite green.
- Review artifacts per track + S3 interim checkpoint artifact under
  `.claude/artifacts/crew/reviews/`.
- Bench evidence (S2-AC-4 and S4 capture-live) under `.claude/artifacts/crew/validations/`.
- FEAT-458 slices closed via `/runner:close`; final synthesis handoff.

## Confidence and risks

- Confidence: high on Waves 1/2/4 (validated against disk 2026-07-12 by two
  independent agents); medium on Wave 3 (ADR-013's only "high" risk slice —
  budget overrun; mitigation: tee design pre-validated as buildable without
  restructuring the relay).
- Risk: main is moving (another session) — re-verify branch distance and rerun
  `git rev-list --left-right --count main...HEAD` at pickup; rebase conflicts
  possible in w458s2 config.ts.
- Risk: AC-parser gotcha — bullets must start `Given` or `AC-<n>` (hyphen)
  until runner-plugin 0.72.0 lands, else gate reports "no acceptance criteria".
- Open question (operator, non-blocking): when capture is observed working in
  the released plugins, the bake restarts shortened — length is operator's call.

## Suggested next handoff

After Wave 4: final synthesis + a deployment-guidance note stating capture is
built, default-OFF, and awaiting bake-gate + explicit operator enablement call.
