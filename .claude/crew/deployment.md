# Deployment Guidance: npm publish on version-tag push

- Updated: 2026-07-12T21:20:00.000Z
- Owner: lead-session
- Discovery Status: repo-derived
- dev.stable: true

## dev.stable — what it unlocks (set 2026-07-12 by operator)

The lead and builder MAY create LOCAL commits without asking per-edit, provided
every constitution gate holds: the change came from a `/crew:build`, `/crew:fix`,
or autonomous-loop `slice-build` flow that reached synthesis; the latest review
artifact is PASS (or `review_skipped` with a reason); the latest validation
artifact is PASS (or `validation_skipped` with a reason); and no `help_request`
badge is open.

NEVER unlocked by this flag, regardless of gates — these ALWAYS require explicit
operator approval:
- `npm publish` / any registry publish
- release tag pushes (a `v*` tag push AUTO-PUBLISHES via publish.yml — treat a
  tag push as a production release, not a commit)
- force-pushes
- production promotion

A session-level "do not commit" from the operator always beats this flag.
- Verified From:
  - .github/workflows/publish.yml
  - .github/workflows/version-tag-parity.yml
  - package.json
- Summary: Artifact is the npm package **`astramem-local`** on npmjs (owner account `heroboec`; first published 2026-07-08 as v0.9.0) — no server/container deploy. CORRECTION 2026-07-12: this file previously named `@astragenie/astramemory-local`, which is the OLD, STALE 0.4.0 package on GitHub Packages — plain better-sqlite3, throws SQLITE_NOTADB on encrypted DBs. Never install or publish that one. Requires repo secret NPM_TOKEN (an npm **Automation** token — Automation-type bypasses 2FA, so publish needs no OTP; a Publish/Granular token fails with EOTP). Local daemon install/upgrade is separate (`node dist/cli/index.js reinstall`) and not a CI concern.
- Build Path: bun install && bun run build (tsc); test: vitest run
- Deploy Path: Bump package.json.version in the release PR, then: git tag vX.Y.Z && git push origin vX.Y.Z. publish.yml runs on 'v*' tags (GitHub-hosted ubuntu, npm --provenance) and publishes `astramem-local`. Tag MUST equal package.json.version (gated by publish.yml + version-tag-parity.yml). **The tag push IS the release — CI publishes automatically. Do NOT run a manual `npm publish` afterward; it collides with CI's (2026-07-12 lesson).** Runbook: docs/runbooks/release-publish.md.
- Environments: -
- Logs: -
- Metrics: -
- Alerts / Incidents: -
- Telemetry / Events: -
- Source Clues:
  - .github/dependabot.yml
  - .github/workflows/audit.yml
  - .github/workflows/lint.yml
  - .github/workflows/publish.yml
  - .github/workflows/test-xplat.yml
  - .github/workflows/test.yml
  - .github/workflows/version-tag-parity.yml
- Still Missing:
  - NPM_TOKEN secret presence not verified live; actual publish provenance run not confirmed this session
- Refresh When: -

