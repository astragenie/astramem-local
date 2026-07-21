# astramem-local — Agent Instructions

Local-first, encrypted memory daemon for AI coding agents — hybrid retrieval (BM25 + vector +
importance + freshness), provenance receipts, MCP tools, SQLCipher at rest. TypeScript + Node 20+
+ Fastify + better-sqlite3 + sqlite-vec. Wire-compatible with astramem-plugin and the memory SaaS
backend. Full mission, architecture, and decisions: `CLAUDE.md`.

## Commands

Setup:

```bash
bun install
bun run build          # tsc -p . -> dist/
```

Local dev (foreground, no OS service):

```bash
node dist/cli/index.js init                  # wizard: config.yaml + secrets.env, migrations, service, doctor
node dist/cli/index.js serve --port 7777     # foreground daemon
node dist/cli/index.js doctor                # health checks
node dist/cli/index.js demo                  # 30s in-memory trial, seeded data, no Ollama required
```

Test:

```bash
bun run test           # vitest run - includes the ADR-005 retrieval-eval gate (recall@10 >= 0.9, NDCG@10 >= 0.7)
bun run test:watch
bun run test:smoke      # tests/smoke only
bun run test:soak       # vitest.soak.config.ts
```

Contracts (wire-schema parity with the SaaS backend + astramem-plugin):

```bash
bun run contracts:generate    # types + zod from contracts/schemas
bun run contracts:validate    # node contracts/validate.mjs
```

Eval harnesses — **read `docs/eval-runs/README.md` before quoting any number**, every scored run
must be archived there:

```bash
bun run eval:locomo:sample / :run / :judge / :diagnose
bun run eval:longmemeval:sample / :smoke / :judge
bun run eval:extraction-bench
bun run perf:baseline
```

## Structure

```
src/{audio,backup,budget,capture,cli,config,consolidate,contracts,distill,doctor,entity,
     eval,ingest,log,mcp,memory-tool,pipeline,providers,proxy,recall,redact,search,
     server,service,storage,sync,tag-hygiene,util,vector}/
contracts/            wire-schema source of truth - own package (generate-types/generate-zod/validate)
audio-addon/           astramem-audio - independently-versioned npm subpackage (FEAT-489 Slice B)
migrations/            sequential .sql files; embed dim + schema are single-sourced (see CLAUDE.md)
tests/                 mirrors src/ layout + e2e, integration, smoke, soak, security
docs/                  see docs/README.md for the full map
scripts/{eval,git-hooks,perf,spike,testbed}/   plus loose one-off scripts (gen-upgrade-fixture.mts, watch-daemon.ps1)
```

## Style

- TypeScript strict mode (`tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, ES2022, ESM/Bundler
  resolution). No `.editorconfig`/eslint config in this repo — match the surrounding file's
  conventions (2-space indent throughout `src/`).
- Tests run through vitest, not Bun's own runner — the suite depends on `better-sqlite3`-family
  native bindings.
- [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <summary>` — see
  `CONTRIBUTING.md` for the full convention and PR checklist.

## Credentials

- Bearer token + DB encryption key: OS credential store first (Windows Credential Manager / macOS
  Keychain / Linux libsecret via `@napi-rs/keyring`), `secrets.env` (mode `0600`) fallback only.
- npm publish auth: an **Automation**-type token in `~/.npmrc` (outside every repo, never
  committed) — see `docs/runbooks/release-publish.md`.
- CI publish: repo secret `NPM_TOKEN` (Automation token) consumed by
  `.github/workflows/publish.yml` on a `v*` tag push.
- Never hand-craft `config.yaml` — the `init` wizard is the installer.

## Memory + coordination

- **Before non-trivial work, read `docs/memory.md`** — the durable-facts index (dated corrections,
  eval-run current numbers, known open gaps, closed incidents). None of that lives in `CLAUDE.md`
  by design.
- **Update `docs/memory.md` in the same session** when you verify or change a fact it tracks:
  supersede the entry in place, refresh its date.
- Cross-repo dependency (astramem-plugin wire compat, memory SaaS backend) goes through a GitHub
  issue **in the target repo**, referenced as `owner/repo#N`.

## Never-do

- Do NOT spread `options` twice into an Ollama request body — the second spread silently replaces
  the first, dropping `temperature`/`num_predict`. Build ONE `options` object.
- Do NOT hardcode `num_ctx` — it is sized per call (`src/providers/llm/ollama.ts`); a fixed value
  that fits today's prompt silently truncates tomorrow's.
- Do NOT kill processes machine-wide by image name (`taskkill /F /IM node.exe`, `Stop-Process -Name
  node`) — this box runs the production daemon, eval shard daemons, Ollama, and sibling agents'
  processes. Kill only PIDs you spawned.
- Do NOT `git stash` inside worktrees — the stash stack is repo-global across all worktrees; use
  `git diff > x.patch` + `git checkout` + `git apply` instead.
- Do NOT hand-edit `memories_vec FLOAT[N]` in a migration file directly — the dim is
  single-sourced from `DEFAULT_EMBED_DIM` (`src/contracts/embed.ts`); migrating an *existing* DB
  needs `astramem-local reembed-dim` (migration 011), not an ALTER.
- Do NOT construct a month-arithmetic `Date` via `setUTCMonth`/`setMonth` on a `Date` still
  carrying the anchor's day-of-month — it silently overflows in short months. Use
  `new Date(Date.UTC(year, month, 1))` when only month/year granularity is needed.
- During a `git rebase`, `--ours` is the UPSTREAM side (the inverse of a normal merge) — never
  resolve a conflict by side-name, read the markers.
- Do NOT commit `secrets.env` or the SQLite file — both `.gitignore`d.
