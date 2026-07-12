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
autonomous_safe: true
tags: ["concern:onboarding", "surface:install", "surface:cli", "stack:shell", "followup:FEAT-447"]
pm_customer_impact: 0.3
pm_effort_estimate: 0.4
pm_strategic_alignment: 0.4
pm_technical_risk: 0.35
pm_dependency_depth: 0.2
pm_composite_priority: P2
pm_autonomous_safe: true
pm_reviewed: 2026-07-12
triage_notes: "RESCOPED 2026-07-12 (second pass, this file). The original 2026-07-12 review (composite 0.40, effort 0.60/8pts, autonomous_safe=false) assumed install.sh/install.ps1 did not exist yet and that init's env-var prefill / non-interactive support was greenfield. Both assumptions were wrong: install.sh and install.ps1 already exist at repo root (Node-version check, npm install -g, non-interactive detection via `[ -t 0 ]` / `[Console]::IsInputRedirected`), and src/cli/init.ts already has a complete env-var-driven non-interactive mode (ASTRA_MEMORY_INIT_NONINTERACTIVE=1 + a full NON_INTERACTIVE_ENV map covering every prompt, init.ts:39-58,116-118) plus secrets.env at mode 0600 (init.ts:10,763-785). That closes 4 of the original 9 patterns outright (env-var prefill, non-interactive escape hatches, secure file perms for the one file that matters, and — separately — checksum-manifest/version-resolution are N/A because we install via the npm registry, which already does its own tarball integrity verification and version resolution, unlike Supermemory's raw-GitHub-release-binary model that install.sh was copied from). Real remaining scope is bounded to install.sh only (install.ps1/Windows is already a non-goal per this FEAT's own scope note): idempotent skip-if-already-current + FORCE override, /dev/tty reattach so `curl | bash` can still prompt interactively instead of bailing out, root/sudo chown-back + refuse-auto-start-as-root, and a PATH-guidance copy-paste line. That's roughly 6 points across 2 independently shippable slices, not 8 across 3 — recomputed: customer_impact unchanged at 0.30 (still no direct user complaint, still class-level PATH-friction analogy), effort_estimate now 0.40 (was 0.60 — real remaining diff is one shell script plus a small doctor/config-dir perm check, not 2 new scripts + a release-CI step), technical_risk now 0.35 (was 0.45 — 'new pattern' risk mostly retired now that the pattern already exists and is being extended, not invented; still shell-script-only, no contract change, clean git-revert rollback). composite_score=0.105+0.06+0.08+0.0525+0.04=0.3375, still P2 (impact/alignment thresholds unchanged, effort now well under the P3 branch's 0.70 floor too). pm_effort_points now 5 (band [0.4,0.6) at this repo's convention) — UNDER the FEAT-168 decomposition gate (8), but I kept the 2-slice split anyway since the two remaining patterns (idempotency+tty vs root/perm/PATH) are cleanly independent and there's no reason to force one builder to do both in one pass. autonomous_safe flipped to true: concrete Given-When-Then ACs now exist below (closing the original vague-scope objection), scope is bounded to one known file (install.sh) plus a narrow config-dir perm check, no schema/runtime contract change, every change independently git-revertible, and the decomposition gate no longer even trips. Residual judgment note for a human/builder, not a blocker: introducing root/sudo handling is a product-shape decision (do we want to implicitly bless a `curl | sudo bash` flow we don't currently document?) — AC6/AC7 below scope this narrowly (defensive chown-back + refuse-auto-start-as-root only, not a new documented install path) precisely so it doesn't require a policy call to implement safely."
proposed_slices:
  - id_suffix: -SLICE-1
    title: "install.sh: idempotent skip-if-current-version (FORCE override) + /dev/tty interactive reattach"
    points: 3
  - id_suffix: -SLICE-2
    title: "install.sh: root/sudo handling + PATH guidance + config-dir perm hardening"
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

### Scope — as originally proposed (superseded by the rescoped table below)

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

### Rescoped 2026-07-12 — what's already done vs. what's actually left

Re-checked every pattern against the current repo state (`install.sh`,
`install.ps1`, and `src/cli/init.ts` all already exist — the original body
above assumed some of this was greenfield). Verdict per pattern:

| Pattern | Status | Evidence |
|---|---|---|
| Checksum manifest | **N/A — drop** | We install via `npm install -g astramem-local` (npm registry), not a raw GitHub-release binary download. The npm registry already verifies tarball integrity (registry-published shasum/integrity hash) before `npm` extracts anything. Supermemory needs a manifest because they self-host unsigned binaries on GitHub Releases; we don't have that exposure. |
| Idempotent skip-if-current-version | **Real gap — SLICE-1** | `install.sh` always runs `npm install -g astramem-local` unconditionally (install.sh:57-58). No pre-check against the currently-installed version, no `FORCE=1` override. (`reinstall.ts`'s served-version-vs-build assertion at reinstall.ts:289,495 is a different mechanism — service-materialization currency, not "should the npm package be reinstalled at all" — not reusable here, but confirms the naming convention (`FORCE`-style env var) to stay consistent with.) |
| `/dev/tty` re-attach | **Real gap — SLICE-1** | `install.sh:72-82` currently detects non-tty stdin and *bails out* with a "run `astramem-local init` yourself" message rather than re-attaching `/dev/tty` and continuing interactively. Functionally safe today, but strictly worse UX than Supermemory's pattern for the `curl \| bash` case. |
| Env-var prefill for individual prompts | **Already done — verify only, no slice** | `src/cli/init.ts:39-58` (`NON_INTERACTIVE_ENV` map) + `init.ts:116-118` (`isNonInteractive()`) already let every prompt (vector, embed/llm provider, dataDir, port, budget, installService, installHook, Ollama model/base URL) be pre-supplied via `ASTRA_MEMORY_INIT_*` env vars. |
| Non-interactive escape hatches | **Already done — verify only, no slice** | Same mechanism as above: `ASTRA_MEMORY_INIT_NONINTERACTIVE=1` is the escape hatch, and it already flows through `install.sh`'s `exec astramem-local init "$@"` (env is inherited by the exec'd process with no extra plumbing needed). |
| PATH guidance | **Partial gap — SLICE-2** | Both scripts already detect "not on PATH" and error out (install.sh:60-64, install.ps1:66-71), but only print a generic hint (`npm config get prefix`), not a copy-pasteable shell-rc `export PATH=...` / profile line. |
| Secure file perms | **Mostly done — narrow gap in SLICE-2** | `secrets.env` is already written at mode 0600 unconditionally (`init.ts:10,763-785`). Remaining gap is narrower than the original bullet implied: the *containing config directory* (`defaultConfigDir()`) itself has no explicit restrictive-perm enforcement, only the file inside it. |
| Root/sudo handling | **Real gap — SLICE-2** | Not present anywhere in `install.sh` today: no root detection, no chown-back-to-`$SUDO_USER`, no refuse-to-auto-start-as-root guard. |
| Version-resolution strategy (`/releases/latest` vs GitHub REST API) | **N/A — drop** | This pattern exists to dodge GitHub API rate-limiting when resolving a release tag. We never call the GitHub API for version resolution — `npm install -g astramem-local` resolves via the npm registry's own `dist-tags/latest`, which isn't the resource this pattern protects. |

Net: 4 of 9 original patterns are already satisfied or not applicable; the
remaining 5 collapse into 2 shippable slices below (~6 points, not the
original 3-slice/13-point estimate).

### Non-goals

- No single-binary / `bun build --compile` work — FEAT-445's defer verdict
  stands, reinforced by FEAT-447's finding that the one shipping
  single-binary counter-example (Supermemory) achieves it by giving up
  native at-rest encryption, which is not an acceptable trade for us.
- macOS ad-hoc `codesign` repair — only relevant to a compiled binary
  artifact we don't ship; skip.
- Windows install path (`install.ps1`) is out of scope for both slices below
  (Supermemory itself ships no Windows asset, and neither `/dev/tty`
  reattach nor sudo/root handling is a concept that transfers to
  PowerShell); our existing `schtasks`/`reinstall` Windows service flow is
  unaffected and unrelated. `install.ps1`'s existing PATH-guidance message
  may optionally be brought to parity with SLICE-2's copy-paste line as a
  cheap bonus, but that is not required for either slice's AC to pass.
- No changes to `src/cli/init.ts`'s non-interactive env-var mechanism or to
  `secrets.env`'s permission handling — both already meet the bar (see
  rescoped table above); a slice that "fixes" either without new evidence of
  a real gap is out of scope.
- No release-CI / npm-publish changes (checksum manifest, version-resolution
  strategy) — dropped as not applicable to an npm-registry-based install
  (see rescoped table above).

## Acceptance criteria

### SLICE-1 — idempotent skip-if-current-version + `/dev/tty` reattach

- **AC-1 — Skip reinstall when already current.**
  Given `astramem-local` is already installed globally at the version that
  `npm view astramem-local version` currently resolves to,
  When `install.sh` is run again with no `FORCE` env var set,
  Then it does not re-run `npm install -g astramem-local`, prints a message
  stating the currently-installed version is already current, and still
  proceeds to the existing init-wizard step (steps 4 onward are unaffected —
  only the reinstall step is skipped).

- **AC-2 — `FORCE=1` overrides the skip.**
  Given the same already-current state as AC1,
  When `install.sh` is run with `FORCE=1` in the environment,
  Then `npm install -g astramem-local` runs unconditionally, matching
  today's behavior.

- **AC-3 — Version mismatch always reinstalls.**
  Given `astramem-local` is either not installed, or installed at a version
  older than what `npm view astramem-local version` resolves to,
  When `install.sh` is run with no `FORCE` env var,
  Then `npm install -g astramem-local` runs (the skip in AC1 never
  false-positives on a real upgrade).

- **AC-4 — `/dev/tty` reattach keeps the wizard interactive when piped.**
  Given `install.sh` is invoked via a pipe (`curl -fsSL ... | bash`, i.e.
  stdin is not a tty) on a host that has a real controlling terminal
  available at `/dev/tty`,
  When the script reaches the init-wizard step,
  Then it re-attaches `/dev/tty` as stdin (e.g. `exec < /dev/tty`) and runs
  `astramem-local init "$@"` interactively instead of bailing out with the
  current "run `astramem-local init` yourself" message.

- **AC-5 — Graceful fallback when no `/dev/tty` exists.**
  Given `install.sh` is invoked in an environment with no controlling
  terminal at all (e.g. a CI runner with stdin fully detached, no
  `/dev/tty` device),
  When the `/dev/tty` reattach from AC4 is attempted,
  Then the reattach failure is caught and the script falls back to today's
  existing behavior (print "finish setup with `astramem-local init`" and
  exit 0) rather than hanging or erroring out.

### SLICE-2 — root/sudo handling, PATH guidance, config-dir perm hardening

- **AC-6 — Refuse to auto-start the daemon as root.**
  Given `install.sh` is being run as root (`$(id -u) -eq 0`),
  When the script reaches the point where it would otherwise `exec
  astramem-local init` (which can install/auto-start the OS service),
  Then it prints an explicit warning that running as root is unusual for
  this installer and that the service will run as root if started this way,
  and requires the same `FORCE=1`-style override (or a dedicated
  confirmation) before proceeding — it must not silently auto-start a
  root-owned daemon.

- **AC-7 — chown config/data back to the invoking user under sudo.**
  Given `install.sh` is invoked via `sudo` (i.e. running as root with
  `$SUDO_USER` set to a non-root invoking user),
  When the init wizard creates `defaultConfigDir()` / `defaultDataDir()`
  and writes `config.yaml` / `secrets.env` into them,
  Then those paths end up owned by `$SUDO_USER` (not root) after the script
  completes, so the invoking user can read/manage their own config without
  needing sudo again.

- **AC-8 — Config directory gets restrictive perms, not just secrets.env.**
  Given `defaultConfigDir()` is created fresh by `init`,
  When the directory is created,
  Then it is created with restrictive permissions (owner rwx, no
  group/other access — e.g. `0700`), matching the existing per-file
  guarantee on `secrets.env` (already `0600`, unchanged by this AC) rather
  than relying on the OS default umask for the directory itself.

- **AC-9 — PATH guidance prints a copy-pasteable line.**
  Given `astramem-local` was just installed globally but is not resolvable
  on `PATH` in the current shell,
  When `install.sh` detects this (the existing check at install.sh:60-64),
  Then, in addition to today's `npm config get prefix` hint, it prints a
  ready-to-paste shell-rc line for the detected shell (e.g. `export
  PATH="$(npm config get prefix)/bin:$PATH"` appended to the appropriate
  rc file name for `$SHELL`), so the user can copy one line instead of
  deriving it themselves.

- **AC-10 — No regression to non-root, non-sudo installs.**
  Given a normal (non-root, no `sudo`) install on a machine where the user
  already owns their home directory and npm global prefix,
  When `install.sh` runs end-to-end,
  Then AC6/AC7's root/sudo branches are never entered (no chown calls, no
  root warning printed), and the script's behavior is otherwise unchanged
  from today.

## Files

- `install.sh` — SLICE-1 (idempotency skip + `/dev/tty` reattach, install.sh:56-82) and SLICE-2 (root/sudo handling + PATH guidance, install.sh:60-64)
- `src/config/datadir.ts` — read-only reference for `defaultConfigDir()`/`defaultDataDir()` paths (SLICE-2, AC7/AC8); do not change its exported behavior, only how `init`/`install.sh` set perms on the paths it returns
- `src/cli/init.ts` — touch only if AC8's directory-perm enforcement is more naturally placed at directory-creation time inside `init` itself rather than in `install.sh`; do not touch the existing `NON_INTERACTIVE_ENV` map or non-interactive gating logic (already correct, out of scope per Non-goals)
- OFF LIMITS: `install.ps1` (Windows — non-goal, see above), `src/service/reinstall.ts` (different idempotency mechanism, already correct, do not add a parallel one), release/CI manifest-publish workflows (checksum-manifest pattern dropped as N/A)

## Slices

- **SLICE-1** — install.sh: idempotent skip-if-current-version (`FORCE=1` override) + `/dev/tty` interactive reattach. Covers AC1-AC5. ~3 pts. Independently shippable and testable without SLICE-2.
- **SLICE-2** — install.sh: root/sudo handling (chown-back, refuse-auto-start-as-root) + PATH guidance copy-paste line + config-dir perm hardening. Covers AC6-AC10. ~3 pts. Independently shippable; does not depend on SLICE-1 landing first (touches a different part of the same file — sequence for merge convenience, not for correctness).

## Proposed slices (PM decomposition)

- SLICE-1: install.sh idempotent skip-if-current-version (FORCE override) + /dev/tty interactive reattach (3 pts)
- SLICE-2: install.sh root/sudo handling + PATH guidance + config-dir perm hardening (3 pts)
