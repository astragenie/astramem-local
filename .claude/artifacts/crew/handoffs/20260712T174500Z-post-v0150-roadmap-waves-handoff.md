---
type: handoff
created: 2026-07-12T17:45:00Z
author: lead (release session 2026-07-12)
objective: Complete the post-v0.15.0 astramem-local roadmap (FEAT-475, 474, 464, 453, 458) in waves, culminating in v0.16.0 and v0.17.0
status: ready-for-pickup
---

# Handoff — post-v0.15.0 roadmap, wave plan

## Objective

Drive the five remaining astramem-local backlog items to done across four
waves, cutting **v0.16.0** (hygiene) after Waves A–B and **v0.17.0**
(auto-capture proxy headline) after Wave D. FEAT-460 and FEAT-446 are
explicitly OUT (sibling repos — astramem-cloud / memory).

## Owner

Autonomous loop (wave mode, `/runner:wave plan` → `run`). Operator input
required at two marked decision points only.

## Context snapshot (2026-07-12)

- v0.15.0 published to npm, tag-parity + publish CI green, main == origin/main at `182777d`.
- FEAT-473 shipped in v0.15.0 but its backlog file still sits in `triaged/` — housekeeping: move through the normal close path first (do NOT re-implement; verify `ANY_QUOTE_CHAR` in `src/redact/detectors.ts` as the already-landed signature).
- FEAT-458 S2 core exists on `feat/feat-458-s2-proxy-core` (origin backup + w458s2 worktree), review verdict `incomplete_wip` — see `.claude/artifacts/crew/reviews/20260712T-review-result-feat-458-s2.md`. Bake gate satisfied **2026-07-24T17:25Z** (`.claude/artifacts/crew/deployments/20260710T172500Z-feat458-bake-clock-start.md`).
- Review-Before-Merge Sequencing HARD RULE now in `.claude/loop/rules.md` — review artifact must exist on disk BEFORE merge/close. Applies to every wave below.

## Wave plan

### Wave 0 — triage (prerequisite, ~30 min)
Run `/runner:triage` to score FEAT-474 + FEAT-475 (both `pending`, unscored).
Also move stale FEAT-473 to done. No code.

### Wave A — parallel hygiene (start immediately, ~1–2 days)
Two independent worktrees, zero file overlap:

| Slot | FEAT | Scope | Files |
|---|---|---|---|
| A1 | FEAT-475 | Eval detach/manifest flake fix — widen timeout budgets / serialize spawn-heavy tests, FEAT-471 pattern | `scripts/eval/longmemeval/detach-kill-resume.test.ts`, `scripts/eval/shared/daemon-manifest.test.ts` ONLY |
| A2 | FEAT-474 | Installer UX hygiene port (Supermemory install.sh patterns per `docs/research/20260712-feat447-supermemory-install-ux.md`) | installer/CLI onboarding surface; no daemon runtime |

Evidence bar A1: 5x green under artificial parallel load (same bar FEAT-471 used).

### Wave B — solo toolchain + gated pre-work (~2–5 days)

| Slot | FEAT | Scope | Constraint |
|---|---|---|---|
| B1 | FEAT-464 | TS toolchain majors: ~105 test-side type fixes, bun.lock regen, 4-leg CI verify | **SOLO on the shared surface** — tsconfig/bun.lock churn conflicts with any sibling touching tests. ⚠️ OPERATOR DECISION FIRST: TS7+@types/node 26 vs pin @types/node 20.x |
| B2 | FEAT-458 S1 close | Bench harness skeleton `scripts/eval/proxy-bench/` (S1-AC-3), doctor WARN row (S1-AC-2), disable→purge parity, design-gate completion artifact (S1-AC-4) | New files only — safe parallel with B1. This is design/harness work, NOT capture implementation, so it does not violate the bake gate |

B2 unblocks S2-AC-4 (p50 <10ms evidence), the structurally-unmeetable AC from the review.

### Wave C — bitemporal facts (~1–2 weeks, overlaps B)

FEAT-453 fact-level `valid_at`/`invalid_at`. `needs_contract` — ladder:
1. `/crew:architect-feature` → contracts artifact (migration 022 design; additive/nullable, mirrors cloud EF migration).
2. SLICE-1 contract + migration design (already proposed in FEAT frontmatter).
3. Implementation slices per decomposition.
Cross-product coordination with memory repo (sibling paths in memory: `sibling-repos`) — flag cloud-mirror slice as cross-repo, not autonomous.

**→ Release checkpoint: cut v0.16.0** once A1+A2 (+B1 if landed) are merged. Runbook `docs/runbooks/release-publish.md`. NOTE: tag push auto-publishes via CI — do NOT run manual `npm publish` after (2026-07-12 lesson: manual publish collides with CI's).

### Wave D — proxy resume (NOT BEFORE 2026-07-24T17:25Z)

FEAT-458 S2 resume:
1. Verify bake artifact satisfied + ≥1 real scrub-evidence instance (gate has TWO conditions).
2. Rebase `feat/feat-458-s2-proxy-core` onto main (merge main in, don't discard — core reviewed good: byte-transparency, pre-bind loopback refusal, zero-capture import graph all PASS).
3. Produce S2-AC-4 latency evidence with the B2 bench harness (p50 <10ms).
4. **Fresh full review** — today's review does not cover the post-resume diff.
5. Merge, then S3/S4 capture slices per FEAT-458 body.

**→ Release checkpoint: cut v0.17.0** (headline: LLM proxy auto-capture) once 458 slices land, ~Jul 26–30.

## Allowed scope
- All five FEATs above within their file boundaries; wave ceremony (`/runner:slice start/complete`, review artifacts BEFORE merge, grades).
- v0.16.0 / v0.17.0 version bumps + tags per bump discipline (package.json == tag, same commit).

## Forbidden scope
- FEAT-460 / FEAT-446 (sibling repos).
- Any FEAT-458 capture-path implementation before 2026-07-24 gate.
- Manual `npm publish` after a tag push (CI publishes; collision).
- `git stash` in worktrees; image-name process kills; merging `origin/<branch>` instead of local tip (see CLAUDE.md Do-NOT + memory).

## Deliverable
Merged + released v0.16.0 and v0.17.0; all five FEATs in `done/`; review/validation/grade artifact chain per slice.

## Confidence
High for Waves 0/A/B (bounded, patterns established). Medium for C (cross-product schema) and D (gate has an evidence condition — ≥1 real scrub instance — that time alone doesn't satisfy; if no scrub evidence exists by 7/24, D blocks and must escalate, not proceed).

## Risks / open questions
- FEAT-464 operator decision (TS7 vs pin) — if unanswered, Wave B runs B2 only and 464 slips past v0.16.0 (acceptable).
- FEAT-453 cloud-mirror half may stall on memory-repo bandwidth; local half is shippable alone (additive nullable columns).
- Rerank timeout flake (`tests/search/rerank.test.ts`, seen on PR #157) is NOT in FEAT-475's file list — if it recurs, widen FEAT-475 scope rather than filing a third flake FEAT.
- w458s2 worktree preserved; if disk state is lost, branch is on origin.

## Suggested next handoff
Wave 0 + Wave A dispatch by the autonomous loop: `/runner:triage`, then `/runner:wave plan` packing A1+A2.
