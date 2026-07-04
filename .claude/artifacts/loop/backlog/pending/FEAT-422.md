---
id: FEAT-422
status: pending
priority: null
category: null
target_release: null
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: null
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
