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
