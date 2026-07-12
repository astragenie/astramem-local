---
id: FEAT-474
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-12
updated: 2026-07-12
depends_on: []
slices: []
derived_from: docs/research/20260712-feat447-supermemory-install-ux.md (FEAT-447 investigation, Q4 install.sh UX copy-list)
cross_product: [astramem-local]
autonomous_safe: null
tags: ["concern:onboarding", "surface:install", "surface:cli", "stack:shell", "followup:FEAT-447"]
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
