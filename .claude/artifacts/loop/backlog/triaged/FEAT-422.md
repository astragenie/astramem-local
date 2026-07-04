---
id: FEAT-422
status: triaged
priority: P3
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: loop-internals-validation-2026-07-04
pm_customer_impact: 0.15
pm_effort_estimate: 0.20
pm_strategic_alignment: 0.30
pm_technical_risk: 0.35
pm_dependency_depth: 0.45
pm_effort_points: 2
composite_score: 0.41
composite_priority: P3
autonomous_safe: false
pm_demand_evidence: "Loop-internals validation (2026-07-04, pre-Wave-5 start) found `/runner:stop-check` still named in rules.md's auto-mode gating table despite being removed in runner v0.53 (installed runner is 0.58.0 — live check confirms the command is gone). 'First Action' also points at approved-slices.md, vestigial since the FEAT-based backlog flow replaced it — it still reads 'No approved slices yet' after 6+ completed slices."
pm_scope_notes: "In-repo actionable scope is narrow: re-run `/runner:install --repo .` and diff the regenerated rules.md against the current one to determine whether the drift is a stale local install (fixable here) or an upstream template bug (fixable only in the astra/runner plugin repo — out of scope for this repo; file/coordinate there rather than hand-editing the plugin-managed file to route around it). Whichever path is taken, the two 2026-07-04 local HARD RULE additions — shared-stash protocol and no-`git add -A`-preflight, both under 'Worktree Parallelism' — MUST survive. If `/runner:install` would overwrite them, move them into CLAUDE.md before regenerating rather than letting an autonomous pass regenerate blind and silently drop them. Separately, decide approved-slices.md's fate (retire from 'First Action' vs. wire `slice from-feature` to append to it) — that's a design choice, not a mechanical doc fix."
pm_risks:
  - "Cross-repo root cause: if the astra/runner plugin template itself carries the stale references, the durable fix requires a change and version bump in that separate repo, which cannot be made or verified from this repo alone."
  - "Blind /runner:install re-run risk: could silently overwrite the two locally-added HARD RULEs that exist specifically because they already prevented (after first causing) cross-worktree damage — FEAT-410 wave 2 stash/add-A incidents. Regressing them reintroduces a known failure mode, not a hypothetical one."
  - "approved-slices.md disposition is a real design decision (retire vs. wire up) — picking the wrong one either leaves 'First Action' stranded again or adds ceremony overhead to every slice going forward."
reasoning: "Zero direct product/customer impact — this is loop-tooling documentation drift, not a change to astramemory-local's shipped behavior, so pm_customer_impact is low. There is a real recurring efficiency cost (every fresh loop session reads rules.md first per HARD RULE; the stale /runner:stop-check reference and vestigial approved-slices.md pointer burn tokens and could stall a naive agent hunting for a removed command), which is reflected in strategic_alignment and technical_risk rather than customer_impact. Effort would be small if this were purely a local doc fix, but the credible root cause is an upstream plugin template issue (astra/runner), and the local reconciliation path carries genuine risk of clobbering two safety-critical HARD RULE additions added after an actual incident (FEAT-410 wave 2). autonomous_safe=false for the same class of reason as FEAT-411/FEAT-415: cross-repo coordination plus a real risk of silently regressing already-hard-won safety rules makes this unsuitable for a blind autonomous pass. A human, or at minimum a careful diff-and-confirm step, should own reconciling regenerated vs. local content before this closes. P3: real but low-stakes hygiene work with no confirmed incident yet and a cross-repo dependency that bounds how much can be done here."
---

# FEAT-422: Loop-internals doc drift — rules.md references removed/vestigial surfaces

## Problem

Loop-internals validation (2026-07-04, pre-Wave-5 start) found `.claude/loop/rules.md`
(plugin-managed by `/runner:install`, "do not edit by hand") referencing surfaces that no
longer exist or no longer match the real flow:

1. **`/runner:stop-check` removed in runner v0.53** — rules.md still names it in the
   auto-mode gating table and wave-mode docs. Live check:
   `bun .../loop.mts stop-check` → "runner:stop-check removed in v0.53. Use
   internal-only (runner:auto) instead." Installed runner is 0.58.0, so `/runner:install`
   either wasn't re-run after upgrade or the 0.58.0 template itself still carries the
   stale reference (verify which before fixing).
2. **"First Action" sequence points at `approved-slices.md`**, which is vestigial — it
   still reads "No approved slices yet" after 6+ completed slices. The real flow is
   `backlog/pending/ → triage → backlog/triaged/ → /runner:slice from-feature`.
   Either the template should describe the FEAT-based flow, or approved-slices.md should
   be maintained by the ceremony.

Cost of drift: every fresh loop session reads rules.md first (HARD RULE) and burns
tokens reconciling instructions against reality; a naive agent could stall hunting for
a removed command.

## Proposed fix

- Re-run `/runner:install --repo .` and diff the regenerated rules.md; if stale refs
  persist, patch the runner plugin template upstream (astra/runner) and bump.
- Decide approved-slices.md fate: retire from "First Action" list (preferred) or wire
  `slice from-feature` to append to it.
- Keep the two repo-specific HARD RULE additions (shared-stash protocol, no `git add -A`
  preflight) — they were appended locally on 2026-07-04 and must survive regeneration;
  if `/runner:install` overwrites them, move them to CLAUDE.md instead.

## Evidence

- `bun loop.mts doctor --check` — clean after FEAT-407 frontmatter fixup (comment inside
  `depends_on` YAML value; fixed inline 2026-07-04).
- Runner plugin cache versions present: 0.51.0–0.58.0.

## Done when

- rules.md contains no references to removed commands (`stop-check`) or dead files as
  mandatory reading.
- Local HARD RULE additions preserved post-regeneration.
- `loop.mts doctor --check` stays clean.
