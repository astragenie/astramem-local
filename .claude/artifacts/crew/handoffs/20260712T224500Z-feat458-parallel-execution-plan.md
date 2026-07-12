---
type: handoff
created: 2026-07-12T22:45:00Z
author: lead (memory-repo session, validated by crew:architect + crew:architect-reviewer)
objective: Parallel execution plan for FEAT-458 — compress 6-9 serial dev-days into ~3 wall-clock waves
status: ready-for-pickup
companion: 20260712T220000Z-feat458-proxy-parallel-session-plan.md (the WHAT; read it first)
---

# FEAT-458 — parallel execution plan

This plan parallelizes the serial S1→S4 plan in the companion handoff. All
constraints there still bind (no image-name kills, no git stash, no push/merge
to main without ceremony, default-OFF capture flag, no heavy Ollama load).

## Dependency graph (why this shape)

```
S1-bench ──────────┐
                   ├──> S2-AC-4 latency evidence ──> S2 review+merge ──┐
S2-rebase ─────────┘                                                   │
S1-doctor-WARN (needs proxy config = S2 branch) ── rides w458s2 ───────┤
S1-closure-artifact (doc only, no deps) ── anytime ────────────────────┤
                                                                       v
                              ┌── W3a enum sweep (mechanical, disjoint files)
                    S3 ───────┤
                              └── W3b tee + capture module + canary (server.ts)
                                        │
                              interim review checkpoint (ADR-013 R5) — HARD GATE
                                        v
                              ┌── W4a upstream timeout + failure matrix (server.ts)
                    S4 ───────┼── W4c doctor WARN capture-enabled + purge e2e
                              └── W4b capture-live latency bench (LAST — needs all merged)
```

Key insight: the only true serial spine is `S2-merge → S3-tee → interim-review → S4-bench`.
Everything else hangs off it in parallel.

## Wave 1 — three parallel builders (~1 day wall-clock)

| Track | Owner | Worktree/branch | Work | Files (exclusive) |
|---|---|---|---|---|
| W1a | builder A | new worktree off main, `feat/feat-458-s1-proxy-bench` | S1-AC-3 bench harness in `scripts/eval/proxy-bench/`. Model on `scripts/eval/shared/` (`spawn-daemon.ts`, `stats.ts`). Must measure proxy p50/p95 overhead vs direct. NO Ollama — synthetic upstream stub only. | `scripts/eval/proxy-bench/**` (new dir, zero collision) |
| W1b | builder B | existing `w458s2` | S2 rebase onto main (~25+ commits behind; FIRST investigate duplicate merge commits `0b19681`/`f59698e` — understand, then squash/drop). Then S1-AC-2 doctor WARN row for proxy state (needs the proxy config block that only exists on this branch). | `w458s2` worktree only |
| W1c | doc-writer | main checkout artifacts dir (docs only) | S1-AC-4 design-gate closure artifact under `.claude/artifacts/crew/`. Cite DEC-014 corrected rationale. | one new .md, zero collision |

Wave-1 exit: bench harness reviewed; w458s2 rebased clean; closure artifact written.

## Wave 2 — serial joint step (~0.5 day)

Single builder (B continues): run W1a harness against w458s2 proxy →
S2-AC-4 p50 <10ms evidence → fresh full review (reviewer artifact ON DISK
before merge — FEAT-471 rule) → merge S2 branch + W1a branch.

No parallelism here — it is the join point. Keep it one owner.

## Wave 3 — S3, two parallel tracks (~2 days; high-risk, budget overrun)

| Track | Owner | Worktree | Work | Files (exclusive) |
|---|---|---|---|---|
| W3a | builder C | new worktree, `feat/feat-458-s3-capture-source` | Mechanical `capture_source: 'proxy'` plumbing: TS unions `src/contracts/memory.ts:108`, `src/storage/memories.ts:56`; scoping literal in `src/cli/capture.ts`. Leave `src/doctor/checks.ts:1118` alone. Tests for each. | contracts/, storage/, cli/capture.ts |
| W3b | builder D | new worktree, `feat/feat-458-s3-capture-fork` | The tee: thin `onBody?: (dir, chunk) => void` param in `src/proxy/server.ts` (ONLY change there); new capture module (buffer → parse → spool via `setImmediate`, body-only by construction); canary-header regression test; reuse `src/ingest/spool.ts` unchanged. | proxy/, new capture-fork module, tests/proxy/ |

File-collision check: W3a and W3b are disjoint by construction. W3b merges
first (it owns the riskier diff), W3a rebases on top — or vice versa, order
free since no shared files.

Wave-3 exit gate (HARD, ADR-013 Review decision 5): **interim review
checkpoint** — byte-transparency + non-mutation evidence + canary test green,
review artifact on disk. S4 does not open without it.

## Wave 4 — three tracks, two parallel + one serial tail (~1 day)

| Track | Owner | Work |
|---|---|---|
| W4a (parallel) | builder D | Per-request upstream timeout + failure-mode matrix (fail-open forward, fail-silent capture) in `src/proxy/server.ts` |
| W4c (parallel) | builder C | Doctor WARN row for capture-enabled state + live disable→purge e2e against real `capture_source: 'proxy'` records (purge primitive already shipped, FEAT-467 — only the `proxy disable` CLI subcommand is new) |
| W4b (serial tail) | one owner | Capture-live latency bench (harness from W1a) — p50 <10ms WITH capture on. Runs LAST, after W4a+W4c merge. |

## Ceremony per track

Each track = one slice through `/runner:start --id SLICE-NN` →
build → `crew:reviewer` (artifact on disk) → `crew:verifier` where behavior
changed → `/runner:close`. AC bullets must start `Given` or `AC-<n>` (hyphen).
`dev.stable: true` — local commits fine; no push, no tags, no prod enablement.

## Collision boundaries with other active sessions

- `astramemory-local` main checkout: another session commits there. Builders
  work ONLY in their named worktrees; merges to main go through the join-point
  owner (Wave 2 / wave exits), one merger at a time.
- `...-worktrees\w474`, `w475`: taken, do not touch.
- No heavy GPU/Ollama load — a ~4h eval may be running. Bench harness must use
  a synthetic upstream stub, never a real model.

## ETA

| Wave | Wall-clock |
|---|---|
| 1 | ~1 day (3 parallel) |
| 2 | ~0.5 day (serial join) |
| 3 | ~2 days (2 parallel, S3 overrun risk) |
| 4 | ~1 day (2 parallel + bench tail) |
| **Total** | **~4-4.5 wall-clock days** vs 6-9 serial — S3 remains the swing risk |

Definition of done unchanged from companion handoff §8. Production enablement
excluded — bake gate + explicit operator call.
