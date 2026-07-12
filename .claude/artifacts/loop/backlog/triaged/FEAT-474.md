---
id: FEAT-474
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-07-12
updated: 2026-07-12
depends_on: []
slices: []
derived_from: "docs/research/20260712-feat447-supermemory-install-ux.md (FEAT-447 investigation, Q4 install.sh UX copy-list)"
cross_product: [astramem-local]
autonomous_safe: false
tags: ["concern:onboarding", "surface:install", "surface:cli", "stack:shell", "followup:FEAT-447"]
pm_customer_impact: 0.3
pm_effort_estimate: 0.6
pm_strategic_alignment: 0.4
pm_technical_risk: 0.45
pm_dependency_depth: 0.2
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-12
triage_notes: "P2 via formula: impact 0.30 < 0.70 and alignment 0.40 < 0.80, so neither P1 branch fires; effort 0.60 < 0.70 so the P3 branch (effort>=0.70 AND impact<=0.30) does not fire either despite impact qualifying — lands P2 by the formula's default branch. composite_score=0.105+0.12+0.08+0.055+0.04=0.40. technical_risk banded at 0.45 (mid 0.3-0.5 band: 'new pattern in repo... no contract change, clean rollback') — a new install.sh/install.ps1 wrapper is a new pattern for this repo and touches multiple files (wizard + 2 new scripts + release-CI manifest publish step), but there is no schema/runtime contract change and every sub-pattern is independently, cleanly revertible via git revert. pm_effort_points=8 (band [0.6,0.85) per this repo's established PM convention, confirmed against FEAT-443/446's own stated bands) — this TRIPS the FEAT-168 decomposition gate. I am supplying proposed_slices below (option 1) rather than needs-review, since the 9-pattern checklist decomposes cleanly along wizard-vs-wrapper-vs-release-pipeline boundaries with no cross-repo or unclear-scope blocker. autonomous_safe=false: forced both by the missing-AC/vague-scope finding above and by not having drafted ACs (P2, no --deep/--spec flag passed)."
proposed_slices:
  - id_suffix: -SLICE-1
    title: "Init wizard hygiene: env-var prefill, non-interactive flags, PATH guidance"
    points: 5
  - id_suffix: -SLICE-2
    title: "install.sh/install.ps1 wrapper: idempotent skip-check, tty reattach, sudo handling"
    points: 5
  - id_suffix: -SLICE-3
    title: "Release pipeline: checksum manifest + version-resolution strategy"
    points: 3
---
## Description

**Port Supermemory's `install.sh` UX patterns onto our own installer** —
FEAT-447's investigation into Supermemory's "one binary" claim was mostly a
runtime/packaging finding (their single binary works because Bun's built-in
`bun:sqlite` sidesteps the native-addon `dlopen` wall FEAT-445 hit, at the
cost of giving up SQLCipher-style native at-rest encryption — not applicable
to us). Independent of that finding, the investigation fetched their
`install.sh` verbatim (333 lines, `supermemoryai/supermemory` release asset)
and found several installer-hygiene patterns that are cheap to copy and have
nothing to do with the single-binary question.

**Constraint carried forward from FEAT-445 (defer verdict, still stands):**
we are NOT adopting a `bun build --compile` single binary. npm remains the
install vehicle (`npm i -g astramem-local`); this FEAT is about UX polish
around that vehicle — a thin `install.sh`/`install.ps1` wrapper and/or
improvements to the existing `init` wizard — not a packaging change.

### Scope

Map the following patterns (full detail + adopt/skip rationale in the source
research doc's Q4 table) onto our `init` wizard and a future
`install.sh`/`install.ps1`:

- **Checksum manifest**: publish a `manifest.json` (or equivalent) alongside
  npm releases; verify before trusting any downloaded artifact.
- **Idempotent skip-if-current-version**: compare an installed-version marker
  before reinstalling; `FORCE=1`-style override. (Note: `reinstall` already
  has related idempotency/version-parity logic per CLAUDE.md — check for
  overlap/reuse before adding a parallel mechanism.)
- **`/dev/tty` re-attach** so interactive prompts still work when the
  install script itself is the piped stdin (`curl \| bash` pattern).
- **Env-var prefill** to silently skip a prompt when the value is already
  exported — maps to our `MEMORY_BEARER` / Ollama-model prompts in `init`.
- **Non-interactive escape hatches** (their `SUPERMEMORY_NO_PROMPT` /
  `_NO_START` / `_FORCE`) — we should have an equivalent
  `ASTRAMEM_INSTALL_NO_PROMPT`-style set for CI use of our own installer.
- **PATH guidance**: detect when the install target isn't on PATH and print
  a copy-pasteable shell-rc line (same problem class as our npm-global-bin
  PATH friction).
- **Secure file perms**: `chmod 600` on secrets/env files, restrictive perms
  on install dirs — codify in the installer itself rather than relying on
  convention (we already treat `secrets.env` as sensitive; this makes it
  enforced, not just documented).
- **Root/sudo handling**: detect `sudo`, `chown` installed files back to the
  invoking user, refuse to auto-start as root — relevant once/if we support
  a `curl \| sudo bash`-style Linux install path.
- **Version-resolution strategy**: prefer a `/releases/latest` redirect over
  hitting the GitHub API directly (avoids rate-limiting install bursts),
  falling back to the REST API with a `jq`-optional parse.

### Non-goals

- No single-binary / `bun build --compile` work — FEAT-445's defer verdict
  stands, reinforced by FEAT-447's finding that the one shipping
  single-binary counter-example (Supermemory) achieves it by giving up
  native at-rest encryption, which is not an acceptable trade for us.
- macOS ad-hoc `codesign` repair — only relevant to a compiled binary
  artifact we don't ship; skip.
- Windows install path is out of scope for the install.sh-specific patterns
  above (Supermemory itself ships no Windows asset); our existing
  `schtasks`/`reinstall` Windows service flow is unaffected and unrelated.

## Proposed slices (PM decomposition)

- SLICE-1: Init wizard hygiene: env-var prefill, non-interactive flags, PATH guidance (5 pts)
- SLICE-2: install.sh/install.ps1 wrapper: idempotent skip-check, tty reattach, sudo handling (5 pts)
- SLICE-3: Release pipeline: checksum manifest + version-resolution strategy (3 pts)
