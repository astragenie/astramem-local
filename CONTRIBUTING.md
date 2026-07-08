# Contributing to AstraMemory Local

## Prerequisites

- Node.js **>= 20** (see `engines` in `package.json`).
- [Bun](https://bun.sh/) as the package manager and script runner.

## Build

```bash
bun install
bun run build        # compiles TypeScript -> dist/
```

## Test

```bash
bun run test         # runs the full vitest suite
```

`bun run test` includes the ADR-005 retrieval-eval gate
(`tests/eval/retrieval-eval.test.ts`), which enforces recall@10 ≥ 0.9 and NDCG@10 ≥ 0.7 floors
against a deterministic fake embedder on every run — a regression here fails the suite the same
as any other test. Other useful scripts:

```bash
bun run test:watch   # vitest in watch mode
bun run test:smoke   # smoke tests only (tests/smoke)
```

Tests run through vitest rather than Bun's own test runner because the suite depends on
`better-sqlite3`-family native bindings.

## Local development

```bash
node dist/cli/index.js serve --port 7777   # foreground daemon, no OS service
node dist/cli/index.js doctor              # health checks
```

See [README.md](README.md) for the full command reference and [docs/](docs/) for provider setup,
troubleshooting, backup/recovery, and the capture-protocol wire contract.

## Architecture and design docs

Architecture decisions are recorded as ADRs in [docs/adr/](docs/adr/) (e.g. canonical memory atom
shape, local storage engine, sync protocol, retrieval contract, feedback-learning loop). Read the
relevant ADR before proposing a change to an area it covers, and add a new ADR for decisions with
comparable scope.

## Commit conventions

This repo follows [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>

<body, optional>
```

Common types used in this repo's history: `feat`, `fix`, `refactor`, `chore`, `docs`. Scope is
typically the affected subsystem (e.g. `feat(search): ...`, `fix(ci): ...`, `feat(contracts): ...`).

## Pull requests

- Keep PRs scoped to one logical change.
- Add or update tests for changed behavior.
- Run `bun run build && bun run test` locally before opening a PR.
- If `package.json`'s `version` changes, the git tag must match it — this is enforced by
  `.github/workflows/version-tag-parity.yml` on tag pushes.

## Publishing (maintainers only)

```bash
bun run build
bun publish   # or: npm publish
```

Bump `package.json`'s `version` and push the matching tag in the same PR/release — see "Bump
discipline" in this repo's `CLAUDE.md`. Verify after publishing that the registry now serves the
new version; a stale published version can otherwise shadow the real package for anyone installing
it globally (see the npm-shadow note in `CLAUDE.md`'s install/onboarding section).
