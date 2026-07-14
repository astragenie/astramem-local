# Runbook — cut a release & publish to npm

How to ship a new `astramem-local` version to npmjs. Package is public on
**npmjs.com as `astramem-local`** (owner account: `heroboec`). The old scoped
`@astragenie/astramemory-local` on GitHub Packages is stale — do not touch it.

## Prerequisite — npm token (no 2FA)

Publishing is authenticated by an **npm Automation token** stored in
`~/.npmrc` (Windows: `C:\Users\<you>\.npmrc`). This file is outside every repo
and is never committed — the token value lives ONLY there.

```
//registry.npmjs.org/:_authToken=npm_xxxxxxxx   # Automation type — bypasses 2FA
```

An **Automation** token is what makes `npm publish` work without a one-time
password. A plain Publish/Granular token will fail with `EOTP` on every publish.

Regenerate if lost/rotated: https://www.npmjs.com/settings/heroboec/tokens
→ **Generate New Token → Classic → Automation** → paste the `npm_...` value into
the `//registry.npmjs.org/:_authToken=` line of `~/.npmrc`. Verify with
`npm whoami` (must print `heroboec`).

## Release steps

1. **Land all PRs** for the release onto `main`; confirm `main` CI is green
   (Test, Lint, `bun audit`, cross-repo-roundtrip).
2. **Pull** `main` locally: `git pull --ff-only origin main`.
3. **Bump + changelog in ONE commit** (bump discipline — package.json version
   MUST equal the tag; `.github/workflows/version-tag-parity.yml` gates this on
   tag push):
   - `package.json` → new `version` (pre-1.0: bump minor for breaking changes).
   - `CHANGELOG.md` → new `## [X.Y.Z] — YYYY-MM-DD` section (Keep a Changelog).
   - `git commit -m "release: vX.Y.Z — <headline>"`
4. **Tag** the bump commit: `git tag -a vX.Y.Z -m "vX.Y.Z — <headline>"`.
5. **Push** commit then tag: `git push origin main && git push origin vX.Y.Z`.
6. **Publish**: `npm publish` (runs `prepublishOnly` → `bun run build` first).
   With the Automation token this needs **no OTP**.
   - Sanity-check first with `npm publish --dry-run` (shows tarball: `dist/`,
     `migrations/`, README, CHANGELOG, LICENSE).
7. **Verify**: `npm view astramem-local version` → should print the new version.

## Notes / gotchas

- `bun audit` occasionally fails on the self-hosted runner with
  `EACCES ... package.json` — that's a transient runner permission flake, not a
  vulnerability. Re-run the job; it clears.
- `contracts-vX.Y.Z` is a **separate** tag namespace for the contracts subpackage
  — not the daemon release tag.
- If `npm publish` prints `cannot publish over previously published versions`,
  the upload already succeeded — check `npm view astramem-local version`.
- Upgrade a live install after publish: see CLAUDE.md → `reinstall` flow.

## Audio add-on release

`astramem-audio` (`audio-addon/`) is a **third, independently-versioned** npm
package in this repo — FEAT-489 Slice B, packaging design pass decision 3
(`docs/research/2026-07-14-audio-addon-packaging.md`). Same subdirectory-
package pattern as `contracts/`, own tag namespace: **`audio-vX.Y.Z`**,
distinct from both `vX.Y.Z` (daemon, this file's steps above) and
`contracts-vX.Y.Z` (contracts subpackage). Unscoped name (`astramem-audio`,
not `@astragenie/...`) — matches the flagship package's own unscoped
`astramem-local` naming (the design doc left this open; resolved here).

Published by `.github/workflows/audio-publish.yml` on `audio-v*` tag push —
structurally a copy of `contracts-publish.yml`, `working-directory:
audio-addon`, same self-hosted fleet, same `NPM_TOKEN` secret.

**What gets bundled:** the package's `prepublishOnly` script runs
`node scripts/fetch-binaries.mjs --all` before `tsc` — downloads and
SHA256-verifies the pinned, CPU-only ggml-org/whisper.cpp CLI binary for
**every** v1-supported platform (win32-x64, linux-x64 — see
`audio-addon/src/binary-manifest.ts`) into `audio-addon/bin/`, which
`package.json`'s `files` array bundles into the published tarball.
`audio-addon/bin/` is gitignored; this script (run locally or by the
workflow) is the only thing that populates it — never a git commit.

1. **Land all PRs** for the release onto `main`; confirm `main` CI is green.
2. **Pull** `main` locally: `git pull --ff-only origin main`.
3. **Bump + changelog in ONE commit**:
   - `audio-addon/package.json` → new `version`.
   - `git commit -m "release(audio): astramem-audio vX.Y.Z — <headline>"`
4. **Tag**: `git tag -a audio-vX.Y.Z -m "audio-vX.Y.Z — <headline>"`.
5. **Push** commit then tag: `git push origin main && git push origin audio-vX.Y.Z`.
6. The workflow verifies the tag matches `audio-addon/package.json`'s
   `version`, fetches + checksum-verifies both platform binaries, builds,
   and runs `npm publish --access public`.
7. **Verify**: `npm view astramem-audio version` → should print the new
   version.

**Local dev / manual testing** (no publish): `bun run fetch-binaries` inside
`audio-addon/` fetches only the CURRENT platform's binary (not `--all`) —
faster for iterating locally. `bun run fetch-model` downloads the default
GGML model (`ggml-tiny.en.bin`) into this add-on's own cache dir
(`%LOCALAPPDATA%\astramem-audio\models` on Windows, see
`audio-addon/src/cache-dir.ts` for the other platforms), checksum-verified
against `audio-addon/src/model-manifest.ts`. Neither binaries nor models are
ever committed to this repo, same discipline as fixture audio.

- `audio-vX.Y.Z` and `contracts-vX.Y.Z` are two **separate** tag namespaces
  from two **separate** packages — do not conflate a bump to one with a bump
  to the other; they release independently.
