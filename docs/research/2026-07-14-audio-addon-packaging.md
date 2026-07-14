# FEAT-489 packaging design pass — whisper.cpp audio add-on

Design-only pass requested by FEAT-489's 2026-07-14 arch-review block, item (3): decide the
packaging shape for `astramem-audio` (or `@astragenie/astramem-audio` — see Decision 3) BEFORE
the build slice starts. No product code touched in this pass.

**Correction to the FEAT-489 arch-review note before anything else:** the note claims *"no
second-published-package precedent in this repo (no workspaces/optionalDependencies)"*. That's
wrong as of `main` today — `contracts/` is already a second, independently-versioned,
independently-tagged npm package (`@astragenie/astramem-contracts`, `contracts/package.json:2`),
published by `.github/workflows/contracts-publish.yml` on a `contracts-v*` tag push, distinct
from the daemon's own `v*` tag scheme (`docs/runbooks/release-publish.md:49-50`). This pass
reuses that pattern rather than inventing one. Worth flagging on its own: this is the same class
of drift as the cloud repo's "no sync bridge" mistake — a stale claim written into a spec,
uncontested, that would have sent the build slice into unnecessary from-scratch design work.

---

## 1. Add-on presence probe

**Decision:** dynamic `await import('astramem-audio')` inside a try/catch, called lazily only
when `audio.mode !== 'off'` AND the transcribe handler actually runs (or a doctor check runs) —
never at module load time / daemon boot.

**Why:** this is not a new pattern — `src/doctor/checks/sqlite-vec.ts:11-12` and
`src/doctor/checks/fts5.ts:11` already do exactly this for `better-sqlite3-multiple-ciphers` and
`sqlite-vec`: `const { default: Database } = await import('better-sqlite3-multiple-ciphers')`
wrapped in a check's try/catch, only evaluated when the check runs. The transcribe handler and a
new `src/doctor/checks/audio-addon.ts` both follow the same shape.

**Error surface (per FEAT acceptance hints — never a crash):**
- Doctor check: WARN when `audio.mode !== 'off'` and the import fails —
  `"audio add-on not installed — run npm install astramem-audio"` — same message style as
  existing checks under `src/doctor/checks/`.
- Pipeline handler (`src/pipeline/handlers/transcribe.ts`): same try/catch, failure surfaces
  through the handler's normal job-failure error contract (not an unhandled throw) with message
  `"astramem-audio add-on not installed; audio.mode is '<mode>' but the package is absent"`.

**Rejected alternatives:**
- `optionalDependencies` in base `package.json` + runtime `undefined` check — rejected. The base
  package's `trustedDependencies` allowlist (`package.json:54-57`) exists because Bun blocks
  lifecycle scripts by default; an add-on that needs a native/postinstall step behaves
  unpredictably as an `optionalDependencies` entry (silent install-skip vs. actual install-failed
  are indistinguishable without extra plumbing), and it couples the add-on's install lifecycle to
  the base package's install lifecycle, which works against "keeps base install light."
- `require.resolve` sync check — rejected. Base package is pure ESM (`"type": "module"`,
  `package.json:17`); no `require` without extra shims.
- Static top-level `import` (even type-only) of the add-on from a pipeline module that's always
  loaded — rejected. Forces resolution attempts at daemon boot regardless of `audio.mode`,
  defeating "keeps base install light" and turning an absent add-on into a boot-time concern
  instead of a call-time concern.

---

## 2. Base ↔ add-on version compatibility

**Decision:** runtime API-version handshake, not a semver-range check. The add-on exports an
integer constant, e.g. `ASTRAMEM_AUDIO_ADDON_API_VERSION`, bumped only on breaking changes to the
base↔add-on call contract (function signatures, expected transcript segment shape). The base
checks this constant against a small `SUPPORTED_ADDON_API_VERSIONS` set at the same call site as
the presence probe (Decision 1). Mismatch produces a distinct message from "not installed" —
`"astramem-audio installed but API version <N> unsupported (expected <M>) — reinstall a matching
version"`.

This mirrors the reasoning `contracts-publish.yml:24-36` already documents for why the contracts
package's tag namespace is separate from the daemon's: package semver and wire-contract version
are different axes, and a package minor/patch bump does not imply a compatibility bump. A plain
`npm ls`-style read of the installed add-on's `package.json.version` at runtime would conflate
those two axes again.

**package.json wiring:** the base package declares the add-on NOWHERE in its own
`package.json` (no `peerDependencies`, no `optionalDependencies`) — this is what makes
`npm install astramem-audio` untouched by a plain `npm install astramem-local`, which is the
literal ask ("keeps base install light"). The add-on's own `package.json` MAY declare
`peerDependencies: { "astramem-local": ">=X.Y.Z" }` with
`peerDependenciesMeta["astramem-local"].optional: true` purely as an npm-warn documentation
signal (mirrors `contracts/package.json:16-20`'s optional `zod` peerDependency) — but this is
advisory only; the runtime gate is the version-constant handshake above, not npm's peer
resolution.

**Rejected:** semver range check against the installed add-on's on-disk `package.json.version` —
rejected as more fragile (reads a file across a package boundary at runtime, breaks under
non-standard install layouts) and less precise (semver ranges don't express "breaking API
version" as directly as an explicit integer comparison) than the handshake constant.

---

## 3. Publish pipeline

**Decision:** extend the `contracts/` pattern directly — a plain subdirectory package, not a
workspace, published by its own dedicated workflow on its own tag namespace.

- New top-level directory `audio-addon/` with its own `package.json`, mirroring
  `contracts/package.json`'s shape (own `name`, `version`, `files[]`, `publishConfig`).
  **Not** `packages/audio` — no bun/npm workspaces exist anywhere in this repo today
  (`package.json` has no `workspaces` key), and introducing them now is a root-`package.json` +
  lockfile-format + CI-install-step change for the whole repo, far outside what one add-on needs.
  `contracts/` already proves a bare subdirectory + `defaults.run.working-directory:` in a
  dedicated workflow achieves the same isolation with none of that blast radius.
- Tag namespace: `audio-vX.Y.Z`, distinct from both `v*` (daemon) and `contracts-v*`
  (contracts package) — new `.github/workflows/audio-publish.yml`, structurally a copy of
  `contracts-publish.yml`: tag-triggered, `working-directory: audio-addon`, a
  "tag matches `audio-addon/package.json` version" gate (same shape as
  `contracts-publish.yml:73-80`), same self-hosted fleet label, same `NPM_TOKEN` secret (no new
  token needed — `contracts-publish.yml` already proves this secret has publish rights on the
  target scope/registry).
- Runbook: append a new `## Audio add-on release` section to
  `docs/runbooks/release-publish.md` (append, don't rewrite) covering the same 7 steps scoped to
  `audio-addon/`, explicitly noting the `audio-v*` tag is independent of `v*` and `contracts-v*`
  and must not be conflated with either.

**Open question — package name (unscoped vs. scoped):** the FEAT-489 description assumes
`@astragenie/astramem-audio`, but the base package's *actual* published name is the **unscoped**
`astramem-local` on npmjs.org under owner `heroboec` (`docs/runbooks/release-publish.md:3-5`,
`package.json:2`) — the scoped `@astragenie/astramemory-local` is explicitly called out as stale
GitHub Packages history in that same runbook. `contracts/` chose to scope
(`@astragenie/astramem-contracts`) when it published in 2026-07-06ish, so there's a real, live
split in this repo's own naming today: unscoped for the flagship package, scoped for the
secondary one. This doc does not resolve it — flagging as genuinely open, thin evidence either
way, decide at build-slice kickoff.

**Rejected alternatives:**
- npm/bun workspaces — rejected, see above (repo-wide structural change vs. one add-on's need).
- Separate GitHub repo — rejected. Adds cross-repo release coordination (branch protection,
  secrets, CI setup) the FEAT itself frames as premature ("creates the future paid-add-on seam,"
  not urgent today), and `contracts/` already proves external consumers (cloud, plugin repos)
  install a subdirectory-published package with zero awareness it lives inside astramem-local's
  tree — the repo-split benefit workspaces/separate-repo would buy is already achieved.

---

## 4. whisper.cpp distribution

**Decision:** prebuilt binaries per platform (win-x64, mac-arm64, mac-x64, linux-x64 at minimum),
compiled CPU-only, not a build-from-source-only postinstall step.

**CPU-only is a pinned constraint, not a preference — this is the load-bearing part of this
decision.** `src/doctor/gpu-checks.ts:1-24` documents a full night lost to a GPU/VRAM failure
class: an orphaned process holding GPU memory that Ollama then can't see, presenting as "this
model is slow" with zero diagnostic signal. A whisper.cpp binary built with CUDA/Metal/ROCm
support, sitting on a machine that also runs Ollama for distill, is the *exact same trap* with a
different process name. Recommendation: never publish a GPU-capable binary in v1 — build only
with GPU backends compiled out at the CMake level, full stop, no runtime flag to opt into GPU.
Whisper.cpp on CPU is explicitly fine for the target use case (file ingest, not live/latency
sensitive — FEAT-489 notes text confirms this).

**Native module trust:** `package.json:54-57`'s `trustedDependencies` list
(`@napi-rs/keyring`, `better-sqlite3-multiple-ciphers`) only governs packages inside the BASE
package's own dependency tree. Since the add-on is a separate install the user opts into, the
add-on's OWN `package.json` needs its own `trustedDependencies` entry for whatever whisper.cpp
binding it wraps, following the same allowlist convention — exact binding package (vendored
binding vs. an existing npm wrapper) is a build-slice decision, not this pass's.

Worth noting `better-sqlite3-multiple-ciphers` itself is "prebuilt with source-build fallback,"
not source-build-only — so prebuilt-first is already this repo's working pattern for native
deps, not a new one.

**Model download UX:** on first use, not on add-on install — reuse the existing confirm-gate
pattern in `src/cli/init.ts` (`confirmOllamaDownload()` at line 388,
`confirmMissingBinary()` at line 453) rather than inventing a second one. Show model size before
download, checksum-verify (SHA256 against a pinned manifest) after — same spirit as
`src/doctor/checks/schema-drift.ts`'s guard against silently-stale generated artifacts.

**Rejected:** build-from-source-only via `trustedDependencies` postinstall — rejected as the v1
default. Multiplies first-run latency and failure surface (requires a compiler toolchain on the
user's machine) for no benefit over prebuilt binaries; no workflow in `.github/workflows/`
currently sets up a C/C++ build toolchain (cmake/gcc), so a source-build CI step would be new
infrastructure this pass hasn't verified the self-hosted fleet supports — flagged as an
assumption to confirm before the build slice commits to prebuilt-binary CI, not verified here.

---

## 5. Config surface sketch

**Decision:** a single `mode` enum, not the `enabled: boolean` + separate dry-run flag the FEAT
description's prose loosely suggests. This follows the repo's own stated convention more
literally than the FEAT text does: `src/config/config.ts:339-357` (contradiction detection) and
`:390-399` (`distill.durabilityGate`) both use one `mode` string enum specifically to avoid "the
ambiguous `enabled:false, dryRun:true` combination" (direct quote, `config.ts:349-350`). The
FEAT's arch-review note itself calls out durabilityGate's 3-state enum as the precedent to
follow — so collapsing "enabled: false default, dry-run mode first" into one enum is the
convention-compliant reading of that same note, not a deviation from it.

```ts
audio: {
  /** 'off' (default) — BYTE-IDENTICAL to no audio support: transcribe handler
   *  never invoked, add-on never imported. 'dry-run' — handler runs, produces
   *  transcript + distill preview, does not persist memories (mirrors the
   *  contradictionDetection 'dry-run' semantics: safe-rollout mode, no writes).
   *  'enabled' — full pipeline, memories persisted. Opt-in only until eval'd,
   *  same caveat every other mode-enum field here carries — do not flip the
   *  default casually. */
  mode: 'off' | 'dry-run' | 'enabled';
  /** Optional override for the downloaded whisper.cpp model path; unset uses
   *  the add-on's default download location. */
  modelPath?: string;
}
```

Exact model-size knob (tiny/base/small/...) and whether "dry-run" persists the transcript but not
the distilled memory, or persists neither, is build-slice-level detail — this sketch fixes the
shape (one enum, not two booleans) and the default (`'off'`), not the full schema.

---

## Summary — decisions at a glance

| # | Decision | One-liner |
|---|---|---|
| 1 | Presence probe | Lazy `await import('astramem-audio')` in try/catch, matching `doctor/checks/sqlite-vec.ts` — never at boot. |
| 2 | Version compat | Runtime integer API-version handshake constant, not semver-range reads across the package boundary. |
| 3 | Publish pipeline | Reuse the existing `contracts/` subdirectory-package pattern (it already exists — arch-review note was wrong); new `audio-v*` tag namespace. Package name (scoped vs. unscoped) is open. |
| 4 | whisper.cpp distribution | Prebuilt, CPU-only compiled (pinned, not preferred) per-platform binaries; model download deferred to first use via the existing `init.ts` confirm-gate pattern. |
| 5 | Config surface | Single `audio.mode: 'off' \| 'dry-run' \| 'enabled'` enum, default `'off'` — not a separate `enabled` boolean, per the repo's own stated mode-enum convention. |

## Open questions for the build slice

- Package name: `astramem-audio` (unscoped, matching the flagship package's real name) vs.
  `@astragenie/astramem-audio` (matching `contracts/`'s scoped choice) — genuinely undecided here.
- Exact whisper.cpp Node binding to wrap (vendor vs. existing npm package) — determines the
  `trustedDependencies` entry and whether prebuilt binaries are this add-on's own CI artifact or
  inherited from an upstream binding's release.
- Whether the self-hosted `[self-hosted, astragenie, aws]` fleet can host a cross-compile step for
  multi-platform prebuilt binaries, or whether that needs GitHub-hosted runners per target OS
  (this repo's CI is otherwise self-hosted-only by fleet policy per
  `docs/research/2026-07-09-packaging-audit.md` N6 — worth re-checking before committing to a
  build matrix).
