---
title: Wave execution plan — stable-infra spine + feature waves
created: 2026-07-07T12:30:00Z
author: lead session 470adaf7 (2026-07-07)
supersedes_scoring_for: [FEAT-429]
status: active
---

# Wave plan — 2026-07-07

Governing rule: no two concurrent agents touch the same file (one-owner). Work
splits into ONE serial lane (shared infra files) + PARALLEL worktree waves.

## Collision clusters (drives packing)

- `src/service/shim.ts` + `src/cli/reinstall.ts` + `current.json` + doctor probes
  → FEAT-438 (all slices) · FEAT-439 · FEAT-440 → **serial (Lane A)**
- `src/server/routes/search.ts` → FEAT-429 (filter surface) · FEAT-441 (/remember)
  → **serialize 429 before 441**
- `src/config/config.ts` → FEAT-425 (deriveProject) · FEAT-441 (gate flag) → watch
- `src/search/*` → FEAT-428 (DONE, PR #104) · FEAT-429 → no live conflict (428 merged)
- disjoint: U5-local `contracts/` · FEAT-425 `src/config` · FEAT-437 `src/consolidate`

## LANE A — stable-infra spine (main checkout, SERIAL)

Today's outage cluster. Serial because they share shim/reinstall/doctor.

| step | item | state | note |
|------|------|-------|------|
| A1 | SLICE-416 release materialization | ✅ CLOSED | review PASS + validation PASS |
| A2 | FEAT-438 SLICE-417 pointer repoint + served-version assert | NEXT | **gate: re-verify or drop idempotent-reuse trust (`release.ts:226-234`) BEFORE repoint** (MEDIUM from 416 review) |
| A3 | FEAT-438 SLICE-418 retention / rollback / --dev | after A2 | add %TEMP%-root guard note (416 LOW) |
| A4 | FEAT-439 post-merge build+reinstall + doctor schema-drift probe | after A3 | P1 0.71 safe; directly prevents the 8h outage recurrence |
| A5 | FEAT-440 crash-loop visibility (shim exit history + stderr + doctor alert) | after A4 | P1 0.72 unsafe; shares shim+doctor |

Landing A1→A5 closes the entire "2026-07-07 stale-dist outage" class (438+439+440).

## LANE B — feature waves (sibling WORKTREES, PARALLEL with Lane A)

### Wave B1 — ready now
| worktree | item | notes |
|----------|------|-------|
| `feat/u5-mcp-manifest` | **U5-local SLICE-A** | additive: `contracts/manifests/mcp-tools.v1.json` + `tests/contracts/mcp-tool-manifest-parity.test.ts`. NO rename, NO cloud gate. **Also add contracts publish-parity CI** (registry-stale hazard found today). Isolated to `contracts/` + `tests/contracts/`. |
| `feat/425-project-identity` | **FEAT-425** | P2 safe; deriveProject cwd/repo precedence bug. `src/config`. |
| `feat/429-repo-since-filters` | **FEAT-429 (re-scoped)** | registry ALREADY built (PR #105). Only `repo`+`since` filters left = trivial SLICE-A/B. **Stale 8-pt/needs-review score must be PM-corrected first.** |

### Wave B2 — after B1 merges
| worktree | item | notes |
|----------|------|-------|
| `feat/441-distill-gate` | **FEAT-441** | P1, autonomous_safe:false (human sign-off before gate ≠ off). Build behind default-off. Conflicts w/ 429 on `search.ts` → after B1. 2 write call-sites (distill 07-memory-normalize + search.ts:207), not one. |
| `feat/437-consolidation-policy` | **FEAT-437** | P2 unsafe; auto-accept threshold + digest. Pairs with 441 (441 shrinks its inflow — land 441 first/alongside). |
| `feat/414-shared-constants` | **FEAT-414** | P2 safe, trivial — candidate for dev-lite inline anytime. |

### Wave B3 — coordinated / later
| item | gate |
|------|------|
| **U5-local SLICE-B** (rename session_digest/memory_history/remember) | cross-repo lockstep w/ cloud #671 + plugin; D2 clean-rename (no alias) |
| **U5-local SLICE-C** | optional: collapse the triplicated 15-tool hardcoded list |

## Prep status (all done this session)
- U5 design ✅ → `20260707T121423Z-plan-U5-local-mcp-tool-name-manifest.md`
- FEAT-429 design ✅ → `20260707T121447Z-design-FEAT-429-filter-registry.md` (found it's half-built)
- FEAT-441 PM score ✅ → `20260707T180000Z-pm-review-feat-441.md` (P1, unsafe, 6 ACs)
- Contracts gate ✅ CLEARED — `@astragenie/astramem-contracts@1.1.0` published 22:46Z carries the canonical 10-value type union + private scope. Consumers can land final consume.

## Open operator decisions
1. Auto-launch Wave B1 worktrees now (parallel with Lane A A2), or hold?
2. FEAT-429 — PM re-score first (stale), or dispatch the trivial repo+since slices directly on the design note?
3. Cadence: each slice builder → reviewer → verifier(if behavior) → runner:close; merge PASS worktrees priority-order; no push from inside a wave.
