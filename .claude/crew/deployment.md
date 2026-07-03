# Deployment Guidance: npm publish on version-tag push

- Updated: 2026-07-03T18:43:07.584Z
- Owner: lead-session
- Discovery Status: repo-derived
- Verified From:
  - .github/workflows/publish.yml
  - .github/workflows/version-tag-parity.yml
  - package.json
- Summary: Artifact is the npm package @astragenie/astramemory-local — no server/container deploy. Requires repo secret NPM_TOKEN (automation token, publish rights on @astragenie scope). Registry previously froze at 0.4.0 causing the SQLITE_NOTADB stale-global-install trap; every release tag now publishes to prevent recurrence. Local daemon install/upgrade is separate (node dist/cli/index.js reinstall) and not a CI concern.
- Build Path: bun install && bun run build (tsc); test: vitest run
- Deploy Path: Bump package.json.version in release PR, then: git tag vX.Y.Z && git push origin vX.Y.Z. publish.yml runs on 'v*' tags (GitHub-hosted ubuntu, npm --provenance) and publishes @astragenie/astramemory-local. Tag MUST equal package.json.version (gated by publish.yml + version-tag-parity.yml).
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

