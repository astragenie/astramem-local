---
title: Wave execution plan — drain triaged backlog after v0.14.0
created: 2026-07-10T18:00:00Z
author: lead session (post-v0.14.0 release)
supersedes: 20260707T123000Z-wave-plan-stable-infra-plus-features.md
status: active
goal: complete all buildable triaged FEATs ASAP via max-parallel worktree waves, one-owner-per-file
---

# Wave plan — 2026-07-10 (drain triaged, post-v0.14.0)

Baseline: origin/main `fcefb73`, v0.14.0 shipped. 20 triaged + 4 pending FEATs.
Governing rule (unchanged): no two concurrent agents touch the same file. Pack
disjoint-file FEATs into parallel sibling worktrees; serialize within a file
cluster. `autonomous_safe:false` items still build autonomously but get a human
merge checkpoint per constitution (production/unsafe surface).

## Scope filter — what this repo can build

**OUT (cross-repo, cannot build here — route to their repos):**
- FEAT-446 — astramem-sdk growth → **memory (SaaS) repo**
- FEAT-460 — cloud-native retrieval presets → **SaaS repo**

**Needs triage before dispatch (pending, unscored):** FEAT-468, 471, 472, 473
→ run `/runner:triage` first; they slot into the clusters below.

**Human-gated (cannot fully autonomous-complete):**
- FEAT-458 — depends_on 467 + 455 + a 14-day bake (**gate 2026-07-24**)
- FEAT-457 AC-6 — human LoCoMo scored run (your terminal + Azure key)
- FEAT-450 — human `az login` + extraction bench

## Collision clusters (drive packing)

| cluster | files | FEATs (serialize within) |
|---|---|---|
| **R redaction** | `src/redact/entropy.ts` | 470 → 468 → 473 |
| **K keystore** | `src/storage/keystore.ts` | 470 → 472 |
| **S search** | `src/search/search.ts`, `fuse.ts` | 429 → 453 ; 428 (tests, after) |
| **M migrate/shim** | `src/storage/migrate.ts`, `src/service/shim.ts` | 439 → 440 |
| **C consolidation** | `src/consolidate/consolidate.ts`, `src/server/routes/consolidation.ts` | 442 ∥ 437 (diff files, watch) |
| **E eval** | `scripts/eval/shared/*` | 462 ✅done · 457 (AC-6 human) · 458 (gated) |
| disjoint | see each | 467, 448, 443, 464, 422, 447, 445, 471 |

Note: FEAT-470 owns BOTH entropy.ts (R) and keystore.ts (K) → it is the head of
two chains; must merge before 468/473/472 start.

## WAVE 1 — ready now (max parallel, all disjoint file surfaces)

| worktree | FEAT | P | safe | owns (blocks) | notes |
|---|---|---|---|---|---|
| w467-capture | **FEAT-467** | P2 | no | capture.ts, memory-events.ts | invalidate() audit gap — **unblocks 458**. Highest leverage. |
| w439-migrate | **FEAT-439** | P1 | yes | migrate.ts (→440) | post-merge build+reinstall + schema-drift probe |
| w470-redact | **FEAT-470** | P2 | yes | entropy.ts (→468,473), keystore.ts (→472), writer.ts | 5 stabilization quick-wins; head of R+K chains |
| w448-durability | **FEAT-448** | P2 | yes | distill/durability-gate.ts | tighten RATIONALE_MARKER_RE; unblocks 441 default-on |
| w429-search | **FEAT-429** | P2* | no | search.ts, fuse.ts (→453,428) | *needs PM re-score (currently `needs-review`) — triage FIRST |
| w443-unix | **FEAT-443** | P2 | no | service/install-flow.ts | unix service parity (pointer/rollback port) |

Parallel-safe: 6 worktrees, zero shared files. Dispatch in one block.

## WAVE 2 — after Wave-1 cluster owners merge

| FEAT | P | after | owns/next |
|---|---|---|---|
| **FEAT-440** | P1 | 439 (migrate.ts) | shim exit-history + crash-loop doctor alert |
| **FEAT-453** | P2 | 429 (search.ts) | fact-level bitemporal validity |
| **FEAT-468** | P? | 470 (entropy) + triage | digit-only secret redaction (entropy floor) |
| **FEAT-472** | P? | 470 (keystore) + triage | sync-token → scoped keystore identity |
| **FEAT-437** | P2 | — (∥ 442) | consolidation auto-accept policy |
| **FEAT-442** | P2 | — (∥ 437) | auto-accept merge-as-supersede |
| **FEAT-428** | P2 | 429/453 settle | fusion component-ceiling governance |

## WAVE 3 — after Wave-2 / prereqs

| FEAT | gate |
|---|---|
| **FEAT-473** | after 468 (entropy chain) + triage — unicode smart-quote labels |
| **FEAT-471** | triage — suite flake fix (post-merge-rebuild + release tests) |
| **FEAT-464** | **SOLO wave** — TS7 + @types/node 26 migration, touches many test files globally; isolate, no parallel |
| **FEAT-458** | after 467 merged + 455 + **14-day bake (2026-07-24)** — proxy-bench |

## STANDALONE — dispatch anytime (no collisions, dev-lite candidates)

- **FEAT-422** — loop-internals doc drift (docs only)
- **FEAT-447** — Supermemory one-step-install investigation (research, read-only)
- **FEAT-445** — single-binary `bun build --compile` spike (timeboxed 1 day)

## Human checkpoints (constitution — unsafe/prod surface)

Merge-gate (build autonomously, pause for your OK before merge): 467, 440, 453,
437, 442, 443, 429, 464, 458. Safe auto-merge: 439, 470, 448, 457, 422, 447.

## Execution cadence (per slice)

`/runner:slice start` → builder → reviewer → verifier (if behavior) →
`/runner:slice complete` + grade → merge PASS worktree in priority order.
Never push from inside a wave. `crew fleet --repo "$PWD"` for one-glance status.

## Completion math

- **Fully autonomous now:** 439, 470, 448 (+422/447/445 standalone) → Wave 1 safe set.
- **Autonomous build, human merge:** 467, 443, 429, 440, 453, 437, 442, 428, 464.
- **Blocked on humans/time:** 457 (AC-6), 458 (bake 07-24), 450 (az login).
- **Route elsewhere:** 446, 460 (other repos).
- **Triage-first:** 468, 471, 472, 473.

ETA: Wave 1 (6 slices) ≈ one focused session at the 462b cadence. Waves 2+3 ≈
2–3 more sessions. Hard floor: FEAT-458 cannot close before **2026-07-24**.

## Open operator decisions

1. Launch Wave 1 now (6 worktrees), or safe-only subset (439/470/448)?
2. Triage the 4 pending (468/471/472/473) before or during Wave 1?
3. FEAT-429 — PM re-score first, or drop (stale `needs-review`)?
4. Confirm 446/460 route to SaaS/memory repos (out of this backlog).
